// Outlook calendars through Microsoft Graph, read-only. Uses the same app
// registration as mailer.js (see graph.js); it needs the Calendars.Read
// application permission with admin consent.
//
// - eventsBetween(): a person's own events, for the Personal calendar. The
//   mailbox is always the email stored on the signed-in person's login —
//   never one sent by the browser — so people only see their own calendar.
// - whosIn(): Leadership's "Who's in office" board. For each person it reads
//   only Out of office / Working elsewhere time from their own calendar, plus
//   matching entries on the HR calendar mailbox, and returns a status per
//   weekday. Event titles and details never leave the server.

const { graphConfigured, getAccessToken } = require("./graph");

// Office time zone for "which day is this", in Windows or IANA form.
const OFFICE_TZ = process.env.OFFICE_TIMEZONE || "Pacific Standard Time";

const CACHE_MS = 2 * 60 * 1000;
const WHOS_IN_CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { at, value }

/** A user-safe reason the calendar can't be shown. */
class CalendarError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cached(key, ms, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = load().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}

function requireGraph() {
  if (!graphConfigured) {
    throw new CalendarError("not_configured", "Microsoft 365 isn't connected to the tracker yet (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET).");
  }
}

async function graphGet(url, headers) {
  const token = await getAccessToken();
  const res = await fetch(url, { headers: Object.assign({ Authorization: `Bearer ${token}` }, headers || {}) });
  if (res.status === 403 || res.status === 401) {
    throw new CalendarError("no_permission", "The tracker's Microsoft app doesn't have permission to read calendars yet. Your Microsoft 365 admin needs to add Calendars.Read — see the README.");
  }
  if (res.status === 404) {
    throw new CalendarError("not_found", "No Microsoft 365 mailbox or calendar was found for that address.");
  }
  if (!res.ok) {
    const text = await res.text();
    console.error(`Graph calendar request failed (${res.status}): ${text.slice(0, 300)}`);
    throw new CalendarError("error", "Microsoft 365 didn't return the calendar. Try again in a minute.");
  }
  return res.json();
}

/**
 * Raw calendarView events for a mailbox (optionally a named calendar in it),
 * following paging up to 500 events. With `tz`, times come back in that
 * time zone; without it, in UTC.
 */
async function calendarView(mailbox, startIso, endIso, opts) {
  opts = opts || {};
  const base = opts.calendarId
    ? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/calendars/${encodeURIComponent(opts.calendarId)}/calendarView`
    : `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/calendarView`;
  const url = new URL(base);
  url.searchParams.set("startDateTime", startIso);
  url.searchParams.set("endDateTime", endIso);
  url.searchParams.set("$select", opts.select || "subject,start,end,location,isAllDay,isCancelled,showAs,webLink,organizer,isOnlineMeeting,onlineMeeting");
  url.searchParams.set("$orderby", "start/dateTime");
  url.searchParams.set("$top", "100");
  const headers = opts.tz ? { Prefer: `outlook.timezone="${opts.tz}"` } : null;
  let next = url.toString();
  const out = [];
  while (next && out.length < 500) {
    const page = await graphGet(next, headers);
    out.push(...(page.value || []));
    next = page["@odata.nextLink"] || null;
  }
  return out.filter((e) => !e.isCancelled);
}

// ---------- Personal calendar ----------

/**
 * A person's own events from `startDate` (YYYY-MM-DD, default today) for
 * `days` days. Times are UTC ("Z"); the browser shows them in local time.
 */
async function eventsBetween(email, startDate, days) {
  requireGraph();
  if (!email) {
    throw new CalendarError("no_email", "Your login has no email address. Ask an admin to add your Microsoft 365 email at /admin.html.");
  }
  const start = startDate ? new Date(`${startDate}T00:00:00Z`) : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  // A day of slack either side so local-time days at the edges are complete.
  const from = new Date(start.getTime() - 24 * 3600 * 1000);
  const to = new Date(start.getTime() + (days + 1) * 24 * 3600 * 1000);
  const key = `me|${email.toLowerCase()}|${from.toISOString()}|${days}`;
  return cached(key, CACHE_MS, async () => {
    let raw;
    try {
      raw = await calendarView(email, from.toISOString(), to.toISOString());
    } catch (err) {
      if (err.code === "not_found") {
        throw new CalendarError("not_found", `No Microsoft 365 mailbox was found for ${email}. Check the email on your login at /admin.html.`);
      }
      throw err;
    }
    const events = raw.map((e) => ({
      subject: e.subject || "(No title)",
      // Graph returns UTC without a "Z"; add it so browsers read it as UTC.
      start: e.isAllDay ? e.start.dateTime.slice(0, 10) : `${e.start.dateTime.replace(/\.\d+$/, "")}Z`,
      end: e.isAllDay ? e.end.dateTime.slice(0, 10) : `${e.end.dateTime.replace(/\.\d+$/, "")}Z`,
      allDay: !!e.isAllDay,
      location: (e.location && e.location.displayName) || "",
      showAs: e.showAs || "",
      organizer: (e.organizer && e.organizer.emailAddress && e.organizer.emailAddress.name) || "",
      online: !!e.isOnlineMeeting,
      joinUrl: (e.onlineMeeting && e.onlineMeeting.joinUrl) || "",
      webLink: e.webLink || "",
    }));
    return { events, from: from.toISOString(), to: to.toISOString() };
  });
}

// Kept for the original "next N days" call.
function upcomingEvents(email, days) {
  return eventsBetween(email, null, days);
}

// ---------- Who's in office ----------

const OUT_WORDS = /\b(pto|vacation|holiday|out|off|leave|sick|travel(?:ing|ling)?|ooo|trip|away|absent|bereavement|jury)\b/i;
const REMOTE_WORDS = /\b(remote|wfh|work(?:ing)? from home|home office|working elsewhere)\b/i;

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday on or before a YYYY-MM-DD date. */
function mondayOf(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
  return addDays(ymd, -dow);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * How an event (local office times, "YYYY-MM-DDTHH:MM:SS") touches a day:
 * null, { full: true }, or { from, to } for part of the day.
 */
function overlap(e, day) {
  const dayStart = `${day}T00:00:00`;
  const dayEnd = `${addDays(day, 1)}T00:00:00`;
  const s = e.start.dateTime.slice(0, 19);
  const en = e.end.dateTime.slice(0, 19);
  if (!(s < dayEnd && en > dayStart)) return null;
  if (e.isAllDay) return { full: true };
  const from = s > dayStart ? s : dayStart;
  const to = en < dayEnd ? en : dayEnd;
  const hours = (Date.parse(`${to}Z`) - Date.parse(`${from}Z`)) / 3600000;
  if (hours >= 6) return { full: true };
  return { from: from.slice(11, 16), to: to.slice(11, 16) };
}

function hm(t) {
  const [h, m] = t.split(":").map(Number);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? " AM" : " PM"}`;
}

/** Combine marks for one day into a single status. Out beats remote. */
function dayStatus(marks) {
  if (!marks.length) return { status: "in" };
  const outs = marks.filter((m) => m.kind === "out");
  const pick = outs.length ? outs : marks;
  const kind = pick[0].kind;
  const full = pick.some((m) => m.full);
  const sources = [...new Set(marks.map((m) => m.source))];
  if (full) return { status: kind, sources };
  const parts = pick.filter((m) => !m.full).map((m) => `${hm(m.from)}–${hm(m.to)}`);
  return { status: kind, partial: true, note: parts.join(", "), sources };
}

async function hrCalendarId(mailbox, name) {
  if (!name) return null;
  return cached(`hrcal|${mailbox.toLowerCase()}|${name.toLowerCase()}`, 60 * 60 * 1000, async () => {
    const data = await graphGet(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/calendars?$select=id,name&$top=100`);
    const hit = (data.value || []).find((c) => String(c.name).toLowerCase() === name.toLowerCase());
    if (!hit) throw new CalendarError("not_found", `No calendar called "${name}" in ${mailbox}.`);
    return hit.id;
  });
}

/** Run `fn` over `items`, at most `limit` at a time. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Status per person per weekday (Mon–Fri) for the week containing `date`.
 * people: [{ username, email, calendarNames: [] }]
 * hr: { mailbox, calendarName } or null
 */
async function whosIn(people, hr, date) {
  requireGraph();
  const monday = mondayOf(date);
  const days = [0, 1, 2, 3, 4].map((n) => addDays(monday, n));
  // UTC window with a day of slack; days are then read in office time.
  const startIso = `${addDays(monday, -1)}T00:00:00Z`;
  const endIso = `${addDays(monday, 6)}T00:00:00Z`;
  const opts = { tz: OFFICE_TZ, select: "subject,start,end,isAllDay,isCancelled,showAs" };

  const marks = new Map(); // username -> day -> [mark]
  const errors = {}; // username -> message
  const add = (username, day, mark) => {
    if (!marks.has(username)) marks.set(username, {});
    const m = marks.get(username);
    (m[day] = m[day] || []).push(mark);
  };

  // 1. Each person's own calendar: Out of office / Working elsewhere only.
  await pool(people, 5, async (p) => {
    if (!p.email) {
      errors[p.username] = "No email on this login";
      return;
    }
    try {
      const events = await cached(`own|${p.email.toLowerCase()}|${monday}`, WHOS_IN_CACHE_MS, () => calendarView(p.email, startIso, endIso, opts));
      for (const e of events) {
        const kind = e.showAs === "oof" ? "out" : e.showAs === "workingElsewhere" ? "remote" : null;
        if (!kind) continue;
        for (const day of days) {
          const o = overlap(e, day);
          if (o) add(p.username, day, Object.assign({ kind, source: "own" }, o));
        }
      }
    } catch (err) {
      errors[p.username] = !(err instanceof CalendarError) ? "Couldn't read their calendar"
        : err.code === "not_found" ? "No Microsoft 365 mailbox for this email"
        : err.code === "no_permission" ? "Tracker can't read their calendar (permission)"
        : "Couldn't read their calendar";
    }
  });

  // 2. The HR calendar: entries whose title names a person and says they're out or remote.
  let hrError = null;
  if (hr && hr.mailbox) {
    try {
      const calendarId = await hrCalendarId(hr.mailbox, hr.calendarName);
      const events = await cached(`hr|${hr.mailbox.toLowerCase()}|${calendarId || ""}|${monday}`, WHOS_IN_CACHE_MS,
        () => calendarView(hr.mailbox, startIso, endIso, Object.assign({ calendarId }, opts)));
      const matchers = people.map((p) => {
        const names = [p.username, p.email ? p.email.split("@")[0] : "", ...(p.calendarNames || [])]
          .map((n) => String(n || "").trim()).filter((n) => n.length >= 2);
        return { p, re: names.length ? new RegExp(`\\b(${names.map(escapeRe).join("|")})\\b`, "i") : null };
      });
      for (const e of events) {
        const subject = e.subject || "";
        const kind = REMOTE_WORDS.test(subject) ? "remote" : OUT_WORDS.test(subject) ? "out" : null;
        if (!kind) continue;
        for (const { p, re } of matchers) {
          if (!re || !re.test(subject)) continue;
          for (const day of days) {
            const o = overlap(e, day);
            if (o) add(p.username, day, Object.assign({ kind, source: "hr" }, o));
          }
        }
      }
    } catch (err) {
      hrError = err instanceof CalendarError ? `HR calendar: ${err.message}` : "Couldn't read the HR calendar";
    }
  }

  return {
    week: monday,
    days,
    timeZone: OFFICE_TZ,
    hrConnected: !!(hr && hr.mailbox) && !hrError,
    hrError,
    people: people.map((p) => ({
      username: p.username,
      error: errors[p.username] || null,
      days: Object.fromEntries(days.map((d) => [d, dayStatus(((marks.get(p.username) || {})[d]) || [])])),
    })),
  };
}

module.exports = { upcomingEvents, eventsBetween, whosIn, mondayOf, CalendarError };

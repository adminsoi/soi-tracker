// The HR global calendar, read from its Outlook "Publish to web" ICS feed.
//
// Outlook gives a published calendar two links: HTML (a page to look at) and
// ICS (a feed of its entries). The ICS link lets the tracker show the HR
// calendar in its own List / Month layout and fill in "Who's in office" from
// entries like "Greg – PTO", with no extra Microsoft permission. The ICS link
// stays on the server; the browser only ever gets the events.
//
// The calendar must be published with titles ("Can view titles and
// locations" or "Can view all details"); "Can view when I'm busy" has no
// titles, so names can't be matched.

const ICAL = require("ical.js");
const IcalExpander = require("ical-expander");

const FEED_CACHE_MS = 5 * 60 * 1000;
const MAX_FEED_BYTES = 10 * 1024 * 1024;
let feedCache = { url: "", at: 0, expander: null, error: null };

class FeedError extends Error {
  constructor(message) {
    super(message);
    this.code = "feed";
  }
}

// Outlook names zones the Windows way ("Pacific Standard Time") and puts the
// definition in the feed. Register those definitions so times aren't read as
// UTC, plus a mapping for the usual US zones in case a definition is missing.
const WINDOWS_TO_IANA = {
  "Pacific Standard Time": "America/Los_Angeles",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Central Standard Time": "America/Chicago",
  "Eastern Standard Time": "America/New_York",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "GMT Standard Time": "Europe/London",
  "UTC": "UTC",
};

function registerFeedTimezones(ics) {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const vtz of root.getAllSubcomponents("vtimezone")) {
    const tzid = vtz.getFirstPropertyValue("tzid");
    if (tzid && !ICAL.TimezoneService.has(tzid)) {
      ICAL.TimezoneService.register(tzid, new ICAL.Timezone(vtz));
    }
  }
  for (const [win, iana] of Object.entries(WINDOWS_TO_IANA)) {
    if (!ICAL.TimezoneService.has(win) && ICAL.TimezoneService.has(iana)) {
      ICAL.TimezoneService.register(win, ICAL.TimezoneService.get(iana));
    }
  }
}

/** Only Outlook's published-calendar ICS links. */
function cleanFeedUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch (e) {
    throw new Error("That isn't a valid link");
  }
  const okHost = ["outlook.office365.com", "outlook.office.com", "outlook.live.com"].includes(url.hostname);
  if (url.protocol !== "https:" || !okHost) {
    throw new Error("Use the Outlook \"Publish to web\" ICS link (it starts with https://outlook.office365.com/)");
  }
  if (!/\.ics$/i.test(url.pathname)) {
    throw new Error("That's not the ICS link — use the one ending in .ics from \"Publish to web\"");
  }
  return url.toString();
}

async function loadFeed(url) {
  if (feedCache.url === url && Date.now() - feedCache.at < FEED_CACHE_MS) {
    if (feedCache.error) throw feedCache.error;
    return feedCache.expander;
  }
  let expander = null;
  let error = null;
  try {
    const res = await fetch(url, { headers: { Accept: "text/calendar" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new FeedError(`Outlook didn't return the HR calendar feed (HTTP ${res.status}). Check the ICS link in /admin.html — it may have been unpublished.`);
    const text = await res.text();
    if (text.length > MAX_FEED_BYTES) throw new FeedError("The HR calendar feed is too large to read.");
    if (!/BEGIN:VCALENDAR/.test(text)) throw new FeedError("The HR calendar link didn't return a calendar feed. Use the ICS link, not the HTML one.");
    registerFeedTimezones(text);
    expander = new IcalExpander({ ics: text, maxIterations: 2000, skipInvalidDates: true });
  } catch (err) {
    error = err instanceof FeedError ? err : new FeedError("Couldn't read the HR calendar feed. Try again in a few minutes.");
    if (!(err instanceof FeedError)) console.error("HR calendar feed failed:", err.message);
  }
  feedCache = { url, at: Date.now(), expander, error };
  if (error) throw error;
  return expander;
}

/** ICAL.Time -> "YYYY-MM-DD" for all-day, or an ISO instant ("...Z"). */
function asValue(t) {
  if (t.isDate) return t.toString().slice(0, 10);
  return t.toJSDate().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Entries between two instants, in the same shape as personal events:
 * { subject, start, end, allDay, location } with all-day dates as
 * "YYYY-MM-DD" (end exclusive) and timed ones as UTC instants.
 */
async function hrEvents(url, from, to) {
  const expander = await loadFeed(url);
  const { events, occurrences } = expander.between(from, to);
  const out = [];
  for (const e of events) {
    out.push({ subject: e.summary || "(No title)", start: asValue(e.startDate), end: asValue(e.endDate), allDay: !!e.startDate.isDate, location: e.location || "" });
  }
  for (const o of occurrences) {
    const e = o.item;
    out.push({ subject: e.summary || "(No title)", start: asValue(o.startDate), end: asValue(o.endDate), allDay: !!o.startDate.isDate, location: e.location || "" });
  }
  out.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return out;
}

module.exports = { hrEvents, cleanFeedUrl, FeedError, WINDOWS_TO_IANA };

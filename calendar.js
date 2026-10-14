// Reads a person's own Outlook calendar through Microsoft Graph, read-only.
// Uses the same app registration as mailer.js (see graph.js); it needs the
// Calendars.Read application permission with admin consent. The mailbox is
// always the email stored on the signed-in person's login — never one sent
// by the browser — so people only ever see their own calendar.

const { graphConfigured, getAccessToken } = require("./graph");

const CACHE_MS = 2 * 60 * 1000;
const cache = new Map(); // email -> { at, result }

/** A user-safe reason the calendar can't be shown, by Graph status. */
class CalendarError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Events from now until `days` ahead, oldest first. Times come back in UTC
 * (Graph's default) and the browser shows them in local time.
 */
async function upcomingEvents(email, days) {
  if (!graphConfigured) {
    throw new CalendarError("not_configured", "Microsoft 365 isn't connected to the tracker yet (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET).");
  }
  if (!email) {
    throw new CalendarError("no_email", "Your login has no email address. Ask an admin to add your Microsoft 365 email at /admin.html.");
  }
  const key = `${email.toLowerCase()}|${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
  const url = new URL(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/calendarView`);
  url.searchParams.set("startDateTime", start.toISOString());
  url.searchParams.set("endDateTime", end.toISOString());
  url.searchParams.set("$select", "subject,start,end,location,isAllDay,isCancelled,showAs,webLink,organizer,isOnlineMeeting,onlineMeeting");
  url.searchParams.set("$orderby", "start/dateTime");
  url.searchParams.set("$top", "200");

  const token = await getAccessToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 403 || res.status === 401) {
    throw new CalendarError("no_permission", "The tracker's Microsoft app doesn't have permission to read calendars yet. Your Microsoft 365 admin needs to add Calendars.Read — see the README.");
  }
  if (res.status === 404) {
    throw new CalendarError("not_found", `No Microsoft 365 mailbox was found for ${email}. Check the email on your login at /admin.html.`);
  }
  if (!res.ok) {
    const text = await res.text();
    console.error(`Graph calendarView failed (${res.status}): ${text.slice(0, 300)}`);
    throw new CalendarError("error", "Microsoft 365 didn't return your calendar. Try again in a minute.");
  }
  const data = await res.json();
  const events = (data.value || [])
    .filter((e) => !e.isCancelled)
    .map((e) => ({
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
  const result = { events, from: start.toISOString(), to: end.toISOString() };
  cache.set(key, { at: Date.now(), result });
  return result;
}

module.exports = { upcomingEvents, CalendarError };

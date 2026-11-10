// Strategy Meeting (Company → Strategy Meeting): one table of topics for the
// weekly meeting. This file is the rules — what a row and its log hold, the
// next meeting's date, and picking #strategymeeting / @strategymeeting out
// of notes saved anywhere in the tracker. index.js has the routes;
// strategy.json holds { topics: [...], raised: [...] } (the old
// meeting-based `meetings` stay in the file but aren't shown).
//
// Leadership only (the `leadership` tick, not full access), checked on every
// route. A note assigned to someone becomes a task for them, like a board
// file's next step. Nothing here is sent to AI.

const { text } = require("./staffforms");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 24 * 60 * 60 * 1000;
const EVERY_DAYS = 7; // weekly
const STATUSES = ["open", "decided", "closed"];
const TAG = /(^|[^\w])[#@]strategymeeting\b/i;
const MAX_RAISED = 2000; // remembered tagged lines, so re-saving a note doesn't add the row again

function shape(doc) {
  doc.topics = Array.isArray(doc.topics) ? doc.topics : [];
  doc.raised = Array.isArray(doc.raised) ? doc.raised : [];
  return doc;
}
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);

// The meetings: settings.strategyDates when someone sets a list (or a
// calendar fills it later); until then every Monday from this week to the
// end of the year. Dates topics already use are always included.
function meetingDates(doc, settings, today) {
  const set = new Set();
  const listed = Array.isArray(settings && settings.strategyDates) ? settings.strategyDates.filter((d) => DATE.test(d || "")) : [];
  if (listed.length) listed.forEach((d) => set.add(d));
  else {
    const t = new Date(today + "T00:00:00Z");
    let d = addDays(today, -((t.getUTCDay() + 6) % 7)); // this week's Monday
    const end = `${today.slice(0, 4)}-12-31`;
    for (; d <= end; d = addDays(d, EVERY_DAYS)) set.add(d);
  }
  for (const x of shape(doc).topics) if (DATE.test(x.discussOn || "")) set.add(x.discussOn);
  return [...set].sort();
}
// The people topics and notes are assigned to: settings.strategyPeople, or
// Greg, Nyssa, Ramin, Alexis and Melissa — each matched to a login by
// username or the start of their email.
const PEOPLE = ["greg", "nyssa", "ramin", "alexis", "melissa"];
function people(settings, logins) {
  const names = Array.isArray(settings && settings.strategyPeople) && settings.strategyPeople.length ? settings.strategyPeople : PEOPLE;
  const out = [];
  for (const n of names) {
    const k = String(n).toLowerCase().trim();
    const u = logins.find((x) => x.username.toLowerCase() === k) ||
      logins.find((x) => x.username.toLowerCase().split(/[.\s_-]/)[0] === k) ||
      logins.find((x) => String(x.email || "").toLowerCase().split("@")[0].split(/[.\s_-]/)[0] === k);
    if (u && !out.includes(u.username)) out.push(u.username);
  }
  return out;
}

/**
 * The next meeting: the earliest date to discuss from today on; else the
 * latest past date moved on by whole weeks to today or later; else today.
 */
function nextDate(doc, today, meetings) {
  if (meetings) { const ahead = meetings.find((d) => d >= today); if (ahead) return ahead; }
  const dates = shape(doc).topics.map((t) => t.discussOn).filter((d) => DATE.test(d || "")).sort();
  const ahead = dates.find((d) => d >= today);
  if (ahead) return ahead;
  const last = dates[dates.length - 1];
  if (!last) return today;
  const weeks = Math.ceil((Date.parse(today + "T00:00:00Z") - Date.parse(last + "T00:00:00Z")) / (EVERY_DAYS * DAY));
  return addDays(last, weeks * EVERY_DAYS);
}

/** A row's own fields from the page: { topic, owner, discussOn, status } (each optional). */
function cleanTopic(b, isLogin) {
  const out = {};
  if ("topic" in b) { out.topic = text(b.topic, 200); if (!out.topic) return { error: "Write the topic" }; }
  if ("owner" in b) {
    out.owner = "";
    if (b.owner) { out.owner = isLogin(b.owner); if (!out.owner) return { error: `No login called ${text(b.owner, 60)}` }; }
  }
  if ("discussOn" in b) { out.discussOn = String(b.discussOn || ""); if (out.discussOn && !DATE.test(out.discussOn)) return { error: "Pick the date to discuss it" }; }
  if ("status" in b) { if (!STATUSES.includes(b.status)) return { error: "Pick a status" }; out.status = b.status; }
  return { out };
}

/** A log entry from the page: { text, kind: "note" | "decision", for, due }. */
function cleanEntry(b, isLogin) {
  const t = String(b.text == null ? "" : b.text).trim().slice(0, 4000);
  if (!t) return { error: "Write the note first" };
  const out = { text: t, kind: b.kind === "decision" ? "decision" : "note" };
  if (b.for) { out.for = isLogin(b.for); if (!out.for) return { error: `No login called ${text(b.for, 60)}` }; }
  if (b.due) { if (!DATE.test(b.due)) return { error: "Pick a due date" }; if (!out.for) return { error: "Pick who it's for before giving it a due date" }; out.due = b.due; }
  return { out };
}

/**
 * Every line carrying #strategymeeting / @strategymeeting in a saved
 * request's text fields (any depth). Returns [{ line, topic }].
 */
function taggedLines(body) {
  const out = [], seen = new Set();
  const walk = (v, depth) => {
    if (depth > 6 || v == null) return;
    if (typeof v === "string") {
      for (const raw of v.split(/\r?\n/)) {
        const line = raw.trim();
        if (!TAG.test(line) || seen.has(line.toLowerCase())) continue;
        seen.add(line.toLowerCase());
        const topic = line.replace(/[#@]strategymeeting\b/gi, " ").replace(/\s{2,}/g, " ").replace(/^[\s\-–:,.]+|[\s\-–:,]+$/g, "");
        out.push({ line: line.slice(0, 4000), topic: text(topic, 200) || "Raised for the strategy meeting" });
      }
    } else if (Array.isArray(v)) v.slice(0, 500).forEach((x) => walk(x, depth + 1));
    else if (typeof v === "object" && !Buffer.isBuffer(v)) Object.keys(v).slice(0, 200).forEach((k) => walk(v[k], depth + 1));
  };
  walk(body, 0);
  return out;
}
/** What a tagged line is remembered by: its text, wherever it was saved. */
const raisedKey = (line) => line.toLowerCase().replace(/\s+/g, " ");
function remember(doc, key) {
  shape(doc).raised.push(key);
  if (doc.raised.length > MAX_RAISED) doc.raised.splice(0, doc.raised.length - MAX_RAISED);
}

module.exports = { EVERY_DAYS, STATUSES, TAG, PEOPLE, shape, meetingDates, people, nextDate, cleanTopic, cleanEntry, taggedLines, raisedKey, remember };

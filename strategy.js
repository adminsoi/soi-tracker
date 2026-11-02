// Strategy Meeting (Company → Strategy Meeting): a weekly meeting with an
// agenda. This file is the rules — what a meeting, an agenda item and an
// action item hold, the next meeting's date and what carries over. index.js
// has the routes; strategy.json holds { meetings: [...] }.
//
// Leadership only (the `leadership` tick, not full access), checked on every
// route. Action items can go to any login: each shows on that person's
// Mentions of You until they (or Leadership) tick it done. Nothing here is
// sent to AI.

const { text } = require("./staffforms");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 24 * 60 * 60 * 1000;
const EVERY_DAYS = 7; // weekly
const MAX_ITEMS = 60, MAX_ACTIONS = 30;

function shape(doc) {
  doc.meetings = Array.isArray(doc.meetings) ? doc.meetings : [];
  return doc;
}
const byDateDesc = (a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0);

/** A week after the latest meeting, or today when there's none. */
function nextDate(doc, today) {
  const last = shape(doc).meetings.slice().sort(byDateDesc)[0];
  if (!last || !DATE.test(last.date)) return today;
  const d = new Date(Date.parse(last.date + "T00:00:00Z") + EVERY_DAYS * DAY).toISOString().slice(0, 10);
  return d < today ? today : d;
}

const longText = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const minutes = (v) => { const n = Math.round(+v); return Number.isFinite(n) && n > 0 ? Math.min(n, 600) : 0; };

/**
 * A meeting from the page: { date, title, items: [{ id, topic, owner,
 * minutes, notes, decisions, discussed, actions: [{ id, text, person, due }] }] }.
 * `isLogin(name)` returns the login's username, or "" when there's none.
 * `old` is the stored meeting: action items keep their done / doneAt /
 * doneBy from it (those change only through the tick on their own route).
 * Returns { meeting } or { error }.
 */
function cleanMeeting(b, old, isLogin, newId) {
  if (!DATE.test(b.date || "")) return { error: "Pick the meeting date" };
  const oldActions = {};
  for (const it of (old && old.items) || []) for (const a of it.actions || []) oldActions[a.id] = a;
  const items = [];
  for (const raw of (Array.isArray(b.items) ? b.items : []).slice(0, MAX_ITEMS)) {
    const topic = text(raw.topic, 200);
    if (!topic) return { error: "Every agenda item needs a topic" };
    let owner = "";
    if (raw.owner) { owner = isLogin(raw.owner); if (!owner) return { error: `No login called ${text(raw.owner, 60)}` }; }
    const actions = [];
    for (const ra of (Array.isArray(raw.actions) ? raw.actions : []).slice(0, MAX_ACTIONS)) {
      const t = text(ra.text, 300);
      if (!t) return { error: `An action item under “${topic}” has no text` };
      const person = isLogin(ra.person);
      if (!person) return { error: `Pick who does “${t.slice(0, 60)}”` };
      if (ra.due && !DATE.test(ra.due)) return { error: `Pick a due date for “${t.slice(0, 60)}”` };
      const was = ra.id && oldActions[ra.id];
      const a = { id: was ? was.id : newId(), text: t, person, due: ra.due || "", done: !!(was && was.done) };
      if (a.done) { a.doneAt = was.doneAt; a.doneBy = was.doneBy; }
      actions.push(a);
    }
    const item = { id: text(raw.id, 40) || newId(), topic, owner, minutes: minutes(raw.minutes), notes: longText(raw.notes, 5000), decisions: longText(raw.decisions, 5000), discussed: !!raw.discussed, actions };
    if (raw.carriedFrom) item.carriedFrom = text(raw.carriedFrom, 10);
    items.push(item);
  }
  return { meeting: { date: b.date, title: text(b.title, 120), items } };
}

/**
 * Agenda items for a new meeting: the ones not marked discussed in the
 * latest earlier meeting, without their action items (those stay on the
 * meeting they were set in, and on Mentions of You until done).
 */
function carryOver(doc, date, newId) {
  const prev = shape(doc).meetings.filter((m) => m.date <= date).sort(byDateDesc)[0];
  if (!prev) return [];
  return prev.items.filter((it) => !it.discussed).map((it) => ({
    id: newId(), topic: it.topic, owner: it.owner, minutes: it.minutes, notes: it.notes, decisions: "", discussed: false, actions: [], carriedFrom: prev.date,
  }));
}

/** Every action item, with where it was set. */
function allActions(doc) {
  const out = [];
  for (const m of shape(doc).meetings) for (const it of m.items || []) for (const a of it.actions || []) out.push({ meeting: m, item: it, action: a });
  return out;
}

module.exports = { EVERY_DAYS, shape, byDateDesc, nextDate, cleanMeeting, carryOver, allActions };

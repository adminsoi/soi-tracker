// On/offboarding checklists (Company → On/offboarding): one checklist per
// person joining or leaving, in two sections — IT (server login, Duo,
// email…) and Admin (keys, badge, building access…). This file is the
// rules: who sees it, the standard items, and when IT is done. index.js has
// the routes; onboarding.json holds { templates, lists }.
//
// Seen by full access, HR, IT and the named people (ONBOARDING_PEOPLE on the stack,
// usernames comma separated; default Alexis, Melissa, Nyssa, Greg and
// Ramin). Anyone who sees it can tick items and add items, to one
// checklist or to the standard list new checklists start from. When the
// last IT item is ticked, the admin person (ONBOARDING_ADMIN, default
// Melissa) is emailed that IT is done and it's over to them; when every
// item is ticked, ONBOARDING_DONE_NOTIFY (default Nyssa, Alexis, Ramin and
// Melissa) are emailed that it's complete. Only names and
// tasks are kept here: no passwords, ID numbers or pay.

const { text } = require("./staffforms");

const PEOPLE = String(process.env.ONBOARDING_PEOPLE || "alexis,melissa,nyssa,greg,ramin").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const ADMIN = String(process.env.ONBOARDING_ADMIN || "melissa").trim().toLowerCase();
// Emailed once when every item on a checklist is ticked.
const DONE_NOTIFY = String(process.env.ONBOARDING_DONE_NOTIFY || "nyssa,alexis,ramin,melissa").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const KINDS = { onboarding: "Onboarding", offboarding: "Offboarding" };
const SECTIONS = { it: "IT", admin: "Admin" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULTS = {
  offboarding: {
    it: [
      "Disable the server / network login",
      "Remove from Duo",
      "Block email sign-in and hand the mailbox over (forward or shared mailbox)",
      "Remove the Microsoft 365 licence",
      "Remove from Teams and shared mailboxes",
      "Disable the Pentagon login",
      "Remove the AOG Tracker login",
      "Remove VPN access",
      "Collect and wipe the laptop and other devices",
      "Change shared passwords they knew",
    ],
    admin: [
      "Collect keys, badge and access cards",
      "Remove building and alarm access",
      "Collect company phone and cards",
      "Update the phone list and org chart",
    ],
  },
  onboarding: {
    it: [
      "Create the server / network login",
      "Set up Duo",
      "Create the email and Microsoft 365 account",
      "Add to Teams and shared mailboxes",
      "Create the Pentagon login",
      "Create the AOG Tracker login",
      "Set up VPN access",
      "Set up the laptop and printers",
    ],
    admin: [
      "Desk, keys and badge ready",
      "Building and alarm access",
      "Add to the phone list and org chart",
      "Welcome pack",
    ],
  },
};

const lc = (s) => String(s || "").toLowerCase();
/** Full access, HR, IT, or one of the named people. */
function hasAccess(u) {
  if (!u) return false;
  const d = u.departments || [];
  return !!u.fullAccess || d.includes("HR") || d.includes("IT") || PEOPLE.includes(lc(u.username));
}
/** Whose Mentions of You show open IT items: IT and full access. */
const isItPerson = (u) => !!u && (!!u.fullAccess || (u.departments || []).includes("IT"));
const isAdminPerson = (u) => !!u && lc(u.username) === ADMIN;

function shape(doc) {
  doc.lists = Array.isArray(doc.lists) ? doc.lists : [];
  doc.templates = doc.templates && typeof doc.templates === "object" ? doc.templates : {};
  for (const k of Object.keys(KINDS)) {
    const t = (doc.templates[k] = doc.templates[k] && typeof doc.templates[k] === "object" ? doc.templates[k] : {});
    for (const s of Object.keys(SECTIONS)) if (!Array.isArray(t[s])) t[s] = DEFAULTS[k][s].slice();
  }
  return doc;
}
const item = (label, id) => ({ id, label: text(label, 200), done: false, by: "", at: 0 });

/** A new checklist from the page, its items copied from the standard list. */
function newList(doc, b, by, newId, now) {
  if (!KINDS[b.kind]) return { error: "Onboarding or offboarding?" };
  const person = text(b.person, 120);
  if (!person) return { error: "Who is it for?" };
  if (b.date && !DATE.test(b.date)) return { error: "Pick a date" };
  const t = shape(doc).templates[b.kind];
  return {
    list: {
      id: newId(), kind: b.kind, person, company: text(b.company, 60), date: b.date || "", notes: String(b.notes || "").trim().slice(0, 2000),
      sections: Object.fromEntries(Object.keys(SECTIONS).map((s) => [s, t[s].map((l) => item(l, newId()))])),
      createdBy: by, at: now, handoffAt: 0, handoffBy: "", closedAt: 0, log: [{ at: now, by, what: `Started the ${KINDS[b.kind].toLowerCase()} checklist` }],
    },
  };
}
const itDone = (l) => l.sections.it.length > 0 && l.sections.it.every((x) => x.done);
const allDone = (l) => Object.values(l.sections).every((xs) => xs.every((x) => x.done));
function progress(l) {
  const all = Object.values(l.sections).flat();
  return { done: all.filter((x) => x.done).length, total: all.length };
}
function log(l, by, what) {
  l.log = Array.isArray(l.log) ? l.log : [];
  l.log.push({ at: Date.now(), by, what });
  if (l.log.length > 300) l.log = l.log.slice(-300);
}

module.exports = { PEOPLE, ADMIN, DONE_NOTIFY, KINDS, SECTIONS, DEFAULTS, hasAccess, isItPerson, isAdminPerson, shape, item, newList, itDone, allDone, progress, log };

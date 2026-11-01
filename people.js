// People (ROADMAP.md Phase 5): each person's employment file and the
// one-click spot bonus, Leadership only. This file is the rules — the
// fields a file holds, the next pay week and when a spot bonus can still be
// taken back. index.js has the routes; files are stored in S3 as
// people.json (supporting documents under people_files/<file id>/). Weekly
// base pay, pay currency and entity stay in payroll.json, so HR → Payroll
// and the employment file show the same figures.
//
// Nothing here works out pay, tax or entitlement, and no tax or ID numbers
// are stored: those stay with the payroll provider.

const { text } = require("./staffforms");

const EMPLOYMENT_TYPES = ["Full-time", "Part-time", "Contractor", "Casual", "Intern"];
const SPOT_BONUS = { amount: 100, source: "spot-bonus" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Leadership only: the page, every route and every file.
const isLeadership = (u) => !!(u && u.leadership);

function peopleShape(doc) {
  doc.people = doc.people && typeof doc.people === "object" ? doc.people : {};
  return doc;
}
/** One person's file, created empty the first time (with the id that names its S3 folder). */
function fileOf(doc, username, newId) {
  const f = (doc.people[username] = doc.people[username] || {});
  if (!f.id) f.id = newId();
  f.files = Array.isArray(f.files) ? f.files : [];
  f.history = Array.isArray(f.history) ? f.history : [];
  f.emergency = f.emergency && typeof f.emergency === "object" ? f.emergency : {};
  return f;
}

const FIELD_LABEL = {
  jobTitle: "job title", department: "department", manager: "manager", startDate: "start date",
  employmentType: "employment type", emergency: "emergency contact", notes: "notes",
};
/**
 * The employment file fields from a save, cleaned. `departments` and
 * `logins` (usernames) are what may be picked. Only fields present in the
 * input are returned. Returns { fields } or { error }.
 */
function cleanFile(input, departments, logins) {
  const b = input && typeof input === "object" ? input : {};
  const out = {};
  if ("jobTitle" in b) out.jobTitle = text(b.jobTitle, 120);
  if ("department" in b) {
    out.department = departments.includes(b.department) ? b.department : "";
    if (b.department && !out.department) return { error: "Pick a department from the list" };
  }
  if ("manager" in b) {
    out.manager = logins.find((u) => String(u).toLowerCase() === String(b.manager || "").toLowerCase()) || "";
    if (b.manager && !out.manager) return { error: "Pick the manager from the logins" };
  }
  if ("startDate" in b) {
    out.startDate = DATE.test(b.startDate || "") ? b.startDate : "";
    if (b.startDate && !out.startDate) return { error: "Bad start date" };
  }
  if ("employmentType" in b) out.employmentType = EMPLOYMENT_TYPES.includes(b.employmentType) ? b.employmentType : "";
  if (b.emergency && typeof b.emergency === "object") {
    out.emergency = { name: text(b.emergency.name, 120), relationship: text(b.emergency.relationship, 60), phone: text(b.emergency.phone, 40), email: text(b.emergency.email, 120) };
  }
  if ("notes" in b) out.notes = String(b.notes == null ? "" : b.notes).trim().slice(0, 4000);
  return { fields: out };
}
/** Labels of the fields that changed, for the file's history. */
function changedFields(before, fields) {
  const norm = (k, v) => (k === "emergency" ? ["name", "relationship", "phone", "email"].map((x) => (v || {})[x] || "").join("\n") : String(v || ""));
  return Object.keys(fields).filter((k) => norm(k, before[k]) !== norm(k, fields[k])).map((k) => FIELD_LABEL[k] || k);
}

// Pay weeks run Monday to Sunday (as on HR → Payroll).
function addDays(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function mondayOf(ymd) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); }
/** The Monday of the next pay week after `today` (YYYY-MM-DD). */
function nextPayWeek(today) { return addDays(mondayOf(today), 7); }

/**
 * The person's pay currency: what's set on them in Payroll, else their
 * entity's currency in Payroll, else USD.
 */
function payCurrency(payroll, username, entity, currencies) {
  const p = ((payroll || {}).people || {})[username] || {};
  const e = ((payroll || {}).entities || {})[entity] || {};
  return [p.currency, e.currency].find((c) => currencies.includes(c)) || "USD";
}

/**
 * Whether Leadership may still take a spot bonus back. Payroll has no
 * "marked done" yet, so it's until the pay week it's in has ended; after
 * that only HR can remove it (HR → Payroll). Returns an error message, or "".
 */
function spotBonusLock(adj, today) {
  if (!adj || adj.source !== SPOT_BONUS.source) return "Only spot bonuses can be removed here — other adjustments are on HR → Payroll";
  if (addDays(adj.week, 6) < today) return "That pay week has passed — ask HR";
  return "";
}

/** A login's access in words, for the list. */
function roleLabel(u) {
  const out = [];
  if (u.leadership) out.push("Leadership");
  if (u.fullAccess) out.push("Full access");
  else if (u.manager) out.push("Manager");
  return out.length ? out.join(" · ") : "Staff";
}

module.exports = {
  EMPLOYMENT_TYPES, SPOT_BONUS, isLeadership, peopleShape, fileOf, cleanFile, changedFields,
  addDays, mondayOf, nextPayWeek, payCurrency, spotBonusLock, roleLabel,
};

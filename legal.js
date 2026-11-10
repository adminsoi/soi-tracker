// Legal (Administration → Legal): contracts, insurance and vendor documents
// with their expiry (renewal) dates, notes and a person responsible. This
// file is the rules — who has Legal, the four sections, and when something
// is due. index.js has the routes; legal.json holds the list of named staff
// and, per document, { expiry, notes, owner }. The documents themselves are
// in Documents (documents.js): a "Legal" space per company with one folder
// per section, created when Legal is first opened.
//
// Leadership plus the named staff only, checked on every route (full access
// alone isn't enough, as for People). Leadership adds and removes the named
// staff and ticks, per person, which of the four sections they see
// (legal.json access: { username: [section ids] }); a section someone
// isn't ticked for is hidden from them in Legal and in Documents. Expiry dates and notes are typed by hand; nothing here makes up
// contract, certificate or approval numbers, and none of it is sent to AI.

const { text } = require("./staffforms");

const LEGAL = "Legal"; // the department name of its Documents space
const SECTIONS = [
  { id: "usgov", label: "US Government Contracts", companies: ["SOI Aviation"] },
  { id: "bd", label: "Business Development" },
  { id: "insurance", label: "Insurance" },
  { id: "vendors", label: "Vendors" },
];
const SOON_DAYS = 60; // shown on the person's Mentions of You from here
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 24 * 60 * 60 * 1000;

const sectionsFor = (company) => SECTIONS.filter((s) => !s.companies || s.companies.includes(company));

const SECTION_IDS = SECTIONS.map((s) => s.id);
function shape(doc) {
  doc.members = Array.isArray(doc.members) ? doc.members : [];
  doc.records = doc.records && typeof doc.records === "object" ? doc.records : {};
  // Named staff from before per-section access keep every section.
  if (!doc.access || typeof doc.access !== "object") {
    doc.access = {};
    for (const m of doc.members) doc.access[m] = SECTION_IDS.slice();
  }
  for (const [k, v] of Object.entries(doc.access)) doc.access[k] = (Array.isArray(v) ? v : []).filter((id) => SECTION_IDS.includes(id));
  doc.members = Object.keys(doc.access).filter((k) => doc.access[k].length);
  return doc;
}
/** The section ids a login sees: all of them for Leadership. */
function sectionsOf(u, doc) {
  if (!u) return [];
  if (u.leadership) return SECTION_IDS.slice();
  const key = Object.keys(shape(doc).access).find((k) => k.toLowerCase() === String(u.username).toLowerCase());
  return key ? doc.access[key].slice() : [];
}
const hasSection = (u, doc, id) => sectionsOf(u, doc).includes(id);
/** Leadership, or named staff with at least one section. */
function hasLegal(u, doc) {
  return sectionsOf(u, doc).length > 0;
}
/** { username: [section ids] } from the page: known sections only, people with none dropped. */
function cleanAccess(input) {
  const out = {};
  for (const [k, v] of Object.entries(input && typeof input === "object" ? input : {})) {
    const ids = [...new Set((Array.isArray(v) ? v : []).filter((id) => SECTION_IDS.includes(id)))];
    if (ids.length) out[k] = ids;
  }
  return out;
}

/** Whole days from today (YYYY-MM-DD) to the expiry date; negative once it has passed. */
function daysLeft(expiry, today) {
  if (!DATE.test(expiry || "") || !DATE.test(today || "")) return null;
  return Math.round((Date.parse(expiry + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / DAY);
}
/** "expired" | "soon" (within 60 days) | "ok" | "" (no date). */
function status(expiry, today) {
  const d = daysLeft(expiry, today);
  return d === null ? "" : d < 0 ? "expired" : d <= SOON_DAYS ? "soon" : "ok";
}

/** A record change from the page: { expiry, notes, owner } (each optional). */
function cleanRecord(b) {
  const out = {};
  if ("expiry" in b) {
    const v = String(b.expiry || "");
    if (v && !DATE.test(v)) return { error: "Pick a date for the expiry" };
    out.expiry = v;
  }
  if ("notes" in b) out.notes = String(b.notes == null ? "" : b.notes).trim().slice(0, 2000);
  if ("owner" in b) out.owner = text(b.owner, 60);
  return { out };
}

module.exports = { LEGAL, SECTIONS, SECTION_IDS, SOON_DAYS, sectionsFor, shape, sectionsOf, hasSection, hasLegal, cleanAccess, daysLeft, status, cleanRecord };

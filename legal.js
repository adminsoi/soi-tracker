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
// staff. Expiry dates and notes are typed by hand; nothing here makes up
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

function shape(doc) {
  doc.members = Array.isArray(doc.members) ? doc.members : [];
  doc.records = doc.records && typeof doc.records === "object" ? doc.records : {};
  return doc;
}
/** Leadership, or one of the named staff. */
function hasLegal(u, doc) {
  if (!u) return false;
  if (u.leadership) return true;
  return shape(doc).members.some((m) => String(m).toLowerCase() === String(u.username).toLowerCase());
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

module.exports = { LEGAL, SECTIONS, SOON_DAYS, sectionsFor, shape, hasLegal, daysLeft, status, cleanRecord };

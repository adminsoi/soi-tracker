// HR → Payroll approval (ROADMAP.md Phase 5): an entity's pay week is
// approved and sent to the external accountants, who check the figures
// before they run payroll. This file is the rules — who's in which table,
// the figures as approved (a snapshot, so later edits can't change what
// was sent), the email and the lock. index.js has the routes; everything
// is stored in payroll.json (`approvals[entity][week]`, `approvalLog`).
//
// It never works out pay: it lists base pay, approved leave days and
// adjustments as they stand. No tax or ID numbers, contacts or notes.

const { LEAVE_TYPES, weekdaysBetween, CURRENCIES } = require("./staffforms");

const ENTITY_CURRENCY = { SOI: "USD", CAS: "NZD", RedSun: "SGD", NanoTech: "GBP" };
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const LEAVE_LABEL = Object.fromEntries(LEAVE_TYPES.map((t) => [t.id, t.label]));

function addDays(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const isMonday = (ymd) => /^\d{4}-\d{2}-\d{2}$/.test(ymd || "") && new Date(`${ymd}T12:00:00Z`).getUTCDay() === 1;
/** "2 Nov 2026" from YYYY-MM-DD. */
function longDate(ymd) { return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); }

/** The accountants' addresses from what HR typed (commas, semicolons, spaces or lines). Returns { emails } or { error }. */
function parseEmails(input) {
  const list = [...new Set([].concat(input || []).join(" ").split(/[\s,;]+/).map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const bad = list.filter((a) => !EMAIL.test(a));
  if (bad.length) return { error: `That doesn't look like an email address: ${bad[0]}` };
  if (list.length > 10) return { error: "Up to 10 addresses" };
  return { emails: list };
}

/** The pay entity a login is on: set in Payroll, else from their first company. */
function entityOf(payroll, login, companyEntity) {
  const ent = (((payroll || {}).people || {})[login.username] || {}).entity;
  return ENTITY_CURRENCY[ent] ? ent : companyEntity[(login.companies || [])[0]] || "SOI";
}
function currencyOf(payroll, entity, p) {
  return [p && p.currency, (((payroll || {}).entities || {})[entity] || {}).currency].find((c) => CURRENCIES.includes(c)) || ENTITY_CURRENCY[entity];
}

/**
 * Leave days of one approved request that fall in the pay week (as on the
 * Payroll page). `check` when the person changed the working days by hand
 * and the leave runs past this week.
 */
function leaveDaysInWeek(item, week) {
  const f = item.fields || {}, end = addDays(week, 6);
  if (!f.from || !f.to || f.to < week || f.from > end) return null;
  const inWeek = weekdaysBetween(f.from > week ? f.from : week, f.to < end ? f.to : end), total = weekdaysBetween(f.from, f.to);
  if (f.days === total) return { days: inWeek, check: false };
  if (f.from >= week && f.to <= end) return { days: f.days, check: false };
  return { days: inWeek, check: true };
}

/**
 * The entity's pay week as it stands: one row per person with base pay,
 * approved leave or adjustments that week, and totals per currency.
 * `logins` are normalized logins; `leave` the stored leave requests.
 */
function buildSnapshot({ payroll, logins, leave, entity, week, label, companyEntity }) {
  const people = (payroll && payroll.people) || {};
  const adjustments = (payroll && payroll.adjustments) || [];
  const rows = [];
  for (const login of logins) {
    if (entityOf(payroll, login, companyEntity) !== entity) continue;
    const p = people[login.username] || {};
    const currency = currencyOf(payroll, entity, p);
    const lv = leave.filter((i) => i.kind === "leave" && i.status === "approved" && String(i.by).toLowerCase() === login.username.toLowerCase())
      .map((i) => { const x = leaveDaysInWeek(i, week); return x && x.days ? { type: i.fields.type === "other" ? i.fields.otherType || "Other" : LEAVE_LABEL[i.fields.type] || i.fields.type, days: x.days, check: x.check } : null; })
      .filter(Boolean);
    const adj = adjustments.filter((a) => a.week === week && String(a.person).toLowerCase() === login.username.toLowerCase())
      .map((a) => ({ id: a.id, amount: a.amount, currency: a.currency || currency, reason: a.reason, source: a.source || "manual", by: a.by || "" }));
    if (p.basePay == null && !lv.length && !adj.length) continue;
    const row = { person: login.username, basePay: p.basePay == null ? null : p.basePay, currency, leave: lv, leaveDays: lv.reduce((s, x) => s + x.days, 0), adjustments: adj };
    if (entity === "SOI") row.exempt = typeof p.exempt === "boolean" ? p.exempt : null;
    rows.push(row);
  }
  rows.sort((a, b) => a.person.toLowerCase().localeCompare(b.person.toLowerCase()));
  const totals = { basePay: {}, adjustments: {} };
  for (const r of rows) {
    if (r.basePay != null) totals.basePay[r.currency] = Math.round(((totals.basePay[r.currency] || 0) + r.basePay) * 100) / 100;
    for (const a of r.adjustments) totals.adjustments[a.currency] = Math.round(((totals.adjustments[a.currency] || 0) + a.amount) * 100) / 100;
  }
  return { entity, label, week, weekEnd: addDays(week, 6), rows, totals };
}

const money = (n, cur) => `${cur} ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sums = (o) => Object.keys(o).map((c) => money(o[c], c)).join(" + ") || "—";
const sourceLabel = (a) => (a.source === "spot-bonus" ? "Spot bonus" : "Adjustment");

/** The email to the accountants: subject and HTML. `esc` escapes HTML. */
function snapshotEmail(snap, approval, esc) {
  const soi = snap.entity === "SOI";
  const cell = "padding:6px 10px;border:1px solid #ccc;text-align:left;vertical-align:top;";
  const head = ["Person", ...(soi ? ["Exempt"] : []), "Weekly base pay", "Approved leave (days)", "Adjustments", "Currency"];
  const rows = snap.rows.map((r) => `<tr>` +
    `<td style="${cell}">${esc(r.person)}</td>` +
    (soi ? `<td style="${cell}">${r.exempt === true ? "Exempt" : r.exempt === false ? "Hourly" : "Not set"}</td>` : "") +
    `<td style="${cell}">${r.basePay == null ? "Not entered" : esc(money(r.basePay, r.currency))}</td>` +
    `<td style="${cell}">${r.leave.length ? r.leave.map((x) => `${esc(x.type)}: ${x.days}${x.check ? " (check the request)" : ""}`).join("<br>") : "—"}</td>` +
    `<td style="${cell}">${r.adjustments.length ? r.adjustments.map((a) => `${esc(sourceLabel(a))}: ${esc(money(a.amount, a.currency))} — ${esc(a.reason)}`).join("<br>") : "—"}</td>` +
    `<td style="${cell}">${esc(r.currency)}</td></tr>`).join("");
  const span = head.length;
  const html =
    `<p>Payroll for your check: <b>${esc(snap.label)}</b>, pay week ${esc(longDate(snap.week))} – ${esc(longDate(snap.weekEnd))}.</p>` +
    `<p><b>These figures need your check before payroll is run.</b> They are not a payroll calculation: approved leave and adjustments are listed, not applied to pay.</p>` +
    `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">` +
    `<thead><tr>${head.map((h) => `<th style="${cell}background:#f3f3f3;">${h}</th>`).join("")}</tr></thead><tbody>` +
    (rows || `<tr><td style="${cell}" colspan="${span}">Nobody on this entity has pay, leave or adjustments this week.</td></tr>`) +
    `<tr><td style="${cell}" colspan="${span}"><b>Total base pay:</b> ${esc(sums(snap.totals.basePay))}<br><b>Total adjustments:</b> ${esc(sums(snap.totals.adjustments))}</td></tr>` +
    `</tbody></table>` +
    `<p>Approved by ${esc(approval.by)} on ${esc(new Date(approval.at).toUTCString())}.</p>` +
    `<p style="color:#777;font-size:12px;">Sent from the SOI tracker. Reply to this email with any questions.</p>`;
  return { subject: `Payroll for check: ${snap.label}, week of ${longDate(snap.week)}`, html };
}

/** The approval for an entity's pay week, if there is one. */
function approvalOf(payroll, entity, week) {
  return ((((payroll || {}).approvals || {})[entity]) || {})[week] || null;
}
/**
 * Whether an adjustment is locked: its pay week is approved for the
 * person's entity, or it's in any approval's snapshot (the person moved
 * entity since).
 */
function adjustmentLocked(payroll, adj, entity) {
  if (approvalOf(payroll, entity, adj.week)) return true;
  return Object.values((payroll && payroll.approvals) || {}).some((weeks) => Object.values(weeks || {}).some((ap) =>
    ap && ap.snapshot && ap.snapshot.week === adj.week && ap.snapshot.rows.some((r) => r.adjustments.some((a) => a.id === adj.id))));
}

module.exports = { ENTITY_CURRENCY, isMonday, longDate, parseEmails, entityOf, currencyOf, leaveDaysInWeek, buildSnapshot, snapshotEmail, approvalOf, adjustmentLocked };

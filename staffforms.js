// Administration's staff forms (ROADMAP.md Phase 4): the admin request, HR
// issue, leave request, performance comment and reimbursement forms on each
// department's Staff-Facing tab. This file is the rules — what each form
// asks, the statuses it moves through and who may see or move it. index.js
// has the routes; everything is stored in S3 as staff_forms.json (receipts
// under staff_form_files/<id>/). IT tickets are IT requests (it_requests.json)
// and aren't in here.
//
// Nothing here decides pay, leave entitlement or compliance: it records what
// people asked for and who approved it.

const LEAVE_TYPES = [
  { id: "annual", label: "Annual / vacation" },
  { id: "sick", label: "Sick" },
  { id: "unpaid", label: "Unpaid" },
  { id: "parental", label: "Parental" },
  { id: "bereavement", label: "Bereavement" },
  { id: "jury", label: "Jury duty" },
  { id: "other", label: "Other" },
];
const CURRENCIES = ["USD", "NZD", "SGD", "GBP", "EUR", "AUD"];

// Field specs: a number is a text field of up to that many characters;
// an array is a pick-list; "date", "money", "days", "bool" are what they say.
// `need` lists the fields that must be filled in.
const KINDS = {
  admin: {
    dept: "Administrative", label: "Admin request",
    fields: { category: ["Snacks, coffee & tea", "Office & supplies"], details: 1000, neededBy: "date" },
    need: ["category", "details"],
    statuses: ["new", "progress", "done", "declined", "cancelled"],
  },
  hr_issue: {
    dept: "HR", label: "HR issue",
    fields: { topic: ["Workplace concern", "Pay or benefits", "Policy question", "Something else"], subject: 120, details: 2000, urgent: "bool" },
    need: ["topic", "subject", "details"],
    statuses: ["new", "progress", "done", "cancelled"],
  },
  perf_comment: {
    dept: "HR", label: "Performance comment",
    fields: { about: 80, type: ["Recognition", "Concern", "Suggestion"], details: 2000 },
    need: ["about", "type", "details"],
    statuses: ["new", "progress", "done", "cancelled"],
  },
  leave: {
    dept: "HR", label: "Leave request",
    fields: { type: LEAVE_TYPES.map((t) => t.id), otherType: 80, from: "date", to: "date", days: "days", notes: 500 },
    need: ["type", "from", "to", "days"],
    // Waiting for a manager in their department, then for HR.
    statuses: ["manager", "hr", "approved", "declined", "cancelled"],
  },
  reimburse: {
    dept: "Accounting & Finance", label: "Reimbursement",
    fields: { spentOn: "date", description: 300, amount: "money", currency: CURRENCIES, notes: 500 },
    need: ["spentOn", "description", "amount", "currency"],
    // "draft" until a receipt is attached. Finance's Approvals tab is
    // everything above Approved to pay; Transfers is Approved to pay and Paid.
    statuses: ["draft", "submitted", "checked", "approved", "paid", "rejected", "cancelled"],
  },
};
const STATUS_LABEL = {
  new: "New", progress: "In progress", done: "Done", declined: "Declined",
  manager: "Waiting for manager", hr: "Waiting for HR", approved: "Approved", cancelled: "Cancelled",
  draft: "Needs a receipt", submitted: "Submitted", checked: "Finance checked", paid: "Paid", rejected: "Rejected",
};
const statusLabel = (kind, st) => (kind === "reimburse" && st === "approved" ? "Approved to pay" : STATUS_LABEL[st] || st);
const FINANCE_APPROVALS = ["submitted", "checked", "rejected"];
const FINANCE_TRANSFERS = ["approved", "paid"];
const HR_KINDS = ["hr_issue", "perf_comment", "leave"];
const kindsOf = (dept) => Object.keys(KINDS).filter((k) => KINDS[k].dept === dept);

const text = (v, n) => String(v == null ? "" : v).replace(/ /g, " ").trim().slice(0, n);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The form's answers, cleaned. Returns { fields } or { error }. */
function cleanFields(kind, input) {
  const spec = KINDS[kind];
  if (!spec) return { error: "Unknown form" };
  const b = input && typeof input === "object" ? input : {};
  const out = {};
  for (const [key, type] of Object.entries(spec.fields)) {
    const v = b[key];
    if (Array.isArray(type)) out[key] = type.includes(v) ? v : "";
    else if (type === "date") out[key] = DATE.test(v || "") ? v : "";
    else if (type === "bool") out[key] = !!v;
    else if (type === "money") { const n = Math.round(Number(v) * 100) / 100; out[key] = Number.isFinite(n) && n > 0 && n < 1e7 ? n : 0; }
    else if (type === "days") { const n = Math.round(Number(v) * 2) / 2; out[key] = Number.isFinite(n) && n > 0 && n <= 366 ? n : 0; }
    else out[key] = text(v, type);
  }
  const missing = spec.need.filter((k) => !out[k]);
  if (missing.length) return { error: `Fill in: ${missing.join(", ")}` };
  if (kind === "leave") {
    if (out.to < out.from) return { error: "The last day is before the first day" };
    if (out.type === "other" && !out.otherType) return { error: "Say what kind of leave it is" };
  }
  return { fields: out };
}

/** Weekdays (Monday–Friday) from one YYYY-MM-DD to another, inclusive. */
function weekdaysBetween(from, to) {
  if (!DATE.test(from || "") || !DATE.test(to || "") || to < from) return 0;
  let n = 0;
  for (let d = new Date(`${from}T12:00:00Z`), end = new Date(`${to}T12:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

// ---- Who sees what ----
// Users are the signed-in shape from index.js: { username, departments,
// fullAccess, manager, leadership }.
const inDept = (u, d) => !!(u.fullAccess || (u.departments || []).includes(d));
const sameUser = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const isManager = (u) => !!(u.fullAccess || u.manager);
// HR data (HR issues, performance comments, leave, payroll): HR, Leadership
// and full access see it; HR and full access work it.
const canSeeHr = (u) => !!(u.fullAccess || u.leadership || inDept(u, "HR"));
const hrManager = (u) => isManager(u) && inDept(u, "HR");
/** Can see every submission of this kind (the department's side). */
function canSeeKind(u, kind) {
  if (HR_KINDS.includes(kind)) return canSeeHr(u);
  return !!KINDS[kind] && inDept(u, KINDS[kind].dept);
}
/** Can change status, person responsible and internal notes. */
function canWorkKind(u, kind) {
  if (HR_KINDS.includes(kind)) return inDept(u, "HR");
  return !!KINDS[kind] && inDept(u, KINDS[kind].dept);
}
/** A manager who shares one of the requester's departments (not themselves). */
function managesPerson(u, requester) {
  if (!requester || sameUser(u.username, requester.username) || !isManager(u)) return false;
  if (u.fullAccess) return true;
  return (u.departments || []).some((d) => (requester.departments || []).includes(d));
}

/**
 * What the person may do to a leave request right now: "manager" (first
 * approval), "hr" (final approval) or "". An HR manager can give the first
 * approval too, which approves it outright.
 */
function leaveStep(u, item, requester) {
  if (sameUser(u.username, item.by)) return "";
  if (item.status === "manager") return hrManager(u) ? "hr" : managesPerson(u, requester) ? "manager" : "";
  if (item.status === "hr") return hrManager(u) ? "hr" : "";
  return "";
}

/**
 * Whether `u` may move a submission from its status to `to` (department
 * side; leave goes through leaveStep, and staff withdraw their own through
 * the cancel route). Returns an error message, or "".
 */
function moveBlocker(u, item, to) {
  const spec = KINDS[item.kind];
  if (!spec || !spec.statuses.includes(to)) return "Unknown status";
  if (!canWorkKind(u, item.kind)) return "Only the department can change this";
  // Withdrawn by the person who sent it (the cancel route), not by the department.
  if (item.status === "cancelled" || to === "cancelled") return "Only the person who sent it can withdraw it";
  if (item.kind === "leave") return "Leave is approved or declined from the approval buttons";
  if (item.kind === "reimburse") {
    if (item.status === "draft" || to === "draft") return "That request isn't with Finance yet";
    // Anyone in Finance can move it between Submitted and Finance checked;
    // approving to pay, paying, rejecting and undoing those are for Finance
    // managers (as with Daily payments).
    const open = ["submitted", "checked"];
    if (!isManager(u) && !(open.includes(item.status) && open.includes(to))) return "Only a Finance manager can do that";
    return "";
  }
  if ((to === "declined" || item.status === "declined") && !isManager(u)) return "Only a manager can decline a request or undo that";
  return "";
}

/** Whether the person who sent it may still withdraw it. */
function canWithdraw(item) {
  return ({ admin: ["new"], hr_issue: ["new"], perf_comment: ["new"], leave: ["manager", "hr"], reimburse: ["draft", "submitted"] }[item.kind] || []).includes(item.status);
}

/** A copy for the person who sent it: no internal notes. */
function forRequester(item) {
  const out = Object.assign({}, item);
  delete out.notes;
  out.history = (item.history || []).filter((h) => h.public);
  return out;
}

module.exports = {
  KINDS, LEAVE_TYPES, CURRENCIES, STATUS_LABEL, statusLabel, FINANCE_APPROVALS, FINANCE_TRANSFERS, HR_KINDS, kindsOf,
  cleanFields, weekdaysBetween, text, canSeeHr, hrManager, canSeeKind, canWorkKind, managesPerson, leaveStep, moveBlocker, canWithdraw, forRequester,
};

// AOG operations board: one card per quote, moving left to right through six
// stages (RFQ → Quoted → Sale → Purchased → Received → Sent). This file is
// the rules — stages, case-file checks, approvals, hard stops, flags and who
// sees what. index.js has the routes; cards are stored in S3 as
// aog_board.json (case-file attachments under board_files/).
//
// The tracker is a working layer: quote and order numbers, certificate and
// approval references, and export licence numbers are typed or copied from
// Pentagon and source documents. Nothing here generates them.

const STAGES = [
  { id: "rfq", label: "RFQ", dept: "Procurement" },
  { id: "quoted", label: "Quoted", dept: "Procurement" },
  { id: "sale", label: "Sale", dept: "Purchasing" },
  { id: "purchased", label: "Purchased", dept: "Purchasing" },
  { id: "received", label: "Received", dept: "Warehouse" },
  { id: "sent", label: "Sent", dept: "Warehouse" },
];
const STAGE_IDS = STAGES.map((s) => s.id);
const stageOf = (id) => STAGES.find((s) => s.id === id) || STAGES[0];

// Case-file checklists. RFQ: where the buyer looked (the black file).
// Sale: what has to be in the red file before the purchase goes for approval.
const CHECKS = {
  rfq: [
    { id: "ils", label: "ILS checked" },
    { id: "partsbase", label: "PartsBase checked" },
    { id: "locatory", label: "Locatory checked" },
    { id: "pentagon", label: "Pentagon records checked" },
  ],
  sale: [
    { id: "salesOrder", label: "Sales order created in Pentagon" },
    { id: "supplierPo", label: "Supplier PO created in Pentagon" },
    { id: "deeperResearch", label: "Deeper research done (proof attached to the case file)" },
  ],
};

// Approvals: sourcing (RFQ, before quoting), quote (Quoted, before it goes
// to the client) and purchase (Sale, before the PO is sent).
const APPROVALS = { rfq: "sourcing", quoted: "quote", sale: "purchase" };
const APPROVAL_LABEL = { sourcing: "Sourcing", quote: "Quote", purchase: "Purchase" };

const DUE_SOON_DAYS = 2;
const text = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; };

function checksDone(card, stage) {
  return (CHECKS[stage] || []).every((c) => card.checks && card.checks[c.id]);
}
function approval(card, kind) {
  return (card.approvals && card.approvals[kind]) || { state: "" };
}
function quoteTotal(card) {
  return (card.lines || []).reduce((s, l) => s + num(l.price) * Math.max(1, num(l.qty) || 1), 0);
}

// What's missing before an approval can be asked for, as plain sentences.
function approvalBlockers(card, kind) {
  const out = [];
  if (kind === "sourcing" && !checksDone(card, "rfq")) out.push("Tick every sourcing check (ILS, PartsBase, Locatory, Pentagon)");
  if (kind === "quote") {
    if (!(card.lines || []).length) out.push("Add at least one P/N line");
    if ((card.lines || []).some((l) => !(num(l.price) > 0))) out.push("Every line needs a price");
  }
  if (kind === "purchase" && !checksDone(card, "sale")) out.push("Tick every red-file check (sales order, supplier PO, deeper research)");
  return out;
}

// Hard stops for moving one column to the right, as plain sentences.
function moveBlockers(card, to) {
  const out = [];
  const lines = card.lines || [];
  const from = STAGE_IDS.indexOf(card.stage), dest = STAGE_IDS.indexOf(to);
  if (dest !== from + 1) return out; // only forward moves are gated
  if (to === "quoted") {
    if (!lines.some((l) => l.pn)) out.push("Add at least one P/N");
    if (approval(card, "sourcing").state !== "approved") out.push("Sourcing needs a manager's ✓");
  }
  if (to === "sale") {
    if (approval(card, "quote").state !== "approved") out.push("The quote needs a manager's ✓");
    if (!card.orderNo) out.push("Add the order number from Pentagon");
  }
  if (to === "purchased") {
    if (approval(card, "purchase").state !== "approved") out.push("The purchase needs a manager's ✓");
    if (lines.some((l) => !l.exportLicence)) out.push("Every line needs its export licence field filled in");
  }
  if (to === "received") {
    if (lines.some((l) => !l.location || !l.dateIn)) out.push("Every line needs a warehouse location and date in");
  }
  if (to === "sent") {
    if (lines.some((l) => !l.exportLicence)) out.push("Every line needs its export licence field filled in");
    if (lines.some((l) => !l.qualityOk)) out.push("Every line needs quality sign-off");
  }
  return out;
}

// Flags shown on cards and used by the filters.
function flagsOf(card, now) {
  const flags = [];
  if (card.dueDate && card.stage !== "sent") {
    const days = (Date.parse(card.dueDate + "T23:59:59") - now) / 86400000;
    if (days < DUE_SOON_DAYS) flags.push(days < 0 ? "overdue" : "due");
  }
  const kind = APPROVALS[card.stage];
  if (kind && approval(card, kind).state !== "approved" && approval(card, kind).state !== "rejected" && !approvalBlockers(card, kind).length) flags.push("approval");
  if (card.highlighted) flags.push("highlighted");
  if (approval(card, "quote").state === "rejected" && card.stage === "quoted") flags.push("rejected");
  return flags;
}

// A line as stored. Only fields the person may change are taken from the
// request; the rest keep their saved values.
function cleanLine(input, prev, may) {
  const l = Object.assign({}, prev || {});
  l.id = (prev && prev.id) || text(input.id, 20) || Math.random().toString(36).slice(2, 10);
  for (const [k, n] of [["pn", 60], ["desc", 200], ["exportLicence", 120], ["location", 60], ["carrier", 40], ["tracking", 80]]) if (k in input) l[k] = text(input[k], n);
  if ("qty" in input) l.qty = num(input.qty) || 1;
  if ("dateIn" in input) l.dateIn = /^\d{4}-\d{2}-\d{2}$/.test(input.dateIn) ? input.dateIn : "";
  if ("listOnWebsite" in input) l.listOnWebsite = !!input.listOnWebsite;
  if (may.cost) {
    if ("cost" in input) l.cost = num(input.cost);
    if ("markup" in input) l.markup = num(input.markup);
  }
  if ("price" in input) l.price = num(input.price);
  if (may.quality && "qualityOk" in input && !!input.qualityOk !== !!l.qualityOk) {
    l.qualityOk = !!input.qualityOk;
    l.qualityBy = l.qualityOk ? may.username : "";
    l.qualityAt = l.qualityOk ? Date.now() : 0;
  }
  return l;
}

module.exports = {
  STAGES, STAGE_IDS, stageOf, CHECKS, APPROVALS, APPROVAL_LABEL,
  checksDone, approval, approvalBlockers, moveBlockers, flagsOf, quoteTotal, cleanLine, text, num,
};

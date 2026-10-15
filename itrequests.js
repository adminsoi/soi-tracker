// IT requests from the Microsoft Form. The Power Automate flow emails each
// response to IT_REQUESTS_MAILBOX with a subject starting "[IT Request]" and
// a body of "Label: value" lines. The tracker can't be reached from
// Microsoft's cloud, so instead it reads those emails through Microsoft
// Graph (Mail.Read, the same permission as the Work inbox) and index.js
// turns each new one into an IT task. Read-only: nothing in the mailbox is
// changed.

const { graphConfigured, getAccessToken } = require("./graph");
const { WINDOWS_TO_IANA } = require("./hrcal");

const MAILBOX = String(process.env.IT_REQUESTS_MAILBOX || "").trim();
const TAG = "[IT Request]";
const LOOKBACK_DAYS = 14;

const itRequestsConfigured = graphConfigured && !!MAILBOX;

// A body that starts with the flow's first line, "Response ID: 126".
const RESPONSE_LINE = /^\s*response id\s*:\s*\S+/i;
// "[IT Request] ...", also without the brackets; never replies or forwards.
const SUBJECT_RE = /^\s*\[?\s*it\s+request\s*\]?\s*[:\-—]?\s*/i;
function isItRequestSubject(subject) {
  return SUBJECT_RE.test(String(subject || ""));
}

// "Label: value" lines from the email body (plain text). Lines without a
// label are added to the one before, so multi-line answers stay together.
function parseFields(text) {
  const fields = [];
  for (const raw of String(text || "").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^:]{1,60}):\s*(.*)$/);
    if (m && !/^https?$/i.test(m[1].trim())) fields.push({ label: m[1].trim(), value: m[2].trim() });
    else if (fields.length) fields[fields.length - 1].value += (fields[fields.length - 1].value ? " " : "") + line;
  }
  return fields;
}

function field(fields, ...names) {
  for (const n of names) {
    const f = fields.find((x) => x.label.toLowerCase() === n && x.value);
    if (f) return f.value;
  }
  return "";
}
// Forms that don't record who's signed in send "anonymous" as the responder.
const ANON = /^anonymous$/i;

async function graphJson(url, token, extraHeaders) {
  const res = await fetch(url, { headers: Object.assign({ Authorization: `Bearer ${token}` }, extraHeaders || {}) });
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error.message || msg; } catch (e) { /* not JSON */ }
    const err = new Error(res.status === 401 || res.status === 403
      ? `Not allowed to read ${MAILBOX} (Microsoft said ${res.status}). Check that Mail.Read has admin consent and, if it's limited to certain mailboxes, that this one is included.`
      : res.status === 404 ? `There's no Microsoft 365 mailbox called ${MAILBOX}. Check IT_REQUESTS_MAILBOX.` : `Microsoft 365 returned ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Form emails from the last two weeks, newest first, parsed. Lists mail by
 * date (every folder except Sent Items, so an Outlook rule that files them
 * away is fine) and matches the subject here — Outlook's search ignores
 * common words like "it" and can lag, so it isn't used. Only messages not in
 * `skipIds` are opened to read the body. Returns { matched, items }.
 */
async function fetchItRequests(skipIds) {
  if (!itRequestsConfigured) return { matched: 0, items: [] };
  const skip = skipIds || new Set();
  const token = await getAccessToken();
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}`;
  let sentId = "";
  try { sentId = (await graphJson(`${base}/mailFolders/sentitems?$select=id`, token)).id || ""; } catch (e) { if (e.status === 401 || e.status === 403 || e.status === 404) throw e; }

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();
  const list = new URL(`${base}/messages`);
  list.searchParams.set("$filter", `receivedDateTime ge ${since}`);
  list.searchParams.set("$orderby", "receivedDateTime desc");
  list.searchParams.set("$select", "id,subject,receivedDateTime,parentFolderId,bodyPreview");
  list.searchParams.set("$top", "100");
  const matches = [];
  let next = list.toString(), pages = 0;
  while (next && pages < 10) {
    const page = await graphJson(next, token);
    for (const m of page.value || []) {
      if (m.parentFolderId && m.parentFolderId === sentId) continue;
      // The subject, or — if the flow's subject came through empty — a body
      // that starts with the flow's "Response ID:" line.
      if (isItRequestSubject(m.subject) || RESPONSE_LINE.test(m.bodyPreview || "")) matches.push(m);
    }
    next = page["@odata.nextLink"] || null;
    pages++;
  }

  const items = [];
  const checked = [];
  for (const m of matches) {
    if (skip.has(m.id)) continue;
    checked.push(m.id);
    const full = await graphJson(`${base}/messages/${encodeURIComponent(m.id)}?$select=id,subject,body,receivedDateTime`, token, { Prefer: 'outlook.body-content-type="text"' });
    const fields = parseFields(full.body && full.body.content);
    const urgent = field(fields, "urgent", "urgency", "priority", "what is the urgency of this issue?");
    const issue = field(fields, "details", "issue", "please describe the it issue you are having here:", "description");
    // Without the [IT Request] brackets, only the flow's emails count (they
    // carry a Response ID line), not someone's email titled "IT request ...".
    if (!/^\s*\[\s*it\s+request\s*\]/i.test(full.subject || "") && !field(fields, "response id")) continue;
    items.push({
      messageId: m.id,
      responseId: field(fields, "response id"),
      // Title: the subject after the tag, else the start of the details.
      title: String(full.subject || "").replace(SUBJECT_RE, "").trim() || issue.split(/[.!?\n]/)[0].trim().slice(0, 100) || "IT request",
      requester: [field(fields, "full name", "name"), field(fields, "email", "requested by", "requester")].filter((v) => v && !ANON.test(v))[0] || "",
      urgent: /^(yes|true|urgent|high|immediate)/i.test(urgent),
      fields: fields.filter((f) => !/^response id$/i.test(f.label)),
      receivedAt: full.receivedDateTime || m.receivedDateTime,
    });
  }
  items.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  return { matched: matches.length, items, checked };
}

// ---- Request history (the IT page's Requests tab) ----
// One record per form response, from the one-time Excel import or from the
// emails above. Records share an id ("form-<response number>"), so a
// response is never listed twice.

const OFFICE_IANA = (() => {
  const tz = process.env.OFFICE_TIMEZONE || "Pacific Standard Time";
  return WINDOWS_TO_IANA[tz] || tz;
})();

// "YYYY-MM-DD HH:MM" in office time, the same way the Forms export shows it.
function officeStamp(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: OFFICE_IANA, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const clean = (v, n) => String(v == null ? "" : v).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
// "Immediate (needs resolution now)" -> "Immediate"
const shortUrgency = (v) => clean(String(v || "").split("(")[0], 40);

// Which answer is which, by the wording of the question.
const KINDS = [
  ["name", (h) => h === "full name" || h === "name" || h === "requested by" || h === "requester"],
  ["email", (h) => h.startsWith("email")],
  ["phone", (h) => h.includes("phone")],
  ["company", (h) => h.includes("company")],
  ["remote", (h) => h.includes("remote")],
  ["issue", (h) => h.includes("describe") || h === "details" || h === "issue"],
  ["startedOn", (h) => h.includes("first start") || h.includes("when did")],
  ["urgency", (h) => h.includes("urgen") || h === "priority"],
  ["contact", (h) => h.includes("contacted") || h === "contact"],
  ["notes", (h) => h.includes("notes") || h.includes("comment")],
];
function kindOf(label) {
  const h = clean(label, 200).toLowerCase().replace(/[?:]+$/, "");
  const k = KINDS.find(([, test]) => test(h));
  return k ? k[0] : null;
}

const LIMITS = { name: 80, email: 120, phone: 40, company: 40, remote: 10, issue: 1000, startedOn: 10, urgency: 40, contact: 60, notes: 1000 };
function blankRecord() {
  return { name: "", email: "", phone: "", company: "", remote: "", issue: "", startedOn: "", urgency: "", contact: "", notes: "" };
}

function setKind(rec, kind, value) {
  if (!kind || value == null || value === "") return;
  if (kind === "startedOn") {
    const d = value instanceof Date ? value : new Date(value);
    rec.startedOn = isNaN(d) ? clean(value, 10) : d.toISOString().slice(0, 10);
    return;
  }
  let v = clean(value, LIMITS[kind]);
  if (kind === "urgency") v = shortUrgency(v);
  if ((kind === "name" || kind === "email") && ANON.test(v)) return;
  // A requester given as an email address fills both.
  if (kind === "name" && v.includes("@")) { if (!rec.email) rec.email = v; if (rec.name) return; }
  if (kind === "email" && !v.includes("@")) return; // e.g. "anonymous"
  if (!rec[kind]) rec[kind] = v;
}

class FormFileError extends Error {}

// ---- Reading the .xlsx ----
// Forms exports write their XML with namespace prefixes ("x:row") that
// common Excel libraries don't read, so this is a small reader for what a
// Forms export contains: one sheet of text, numbers and dates.

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function xmlText(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENTITIES[e] != null ? XML_ENTITIES[e] : m;
  });
}
// Text of every <t> inside a fragment (handles rich-text runs).
function allText(fragment) {
  let out = "";
  for (const m of fragment.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) out += xmlText(m[1]);
  return out;
}
function colIndex(ref) {
  let n = 0;
  for (const ch of String(ref).replace(/\d+$/, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function readFirstSheet(buffer) {
  const JSZip = require("jszip");
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch (e) { throw new FormFileError("That file isn't an Excel (.xlsx) workbook."); }
  const read = async (path) => { const f = zip.file(path.replace(/^\//, "")); return f ? f.async("string") : ""; };

  // First sheet listed in the workbook, via its relationship.
  const wbXml = await read("xl/workbook.xml");
  const rels = await read("xl/_rels/workbook.xml.rels");
  const firstRid = (wbXml.match(/<(?:\w+:)?sheet\s[^>]*r:id="([^"]+)"/) || [])[1];
  let sheetPath = "xl/worksheets/sheet1.xml";
  if (firstRid) {
    const rel = [...rels.matchAll(/<Relationship\s[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${firstRid}"`));
    const target = rel && (rel.match(/Target="([^"]+)"/) || [])[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
  }
  const sheet = await read(sheetPath);
  if (!sheet) throw new FormFileError("That workbook has no sheet to read.");

  const shared = [];
  const ss = await read("xl/sharedStrings.xml");
  for (const m of ss.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)) shared.push(allText(m[1]));

  const rows = [];
  for (const rm of sheet.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = cm[1], inner = cm[2] || "";
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const type = (attrs.match(/\bt="(\w+)"/) || [])[1] || "n";
      const raw = (inner.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/) || [])[1];
      let value = "";
      if (type === "s") value = raw != null ? shared[parseInt(raw, 10)] || "" : "";
      else if (type === "inlineStr") value = allText(inner);
      else if (type === "str" || type === "e") value = raw != null ? xmlText(raw) : "";
      else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
      else value = raw != null && raw !== "" ? Number(raw) : "";
      row[ref ? colIndex(ref) : row.length] = value;
    }
    rows.push(row);
  }
  return rows;
}

// Excel date serials (days since 1899-12-30) as "YYYY-MM-DD HH:MM". Forms
// writes office time with no zone, so this keeps it exactly as shown.
function serialStamp(v) {
  if (typeof v === "string") return clean(v, 16).replace("T", " ");
  if (typeof v !== "number" || !isFinite(v)) return "";
  const d = new Date(Math.round((v - 25569) * 864e5));
  return isNaN(d) ? "" : d.toISOString().slice(0, 16).replace("T", " ");
}

/** Records from the Forms "Open results in Excel" download. */
async function parseFormWorkbook(buffer) {
  const rows = await readFirstSheet(buffer);
  const header = (rows[0] || []).map((v) => clean(v, 200));
  const col = (name) => header.findIndex((h) => h && h.toLowerCase() === name);
  const idCol = col("id");
  const timeCol = col("completion time") >= 0 ? col("completion time") : col("start time");
  if (idCol < 0) throw new FormFileError("This doesn't look like a Microsoft Forms export (no ID column).");
  const kinds = header.map((h, i) => (i === idCol || i === timeCol || !h ? null : kindOf(h)));
  const records = [];
  for (const row of rows.slice(1)) {
    const formId = parseInt(row[idCol], 10);
    if (!formId) continue;
    const rec = Object.assign(blankRecord(), {
      id: `form-${formId}`,
      formId,
      submittedAt: timeCol >= 0 ? serialStamp(row[timeCol]) : "",
      source: "import",
    });
    kinds.forEach((k, i) => {
      if (!k) return;
      const v = row[i];
      setKind(rec, k, k === "startedOn" && typeof v === "number" ? serialStamp(v).slice(0, 10) : v);
    });
    records.push(rec);
  }
  return records;
}

/** A record for a request that came in by email (see fetchItRequests). */
function recordFromEmail(r) {
  const formId = parseInt(r.responseId, 10) || null;
  const rec = Object.assign(blankRecord(), {
    id: formId ? `form-${formId}` : `mail-${r.messageId}`,
    formId,
    submittedAt: officeStamp(r.receivedAt),
    source: "email",
  });
  for (const f of r.fields) setKind(rec, kindOf(f.label), f.value);
  if (!rec.issue) rec.issue = clean(r.title, LIMITS.issue);
  return rec;
}

module.exports = {
  itRequestsConfigured, fetchItRequests, isItRequestSubject, parseFields, IT_REQUESTS_MAILBOX: MAILBOX,
  parseFormWorkbook, recordFromEmail, FormFileError, officeStamp,
};

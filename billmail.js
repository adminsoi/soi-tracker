// Finance → Approvals → "Bills from email": invoice emails found in chosen
// Outlook mailboxes (Mark's, a shared AP inbox) through Microsoft Graph, so a
// bill that only ever arrived by email still reaches Daily payments.
//
// Which mailboxes, which senders always count (e.g. a supplier who sends AP
// lists) and how far back are set by an admin in /admin.html → "Bills from
// email" (settings.billMail). A message counts when it has a PDF or
// spreadsheet attached and the subject or file name looks like a bill, or
// when it's from one of the always-count senders.
//
// Each attachment is read once by Claude on Bedrock (bedrock.js, SOI's own
// AWS account) to pre-fill vendor, invoice number, amount and due date; an
// AP list can give several bills. Nothing is decided automatically: someone
// in Finance checks the numbers and clicks Add to bills (a normal Daily
// payments row), Paid already — records only, or Not a bill.
//
// The emails and files stay in Outlook. bill_mail.json keeps what was read
// and what was decided: { items: { [key]: item }, scans: { [mailbox]: iso } }.

const { graphConfigured, getAccessToken } = require("./graph");
const { invoke, AiError } = require("./bedrock");

const MAX_LIST = 1500; // messages read per mailbox per scan
const MAX_READ = 15; // attachments read by Claude per scan
const MAX_FILE = 8 * 1024 * 1024; // larger attachments are listed, not read
const BILL_WORDS = /invoice|\binv\b|\bbill\b|bills|payable|\bAP\b|statement of account|payment request|amount due|remittance/i;

const PDF = /\.pdf$/i;
const SHEET = /\.(xlsx|csv)$/i;

class BillMailError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 0;
  }
}

const lc = (s) => String(s || "").trim().toLowerCase();
const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

/** settings.billMail, tidied: { company, mailboxes, senders, days }. */
function billSettings(s) {
  const b = (s && s.billMail) || {};
  const list = (v) => [...new Set((Array.isArray(v) ? v : String(v || "").split(/[\s,;]+/)).map(lc).filter(Boolean))];
  return {
    company: String(b.company || "SOI Aviation"),
    mailboxes: list(b.mailboxes).filter((m) => EMAIL.test(m)).slice(0, 10),
    // An address, or "@domain" for everyone at a company.
    senders: list(b.senders).filter((m) => EMAIL.test(m) || /^@[^\s@]+\.[^\s@]+$/.test(m)).slice(0, 50),
    days: Math.min(120, Math.max(1, Math.round(Number(b.days) || 30))),
  };
}

function senderMatches(cfg, address) {
  const a = lc(address);
  return !!a && cfg.senders.some((s) => (s.startsWith("@") ? a.endsWith(s) : a === s));
}

async function graph(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error.message || msg; } catch (e) { /* not JSON */ }
    throw new BillMailError(res.status === 401 || res.status === 403
      ? "The tracker isn't allowed to read this mailbox. Mail.Read needs admin consent and, if it's limited to certain mailboxes, this one has to be in that access policy."
      : res.status === 404 ? "There's no Microsoft 365 mailbox with that address." : `Microsoft 365 returned ${res.status}: ${msg}`, res.status);
  }
  return res.json();
}

const mbox = (m) => `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m)}`;

/** Recent messages in one mailbox (every folder but Sent / Drafts / Deleted). */
async function listMessages(mailbox, since, token) {
  const skip = new Set();
  for (const f of ["sentitems", "drafts", "deleteditems", "junkemail"]) {
    try { skip.add((await graph(`${mbox(mailbox)}/mailFolders/${f}?$select=id`, token)).id); } catch (e) { if (e.status === 401 || e.status === 403) throw e; }
  }
  const url = new URL(`${mbox(mailbox)}/messages`);
  url.searchParams.set("$filter", `receivedDateTime ge ${since}`);
  url.searchParams.set("$orderby", "receivedDateTime desc");
  url.searchParams.set("$select", "id,internetMessageId,subject,from,receivedDateTime,hasAttachments,bodyPreview,webLink,parentFolderId");
  url.searchParams.set("$top", "100");
  let next = url.toString();
  const out = [];
  while (next && out.length < MAX_LIST) {
    const page = await graph(next, token);
    out.push(...(page.value || []).filter((m) => !skip.has(m.parentFolderId)));
    next = page["@odata.nextLink"] || null;
  }
  return out;
}

async function listAttachments(mailbox, msgId, token) {
  const page = await graph(`${mbox(mailbox)}/messages/${encodeURIComponent(msgId)}/attachments?$select=id,name,contentType,size,isInline`, token);
  return (page.value || []).filter((a) => !a.isInline && a["@odata.type"] !== "#microsoft.graph.itemAttachment" && a["@odata.type"] !== "#microsoft.graph.referenceAttachment");
}

/** One attachment's bytes, as { name, contentType, buffer }. */
async function fetchAttachment(mailbox, msgId, attId) {
  if (!graphConfigured) throw new BillMailError("Microsoft 365 isn't connected to the tracker.");
  const token = await getAccessToken();
  const a = await graph(`${mbox(mailbox)}/messages/${encodeURIComponent(msgId)}/attachments/${encodeURIComponent(attId)}`, token);
  return { name: a.name || "attachment", contentType: a.contentType || "application/octet-stream", buffer: Buffer.from(a.contentBytes || "", "base64") };
}

async function fetchBody(mailbox, msgId, token) {
  const m = await graph(`${mbox(mailbox)}/messages/${encodeURIComponent(msgId)}?$select=body`, token);
  const html = (m.body && m.body.content) || "";
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, "\n").replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 30000);
}

/**
 * New candidate items from one mailbox since `since`. `known` is the set of
 * keys already stored, so nothing is listed twice. Message ids change when
 * mail is moved between folders, so items are keyed by internetMessageId.
 */
async function scanMailbox(cfg, mailbox, since, known) {
  if (!graphConfigured) throw new BillMailError("Microsoft 365 isn't connected to the tracker yet (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET).");
  const token = await getAccessToken();
  const msgs = await listMessages(mailbox, since, token);
  const items = [];
  for (const m of msgs) {
    const from = { name: (m.from && m.from.emailAddress && m.from.emailAddress.name) || "", email: lc(m.from && m.from.emailAddress && m.from.emailAddress.address) };
    if (from.email === mailbox) continue; // its own mail
    const always = senderMatches(cfg, from.email);
    const subjectHit = BILL_WORDS.test(m.subject || "");
    if (!always && !(m.hasAttachments && (subjectHit || BILL_WORDS.test(m.bodyPreview || "")))) continue;
    const base = {
      mailbox, msgId: m.id, imid: m.internetMessageId || m.id, subject: String(m.subject || "(No subject)").slice(0, 300),
      from, receivedAt: m.receivedDateTime, webLink: m.webLink || "", always,
    };
    const files = m.hasAttachments ? (await listAttachments(mailbox, m.id, token)).filter((a) => PDF.test(a.name || "") || SHEET.test(a.name || "") || /pdf/i.test(a.contentType || "")) : [];
    // Without "invoice" in the subject, a file still has to be named like a bill.
    const useful = always || subjectHit ? files : files.filter((a) => BILL_WORDS.test(a.name || ""));
    if (useful.length) {
      for (const a of useful.slice(0, 10)) {
        const key = `${base.imid}|${a.name}`; // the same email in two mailboxes is listed once
        if (known.has(key)) continue;
        items.push(Object.assign({ key, file: { id: a.id, name: String(a.name || "attachment").slice(0, 200), size: a.size || 0, type: SHEET.test(a.name || "") ? "sheet" : "pdf" } }, base));
      }
    } else if (always) {
      // An always-count sender with the list in the email itself.
      const key = `${base.imid}|body`;
      if (!known.has(key)) items.push(Object.assign({ key, file: null }, base));
    }
  }
  return items;
}

// ---- Reading the bill with Claude ----

const READ_SYSTEM = `You read supplier bills for an aircraft-parts distributor's accounts payable team. You are given one email attachment (or email text). Work out which bills it asks the company to pay.

Answer with JSON only, no prose, in exactly this shape:
{"kind":"invoice"|"ap_list"|"statement"|"receipt"|"not_a_bill","bills":[{"vendor":"","invoiceNo":"","amount":0,"currency":"USD","due":"YYYY-MM-DD","invoiceDate":"YYYY-MM-DD","paid":false}]}

Rules:
- "invoice": one bill. "ap_list": a list of several bills or payment requests (one entry per line to pay). "statement": an account statement (list the open invoices on it). "receipt": a paid receipt or proof of payment (set paid true). "not_a_bill": anything else (bills: []).
- vendor is who is asking to be paid (the supplier), not the company being billed.
- amount is the total still to pay for that bill as a plain number, no symbols or commas. If unclear, 0.
- Dates as YYYY-MM-DD, or "" if not shown. Never guess a due date from payment terms unless the terms and invoice date are both shown (e.g. Net 30 from the invoice date).
- Copy invoice numbers exactly. Never invent numbers, amounts, part numbers or certificate numbers. Leave a field "" (or 0) rather than guess.
- At most 60 bills.`;

function parseJson(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
const money = (v) => {
  const n = Number(String(v == null ? "" : v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const txt = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);

function cleanBills(out) {
  const kinds = ["invoice", "ap_list", "statement", "receipt", "not_a_bill"];
  const kind = kinds.includes(out && out.kind) ? out.kind : "invoice";
  const bills = (Array.isArray(out && out.bills) ? out.bills : []).slice(0, 60).map((b) => ({
    vendor: txt(b.vendor, 120), invoiceNo: txt(b.invoiceNo, 60), amount: money(b.amount),
    currency: txt(b.currency, 3).toUpperCase() || "USD", due: date(b.due), invoiceDate: date(b.invoiceDate), paid: !!b.paid,
  }));
  return { kind, bills };
}

function sheetText(rows) {
  return rows.slice(0, 400).map((r) => (r || []).map((v) => (v == null ? "" : String(v))).join("\t")).join("\n").slice(0, 40000);
}

/**
 * What one item asks to be paid: { kind, bills } read by Claude. The file
 * (or the email text) is sent to Bedrock in SOI's AWS account only.
 */
async function readBills(item) {
  const token = graphConfigured ? await getAccessToken() : null;
  if (!token) throw new BillMailError("Microsoft 365 isn't connected to the tracker.");
  const intro = `Email subject: ${item.subject}\nFrom: ${item.from.name} <${item.from.email}>\nReceived: ${item.receivedAt}\n`;
  let content;
  if (!item.file) {
    content = [{ type: "text", text: `${intro}\nEmail text:\n${await fetchBody(item.mailbox, item.msgId, token)}` }];
  } else {
    if (item.file.size > MAX_FILE) throw new BillMailError("The file is too big to read automatically.");
    const a = await fetchAttachment(item.mailbox, item.msgId, item.file.id);
    if (item.file.type === "sheet") {
      let rows;
      if (/\.csv$/i.test(item.file.name)) rows = a.buffer.toString("utf8").split(/\r?\n/).map((l) => l.split(","));
      else rows = await require("./itrequests").readFirstSheet(a.buffer);
      content = [{ type: "text", text: `${intro}Attachment ${item.file.name} (first sheet, tab-separated):\n${sheetText(rows)}` }];
    } else {
      content = [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.buffer.toString("base64") } },
        { type: "text", text: `${intro}Attachment: ${item.file.name}` },
      ];
    }
  }
  const out = await invoke({ max_tokens: 4000, system: READ_SYSTEM, messages: [{ role: "user", content }] });
  const text = (out.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = parseJson(text);
  if (!parsed) throw new BillMailError("Claude couldn't make sense of the file.");
  return cleanBills(parsed);
}

module.exports = { billSettings, senderMatches, scanMailbox, readBills, fetchAttachment, cleanBills, BillMailError, AiError, MAX_READ, BILL_WORDS };

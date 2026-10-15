// IT requests from the Microsoft Form. The Power Automate flow emails each
// response to IT_REQUESTS_MAILBOX with a subject starting "[IT Request]" and
// a body of "Label: value" lines. The tracker can't be reached from
// Microsoft's cloud, so instead it reads those emails through Microsoft
// Graph (Mail.Read, the same permission as the Work inbox) and index.js
// turns each new one into an IT task. Read-only: nothing in the mailbox is
// changed.

const { graphConfigured, getAccessToken } = require("./graph");

const MAILBOX = String(process.env.IT_REQUESTS_MAILBOX || "").trim();
const TAG = "[IT Request]";
const LOOKBACK_DAYS = 14;

const itRequestsConfigured = graphConfigured && !!MAILBOX;

function isItRequestSubject(subject) {
  return String(subject || "").trim().toLowerCase().startsWith(TAG.toLowerCase());
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
  const f = fields.find((x) => names.some((n) => x.label.toLowerCase() === n));
  return f ? f.value : "";
}

/** Form emails from the last two weeks, newest first, parsed. */
async function fetchItRequests() {
  if (!itRequestsConfigured) return [];
  const token = await getAccessToken();
  const url = new URL(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages`);
  // Search every folder, so an Outlook rule that files these away is fine.
  url.searchParams.set("$search", '"subject:IT Request"');
  url.searchParams.set("$select", "id,subject,body,receivedDateTime,webLink");
  url.searchParams.set("$top", "50");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const since = Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000;
  return (data.value || [])
    .filter((m) => isItRequestSubject(m.subject) && Date.parse(m.receivedDateTime) >= since)
    .map((m) => {
      const fields = parseFields(m.body && m.body.content);
      const urgent = field(fields, "urgent", "urgency", "priority");
      return {
        messageId: m.id,
        responseId: field(fields, "response id"),
        title: String(m.subject).trim().slice(TAG.length).replace(/^[\s:—-]+/, "").trim() || "IT request",
        requester: field(fields, "requested by", "requester", "name", "email"),
        urgent: /^(yes|true|urgent|high)/i.test(urgent),
        fields: fields.filter((f) => !/^response id$/i.test(f.label)),
        receivedAt: m.receivedDateTime,
      };
    })
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
}

module.exports = { itRequestsConfigured, fetchItRequests, isItRequestSubject, parseFields, IT_REQUESTS_MAILBOX: MAILBOX };

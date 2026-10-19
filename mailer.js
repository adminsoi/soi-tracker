// Sends mail via Microsoft Graph using an app-only (client credentials)
// token — no signed-in mailbox needed, just an Azure AD app registration
// with Mail.Send application permission and admin consent granted.
//
// Required env vars: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET,
// MS_FROM_EMAIL (the mailbox Graph will send as — a real mailbox in your
// tenant, e.g. a shared mailbox like notifications@soiaviation.com).
//
// If these aren't set, sendMail() logs a warning and does nothing instead
// of failing — email notifications are a nice-to-have, not something that
// should ever block someone from creating or updating a task.

const { graphConfigured, getAccessToken } = require("./graph");

const FROM_EMAIL = process.env.MS_FROM_EMAIL;

const configured = Boolean(graphConfigured && FROM_EMAIL);
if (!configured) {
  console.warn(
    "Email notifications are not configured (missing one or more of MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_FROM_EMAIL) — task-assignment emails will be skipped."
  );
}

// replyTo: where replies go — one address or a list (e.g. the person who
// resolved a ticket and the IT mailbox the tracker reads).
// Returns true when sent, false when email isn't set up.
async function sendMail({ to, subject, html, replyTo, saveCopy }) {
  if (!configured || !to) return false;

  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(FROM_EMAIL)}/sendMail`;
  const payload = {
    message: {
      subject,
      body: { contentType: "HTML", content: html },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: !!saveCopy,
  };
  const replyList = [...new Set([].concat(replyTo || []).map((a) => String(a || "").trim().toLowerCase()).filter(Boolean))];
  if (replyList.length) payload.message.replyTo = replyList.map((address) => ({ emailAddress: { address } }));

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph sendMail failed (${res.status}): ${text}`);
  }
  return true;
}

module.exports = { sendMail, mailConfigured: configured };

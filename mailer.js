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

const TENANT_ID = process.env.MS_TENANT_ID;
const CLIENT_ID = process.env.MS_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const FROM_EMAIL = process.env.MS_FROM_EMAIL;

const configured = Boolean(TENANT_ID && CLIENT_ID && CLIENT_SECRET && FROM_EMAIL);
if (!configured) {
  console.warn(
    "Email notifications are not configured (missing one or more of MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_FROM_EMAIL) — task-assignment emails will be skipped."
  );
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;

  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Failed to get Graph token: ${data.error_description || JSON.stringify(data)}`);
  }
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function sendMail({ to, subject, html }) {
  if (!configured || !to) return;

  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(FROM_EMAIL)}/sendMail`;
  const payload = {
    message: {
      subject,
      body: { contentType: "HTML", content: html },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: false,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph sendMail failed (${res.status}): ${text}`);
  }
}

module.exports = { sendMail };

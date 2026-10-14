// Microsoft Graph access for the tracker, using an app-only (client
// credentials) token from the Azure AD app registration in MS_TENANT_ID /
// MS_CLIENT_ID / MS_CLIENT_SECRET. Shared by mailer.js (Mail.Send) and
// calendar.js (Calendars.Read). Each feature needs its own application
// permission, with admin consent, on that app registration.

const TENANT_ID = process.env.MS_TENANT_ID;
const CLIENT_ID = process.env.MS_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET;

const graphConfigured = Boolean(TENANT_ID && CLIENT_ID && CLIENT_SECRET);

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

module.exports = { graphConfigured, getAccessToken };

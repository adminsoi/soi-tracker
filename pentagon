// Thin client for Pentagon's internal query API. Every query follows the
// same shape (POST to /api/query/<name> with an API key header and a JSON
// body), so this one function handles all of them — new queries just need
// a name and a body, no new backend code.

const PENTAGON_API_URL = process.env.PENTAGON_API_URL;
const PENTAGON_API_KEY = process.env.PENTAGON_API_KEY;

const configured = Boolean(PENTAGON_API_URL && PENTAGON_API_KEY);
if (!configured) {
  console.warn(
    "Pentagon API is not configured (missing PENTAGON_API_URL or PENTAGON_API_KEY) — Pentagon-backed features will return an error until this is set."
  );
}

async function pentagonQuery(queryName, body) {
  if (!configured) {
    throw new Error("Pentagon API is not configured on this server");
  }

  const url = `${PENTAGON_API_URL.replace(/\/+$/, "")}/api/query/${encodeURIComponent(queryName)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-API-Key": PENTAGON_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    // fall through with data = null; handled below
  }

  if (!res.ok) {
    throw new Error(
      `Pentagon query "${queryName}" failed (${res.status}): ${data ? JSON.stringify(data) : "no response body"}`
    );
  }

  return data;
}

module.exports = { pentagonQuery };

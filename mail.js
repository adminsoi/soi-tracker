// Work inbox: a person's own Outlook inbox (read and unread), read-only, through
// Microsoft Graph with the app registration in graph.js. Needs the Mail.Read
// application permission (admin consent), ideally scoped to SOI staff
// mailboxes. The mailbox is always the email on the signed-in person's login
// — never one sent by the browser.
//
// No AI: each conversation shows Outlook's own preview text, and is sorted
// into "Needs you" / "FYI" by simple rules. Nothing is stored; results are
// cached in memory for a minute so refreshing doesn't re-read the mailbox.

const { graphConfigured, getAccessToken } = require("./graph");
const { isItRequestSubject } = require("./itrequests");

const CACHE_MS = 60 * 1000;
const cache = new Map(); // key -> { at, value }

class MailError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sameAddress(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function person(r) {
  const e = (r && r.emailAddress) || {};
  return { name: e.name || e.address || "", email: e.address || "" };
}

async function graphGet(url) {
  const token = await getAccessToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    throw new MailError("no_permission", "The tracker's Microsoft app doesn't have permission to read mail yet. Your Microsoft 365 admin needs to add Mail.Read — see the README.");
  }
  if (res.status === 404) {
    throw new MailError("not_found", "No Microsoft 365 mailbox was found for the email on your login. Check it at /admin.html.");
  }
  if (!res.ok) {
    const text = await res.text();
    console.error(`Graph mail request failed (${res.status}): ${text.slice(0, 300)}`);
    throw new MailError("error", "Microsoft 365 didn't return your inbox. Try again in a minute.");
  }
  return res.json();
}

/**
 * Inbox messages (read and unread) from the last `days` days, one entry per
 * conversation (latest message first), each marked needsYou with a reason
 * and isRead (false while any message in it is unread in Outlook).
 */
async function inboxThreads(email, days) {
  if (!graphConfigured) {
    throw new MailError("not_configured", "Microsoft 365 isn't connected to the tracker yet (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET).");
  }
  if (!email) {
    throw new MailError("no_email", "Your login has no email address. Ask an admin to add your Microsoft 365 email at /admin.html.");
  }
  const key = `${email.toLowerCase()}|${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const url = new URL(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/mailFolders/inbox/messages`);
  // Graph wants $orderby properties to lead the $filter, in the same order.
  url.searchParams.set("$filter", `receivedDateTime ge ${since}`);
  url.searchParams.set("$orderby", "receivedDateTime desc");
  url.searchParams.set("$select", "id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,importance,flag,hasAttachments,webLink,conversationId,isRead");
  url.searchParams.set("$top", "100");

  let next = url.toString();
  const messages = [];
  while (next && messages.length < 500) {
    const page = await graphGet(next);
    messages.push(...(page.value || []));
    next = page["@odata.nextLink"] || null;
  }

  const threads = new Map();
  for (const m of messages) {
    // IT form emails become IT tasks instead (itrequests.js).
    if (isItRequestSubject(m.subject)) continue;
    const id = m.conversationId || m.id;
    const t = threads.get(id);
    if (t) {
      t.messages += 1;
      if (!m.isRead) t.unread += 1;
      if (m.hasAttachments) t.attachments = true;
      if (m.flag && m.flag.flagStatus === "flagged") t.flagged = true;
      if (m.importance === "high") t.important = true;
      continue;
    }
    const to = (m.toRecipients || []).map(person);
    const cc = (m.ccRecipients || []).map(person);
    threads.set(id, {
      id,
      subject: m.subject || "(No subject)",
      from: person(m.from),
      to,
      cc,
      receivedAt: m.receivedDateTime,
      preview: (m.bodyPreview || "").replace(/\s+/g, " ").trim().slice(0, 400),
      important: m.importance === "high",
      flagged: !!(m.flag && m.flag.flagStatus === "flagged"),
      attachments: !!m.hasAttachments,
      webLink: m.webLink || "",
      messages: 1,
      unread: m.isRead ? 0 : 1,
      toYou: to.some((r) => sameAddress(r.email, email)),
    });
  }

  // Needs you: flagged, high importance, or sent to you directly (not just CC'd).
  const items = [...threads.values()].map((t) => {
    const reasons = [];
    if (t.flagged) reasons.push("Flagged");
    if (t.important) reasons.push("High importance");
    if (t.toYou) reasons.push("Sent to you");
    return Object.assign(t, { isRead: t.unread === 0, needsYou: reasons.length > 0, reason: reasons.join(" · ") || (t.cc.some((r) => sameAddress(r.email, email)) ? "You're CC'd" : "Group or list mail") });
  });

  const value = { mailbox: email, days, since, items };
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * What follow-ups need: the last 14 days of Sent Items and a light list of
 * Inbox messages (who and when), so index.js can tell which conversations
 * are waiting on a reply from you and which are waiting on the other side.
 */
const FOLLOW_DAYS = 14;
async function followUpData(email) {
  const key = `fu|${String(email).toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const since = new Date(Date.now() - FOLLOW_DAYS * 24 * 3600 * 1000).toISOString();
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}`;
  const pages = async (url, cap) => {
    const out = [];
    let next = url.toString();
    while (next && out.length < cap) {
      const page = await graphGet(next);
      out.push(...(page.value || []));
      next = page["@odata.nextLink"] || null;
    }
    return out;
  };
  const sentUrl = new URL(`${base}/mailFolders/sentitems/messages`);
  sentUrl.searchParams.set("$filter", `sentDateTime ge ${since}`);
  sentUrl.searchParams.set("$orderby", "sentDateTime desc");
  sentUrl.searchParams.set("$select", "id,conversationId,subject,toRecipients,ccRecipients,sentDateTime,bodyPreview,webLink");
  sentUrl.searchParams.set("$top", "100");
  const inUrl = new URL(`${base}/mailFolders/inbox/messages`);
  inUrl.searchParams.set("$filter", `receivedDateTime ge ${since}`);
  inUrl.searchParams.set("$orderby", "receivedDateTime desc");
  inUrl.searchParams.set("$select", "conversationId,receivedDateTime,from");
  inUrl.searchParams.set("$top", "100");
  const [sent, inbound] = await Promise.all([pages(sentUrl, 300), pages(inUrl, 500)]);
  const value = {
    sent: sent.map((m) => ({
      id: m.id, conv: m.conversationId || m.id, subject: m.subject || "(No subject)", at: m.sentDateTime,
      to: (m.toRecipients || []).map(person), cc: (m.ccRecipients || []).map(person),
      preview: (m.bodyPreview || "").replace(/\s+/g, " ").trim().slice(0, 400), webLink: m.webLink || "",
    })),
    inbound: inbound.map((m) => ({ conv: m.conversationId || "", at: m.receivedDateTime, from: person(m.from) })),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { inboxThreads, followUpData, MailError };

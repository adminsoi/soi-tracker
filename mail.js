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
// The Unread / Read list reads at most this many messages per inbox (newest
// first). Busy shared inboxes say so on the page.
const MAX_LIST = 1000;
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

async function graphGet(url, extraHeaders) {
  const token = await getAccessToken();
  const res = await fetch(url, { headers: Object.assign({ Authorization: `Bearer ${token}` }, extraHeaders || {}) });
  // A delta link Microsoft no longer recognises: start that folder over.
  if (res.status === 410) throw new MailError("resync", "Mail sync needs to start over.");
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
  while (next && messages.length < MAX_LIST) {
    const page = await graphGet(next);
    messages.push(...(page.value || []));
    next = page["@odata.nextLink"] || null;
  }

  const capped = !!next; // more mail in the window than we read
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

  const value = { mailbox: email, days, since, items, capped };
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Customer follow-up index for one mailbox, kept up to date with Microsoft
 * Graph delta queries: the first run reads the last 14 days of Inbox and
 * Sent Items (sender, recipients, time, subject only); later runs read only
 * what changed since. Busy inboxes (thousands a week) stay cheap.
 *
 * idx = { inboxDelta, sentDelta, syncedAt, convs: { [conversationId]: {
 *   in:  latest customer email { at, from, subject, link, to, direct },
 *   out: latest thing sent back { at, subject, link, cust } } } }
 * isCustomer(address) says who counts as a customer. Mutates idx.
 */
const FOLLOW_DAYS = 14;
async function syncFollowIndex(mailbox, idx, isCustomer) {
  const since = new Date(Date.now() - FOLLOW_DAYS * 24 * 3600 * 1000).toISOString();
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders`;
  const local = String(mailbox).split("@")[0].toLowerCase();
  idx.convs = idx.convs && typeof idx.convs === "object" ? idx.convs : {};
  const start = (folder) => {
    const u = new URL(`${base}/${folder}/messages/delta`);
    u.searchParams.set("$select", "conversationId,receivedDateTime,sentDateTime,from,toRecipients,ccRecipients,subject,webLink");
    u.searchParams.set("$filter", `receivedDateTime ge ${since}`);
    return u.toString();
  };
  const run = async (folder, linkKey, each) => {
    let next = idx[linkKey] || start(folder), pages = 0;
    for (;;) {
      let page;
      try {
        page = await graphGet(next, { Prefer: "odata.maxpagesize=200" });
      } catch (err) {
        if (err.code === "resync" && idx[linkKey]) { idx[linkKey] = ""; next = start(folder); continue; }
        throw err;
      }
      for (const m of page.value || []) if (!m["@removed"] && m.conversationId) each(m);
      if (page["@odata.deltaLink"]) { idx[linkKey] = page["@odata.deltaLink"]; return; }
      next = page["@odata.nextLink"];
      if (!next || ++pages > 300) return; // keep the old link; carry on next time
    }
  };
  // Inbox first, so a reply in the same run finds its conversation.
  await run("inbox", "inboxDelta", (m) => {
    const from = person(m.from);
    if (!isCustomer(from.email)) return;
    const to = (m.toRecipients || []).map((r) => String((r.emailAddress || {}).address || "").toLowerCase());
    const mine = to.find((a) => a === String(mailbox).toLowerCase() || (local && a.split("@")[0] === local));
    const e = idx.convs[m.conversationId] || (idx.convs[m.conversationId] = {});
    if (!e.in || m.receivedDateTime > e.in.at) {
      e.in = { at: m.receivedDateTime, from, subject: m.subject || "(No subject)", link: m.webLink || "", to: mine || to[0] || "", direct: !!mine };
    }
  });
  await run("sentitems", "sentDelta", (m) => {
    const recips = [...(m.toRecipients || []), ...(m.ccRecipients || [])].map(person);
    const cust = recips.find((r) => isCustomer(r.email));
    const e = idx.convs[m.conversationId];
    if (!e && !cust) return; // nothing to do with a customer
    const entry = e || (idx.convs[m.conversationId] = {});
    const at = m.sentDateTime || m.receivedDateTime;
    if (!at) return;
    if (!entry.out || at > entry.out.at) {
      entry.out = { at, subject: m.subject || "(No subject)", link: m.webLink || "", cust: cust || null };
    }
  });
  // Forget conversations with nothing in the last 14 days.
  for (const [k, e] of Object.entries(idx.convs)) {
    const last = [e.in && e.in.at, e.out && e.out.at].filter(Boolean).sort().pop() || "";
    if (last < since) delete idx.convs[k];
  }
  idx.syncedAt = Date.now();
  return idx;
}

module.exports = { inboxThreads, syncFollowIndex, MailError };

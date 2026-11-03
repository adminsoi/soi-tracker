// Improvements: anyone asks for a change to the tracker (title, description,
// which part of it, priority, an optional screenshot). Everyone sees their
// own requests; Leadership and the tracker's owners (IMPROVEMENTS_OWNERS,
// usernames or emails) see all of them, set the status and reply.
// New requests show on the owners' Mentions of You; a status change or
// reply shows on the requester's until they open Improvements.
// improvements.json: { items: [...] }; screenshots via putFile under
// improvement_files/<id>. Routes are in index.js.

const AREAS = [
  "Operations", "Administration", "Overview", "Mentions of You", "Emails", "Strategy Meeting", "SOP", "People",
  "Documents", "Chat with AOG", "Improvements", "Calendar", "Global", "Performance", "Other",
];
const PRIORITIES = [
  { id: "nice", label: "Nice to have" },
  { id: "important", label: "Important" },
  { id: "blocking", label: "Blocking" },
];
const STATUSES = [
  { id: "new", label: "New" },
  { id: "planned", label: "Planned" },
  { id: "in_progress", label: "In progress" },
  { id: "done", label: "Done" },
  { id: "wont_do", label: "Won't do" },
];
const SCREENSHOT_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const OWNERS = String(process.env.IMPROVEMENTS_OWNERS || "nyssa@soiaviation.com")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function same(a, b) { return String(a || "").toLowerCase() === String(b || "").toLowerCase(); }
function text(v, max) { return String(v == null ? "" : v).replace(/\r\n/g, "\n").trim().slice(0, max); }

// raw: the login from users.json (it has the email; req.user doesn't).
function isOwner(user, raw) {
  const ids = [user && user.username, raw && raw.email].map((s) => String(s || "").toLowerCase()).filter(Boolean);
  return ids.some((id) => OWNERS.includes(id));
}
function canManage(user, raw) { return !!(user && user.leadership) || isOwner(user, raw); }

function shape(doc) {
  if (!Array.isArray(doc.items)) doc.items = [];
  return doc;
}

// A new request from the form. Returns { item } or { error }.
function newItem(body, username, id, now) {
  const b = body || {};
  const title = text(b.title, 160);
  const description = text(b.description, 5000);
  if (!title) return { error: "Give it a short title" };
  if (!description) return { error: "Describe what you'd like changed" };
  const area = AREAS.includes(b.area) ? b.area : "";
  if (!area) return { error: "Pick which part of the tracker it's about" };
  const priority = PRIORITIES.some((p) => p.id === b.priority) ? b.priority : "";
  if (!priority) return { error: "Pick a priority" };
  return { item: { id, title, description, area, priority, status: "new", by: username, at: now, updatedAt: now, screenshot: null, log: [], bySeenAt: now } };
}

// A status change and/or reply by Leadership or an owner. Changes `item` in
// place; returns { entry } or { error }.
function applyUpdate(item, body, username, id, now) {
  const b = body || {};
  const status = b.status == null || b.status === "" ? item.status : String(b.status);
  if (!STATUSES.some((s) => s.id === status)) return { error: "That isn't a status" };
  const reply = text(b.reply, 3000);
  if (status === item.status && !reply) return { error: "Change the status or write a reply" };
  const entry = { id, by: username, at: now };
  if (status !== item.status) { entry.from = item.status; entry.status = status; item.status = status; }
  if (reply) entry.text = reply;
  item.log = Array.isArray(item.log) ? item.log : [];
  item.log.push(entry);
  item.updatedAt = now;
  return { entry };
}

// The requester hasn't seen a change someone else made since they last
// opened Improvements.
function unseenUpdate(item) {
  return (item.log || []).some((e) => !same(e.by, item.by) && e.at > (item.bySeenAt || 0));
}

// What one login sees: their own requests, or everything if they manage.
function view(doc, user, raw) {
  const manage = canManage(user, raw);
  const owner = isOwner(user, raw);
  const items = shape(doc).items
    .filter((x) => manage || same(x.by, user.username))
    .map((x) => Object.assign({}, x, {
      mine: same(x.by, user.username),
      unseen: same(x.by, user.username) && unseenUpdate(x),
    }))
    .sort((a, b) => b.at - a.at);
  return {
    canManage: manage, owner, areas: AREAS, priorities: PRIORITIES, statuses: STATUSES, items,
    // For Mentions of You: new requests (owners) and replies to yours.
    waiting: owner ? items.filter((x) => x.status === "new").length : 0,
    updates: items.filter((x) => x.unseen).length,
  };
}

module.exports = { AREAS, PRIORITIES, STATUSES, SCREENSHOT_TYPES, OWNERS, isOwner, canManage, shape, newItem, applyUpdate, unseenUpdate, view };

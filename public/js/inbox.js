"use strict";
// Work inbox.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---------- Work inbox ----------
// Your Outlook inbox, read-only, one row per conversation with Outlook's
// preview text (no AI). Unread and Read tabs follow Outlook: open a
// conversation in Outlook and it moves to Read on the next check. Inside
// each tab, rows are grouped by day, newest first. "Needs you" = sent to
// you directly, flagged or high importance; everything else is FYI (you're
// CC'd, or it went to a group or list).
var inboxDays = 3, inboxData = null, inboxError = null, inboxNeeds = 0, inboxSig = "";
var inboxBox = "all";      // "all", or one mailbox address (tabs when there's more than one)
var inboxRead = "unread";  // unread | read | follow
// "2h", "3d" for follow-up ages.
function fuAge(h) { return h < 24 ? h + "h" : Math.floor(h / 24) + "d"; }
function fuTag(t) {
  var f = t.followUp;
  if (!f) return "";
  if (f.kind === "waiting") return '<span class="fu-tag waiting" title="You emailed ' + E(f.who.email || "") + ' — no reply yet">No reply · ' + fuAge(f.hours) + "</span>";
  return '<span class="fu-tag reply' + (f.overdue ? " overdue" : "") + '" title="' + E((f.who.name || f.who.email) + " is waiting on a reply") + '">' + (f.overdue ? "Overdue · " : "Needs reply · ") + fuAge(f.hours) + "</span>";
}
var inboxKind = "all";     // all | needs | fyi
var inboxOpen = {};        // expanded rows
var inboxShow = 200;       // rows drawn; "Show more" adds 200
var inboxCo = "";          // company filter for shared inboxes ("" = all)
var INBOX_CO_NAME = { SOI: "SOI", CAS: "CAS", RedSun: "Red Sun", NanoTech: "Nanotech" };
// A coloured tag for the company address a shared-inbox email was sent to.
function inboxCoTag(t, long) {
  if (!t.company) return "";
  var c = (inboxData.colors || {})[t.company] || "#948575";
  return '<span class="ib-co" style="--co:' + E(c) + '" title="Sent to ' + E(t.sentTo || "") + '">' + E(INBOX_CO_NAME[t.company] || t.company) + (long && t.sentTo ? " · " + E(t.sentTo) : "") + "</span>";
}
function boxLabel(m) { return inboxData && m === inboxData.mailbox ? "Mine" : String(m).split("@")[0] + "@"; }

function renderInbox() {
  setBreadcrumb(["You", "Emails"]);
  setTimeout(function () { loadInbox(false); }, 0);
  var several = inboxData && inboxData.mailboxes && inboxData.mailboxes.length > 1;
  return '<div class="intro"><div><div class="eyebrow">Outlook' + (inboxData ? " · " + E(several ? inboxData.mailboxes.length + " inboxes" : inboxData.mailbox) : "") + '</div><h1>Emails</h1>' +
    "<p>Your Outlook inbox" + (several ? " and your shared inboxes" : "") + ", newest first. Open something in Outlook and it moves to Read. Open a row to read the whole thread, reply (Draft with AI writes a first draft for you to edit) or ignore it. Nothing is sent until you click Send.</p>" +
    '<p class="small-note" id="inbox-note"></p></div>' +
    '<div class="co-wrap"><div class="eyebrow">Received in the last</div><div class="cos">' + [[1, "Day"], [3, "3 days"], [7, "Week"]].map(function (d) {
      return '<button type="button" class="co ' + (d[0] === inboxDays ? "active" : "") + '" data-inbox-days="' + d[0] + '">' + d[1] + "</button>";
    }).join("") + '</div><a class="links-a" href="https://outlook.office.com/mail/" target="_blank" rel="noopener noreferrer">Open Outlook ↗</a></div></div>' +
    '<div id="inbox-tabs"></div><div id="inbox-body"><div class="empty">Loading…</div></div>';
}

function loadInbox(quiet) {
  api("/api/inbox?days=" + inboxDays).then(function (data) {
    inboxError = null;
    var sig = JSON.stringify([data.items, data.followUps, data.followStatus]);
    var same = sig === inboxSig;
    inboxSig = sig;
    inboxData = data;
    updateInboxBadge();
    // While a follow-up list is being built, check back sooner.
    if (data.followStatus && data.followStatus.syncing && data.followStatus.syncing.length && page === "inbox") setTimeout(function () { if (page === "inbox") loadInbox(true); }, 30000);
    if (quiet && same) return;
    if (quiet && ibTyping()) { ibRedrawLater = true; return; }
    drawInbox();
  }).catch(function (err) {
    if (quiet) return;
    inboxError = err;
    var box = $("#inbox-body");
    if (box) box.innerHTML = '<div class="banner">' + E(err.message) + "</div>";
  });
}
// Sidebar count: unread conversations that need you.
function updateInboxBadge() {
  if (!inboxData) return;
  var n = inboxData.items.filter(function (t) { return t.needsYou && !t.isRead; }).length;
  if (n !== inboxNeeds) { inboxNeeds = n; renderNav(); }
}

// "Today", "Yesterday", "Monday, Oct 13".
function inboxDayLabel(d) {
  var key = ymd(d), t = new Date(); var y = new Date(); y.setDate(t.getDate() - 1);
  if (key === ymd(t)) return "Today";
  if (key === ymd(y)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function drawInbox() {
  var box = $("#inbox-body");
  if (!box || !inboxData) return;
  var boxes = inboxData.mailboxes || [inboxData.mailbox];
  if (inboxBox !== "all" && boxes.indexOf(inboxBox) === -1) inboxBox = "all";
  var inBoxAll = inboxData.items.filter(function (t) { return inboxBox === "all" || t.mailbox === inboxBox; });
  // Company filter, when a shared inbox gets mail for more than one company.
  var cosHere = {};
  inBoxAll.concat(inboxData.followUps || []).filter(function (t) { return inboxBox === "all" || t.mailbox === inboxBox; }).forEach(function (t) { if (t.company) cosHere[t.company] = (cosHere[t.company] || 0) + 1; });
  var coKeys = ["SOI", "CAS", "RedSun", "NanoTech"].filter(function (k) { return cosHere[k]; });
  if (inboxCo && !cosHere[inboxCo]) inboxCo = "";
  var inBox = inBoxAll.filter(function (t) { return !inboxCo || t.company === inboxCo; });
  var tabs = $("#inbox-tabs");
  if (tabs) {
    var unreadIn = function (m) { return inboxData.items.filter(function (t) { return (m === "all" || t.mailbox === m) && !t.isRead && !t.waiting; }).length; };
    tabs.innerHTML = boxes.length > 1 ? '<div class="tabs" role="tablist" style="margin-top:6px;">' + ["all"].concat(boxes).map(function (m) {
      var n = unreadIn(m);
      return '<button type="button" role="tab" class="tab ' + (m === inboxBox ? "active" : "") + '" aria-selected="' + (m === inboxBox) + '" data-inbox-box="' + E(m) + '" title="' + E(m === "all" ? "Every inbox together" : m) + '">' +
        E(m === "all" ? "All inboxes" : boxLabel(m)) + (n ? '<span class="badge">' + n + "</span>" : "") + "</button>";
    }).join("") + "</div>" : "";
  }
  var problems = (inboxData.errors || []).filter(function (x) { return inboxBox === "all" || x.mailbox === inboxBox; });
  var unread = inBox.filter(function (t) { return !t.isRead && !t.waiting; }), read = inBox.filter(function (t) { return t.isRead && !t.waiting; });
  // Follow-ups come from the server's follow-up list (last 14 days), not
  // just the mail in this window.
  var follow = (inboxData.followUps || []).filter(function (t) { return (inboxBox === "all" || t.mailbox === inboxBox) && (!inboxCo || t.company === inboxCo); });
  var side = inboxRead === "read" ? read : inboxRead === "follow" ? follow : unread;
  var kindOf = function (k) { return side.filter(function (t) { return k === "all" || (k === "needs") === !!t.needsYou; }); };
  var list = kindOf(inboxKind);
  var note = $("#inbox-note");
  if (note) note.textContent = "Updated " + new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + " · " + unread.length + " unread, " + read.length + " read" + (inboxData.ignored ? " · " + inboxData.ignored + " ignored (back when a new message arrives)" : "") + " · checks again every few minutes";
  ibItems = {};
  inboxData.items.concat(inboxData.followUps || []).forEach(function (t) { ibItems[ibKey(t)] = t; });

  var seg = function (cur, attr, opts) {
    return '<div class="seg">' + opts.map(function (o) {
      return '<button type="button" ' + attr + '="' + o[0] + '" class="' + (cur === o[0] ? "active" : "") + '">' + E(o[1]) + (o[2] != null ? ' <span class="ib-n">' + o[2] + "</span>" : "") + "</button>";
    }).join("") + "</div>";
  };
  var bar = '<div class="ib-bar">' + seg(inboxRead, "data-inbox-read", [["unread", "Unread", unread.length], ["read", "Read", read.length], ["follow", "Follow up", follow.length]]) +
    (inboxRead === "follow" ? "" : seg(inboxKind, "data-inbox-kind", [["all", "Everything", side.length], ["needs", "Needs you", kindOf("needs").length], ["fyi", "FYI", kindOf("fyi").length]])) +
    (coKeys.length > 1 ? '<div class="seg ib-cos"><button type="button" data-inbox-co="" class="' + (!inboxCo ? "active" : "") + '">All companies</button>' + coKeys.map(function (k) {
      return '<button type="button" data-inbox-co="' + k + '" class="' + (inboxCo === k ? "active" : "") + '"><span class="ib-swatch" style="background:' + E((inboxData.colors || {})[k] || "#948575") + '"></span>' + E(INBOX_CO_NAME[k]) + ' <span class="ib-n">' + cosHere[k] + "</span></button>";
    }).join("") + "</div>" : "") + "</div>" +
    (inboxRead === "follow"
      ? '<p class="small-note ib-legend"><span class="fu-tag reply">Needs reply</span> a customer emailed and nothing\'s been sent back yet (<span class="fu-tag reply overdue">Overdue</span> after a day). <span class="fu-tag waiting">No reply</span> you emailed a customer 2+ days ago and haven\'t heard back. Customer = anyone outside the company; last 14 days.</p>'
      : '<p class="small-note ib-legend"><span class="ib-dot needs"></span>Needs you: sent to you directly, flagged or marked important. <span class="ib-dot"></span>FYI: you\'re CC\'d, or it went to a group or list. <span class="fu-tag reply">Needs reply</span> a customer is waiting on you.</p>');

  // Group by day (items come newest first). Follow up: waiting on you,
  // then waiting on them, oldest first.
  var groups = [], cur = null;
  var more = Math.max(0, list.length - inboxShow);
  list = list.slice(0, inboxShow);
  if (inboxRead === "follow") {
    var oldest = function (a, b) { return String(a.followUp.since).localeCompare(String(b.followUp.since)); };
    var mineW = list.filter(function (t) { return t.followUp.kind === "reply"; }).sort(oldest);
    var theirs = list.filter(function (t) { return t.followUp.kind === "waiting"; }).sort(oldest);
    if (mineW.length) groups.push({ label: "Waiting on you", rows: mineW });
    if (theirs.length) groups.push({ label: "Waiting on them", rows: theirs });
    list = [];
  }
  list.forEach(function (t) {
    var label = inboxDayLabel(new Date(t.receivedAt));
    if (!cur || cur.label !== label) { cur = { label: label, rows: [] }; groups.push(cur); }
    cur.rows.push(t);
  });
  var span = inboxDays === 1 ? "day" : inboxDays === 7 ? "week" : inboxDays + " days";
  var empty = inboxRead === "follow" ? "No customer follow-ups. Everyone's been answered."
    : inboxRead === "unread"
    ? (inboxKind === "all" ? "No unread mail in the last " + span + ". 🎉" : "Nothing unread here.")
    : "Nothing read in the last " + span + (inboxKind === "all" ? "." : " here.");
  var syncing = ((inboxData.followStatus || {}).syncing || []).filter(function (m) { return inboxBox === "all" || m === inboxBox; });
  var cappedHere = (inboxData.capped || []).filter(function (m) { return inboxBox === "all" || m === inboxBox; });
  var notes = (inboxRead === "follow" && syncing.length ? '<div class="banner">Building the follow-up list for ' + E(syncing.map(boxLabel).join(", ")) + ". The first time takes a minute or two for a busy inbox; this page checks again on its own.</div>" : "") +
    (inboxRead !== "follow" && cappedHere.length ? '<p class="small-note ib-legend">' + E(cappedHere.map(boxLabel).join(", ")) + " had more mail than fits in this window, so only the newest 1,000 are listed" + (inboxDays > 1 ? " — pick <b>Day</b> to see everything recent" : "") + ". Follow up still covers the last 14 days.</p>" : "");
  var stagingNote = inboxData.staging ? '<div class="banner">Staging: Microsoft 365 is switched off here, so this is a made-up practice email. Draft with AI really asks Claude on Bedrock; Send is a dry run that shows what would have been sent.</div>' : "";
  var undo = ibUndo ? '<div class="ib-undo">Ignored “' + E(ibUndo.subject) + '”. <button type="button" class="text-button" data-ib-unignore>Undo</button></div>' : "";
  box.innerHTML = stagingNote + undo + problems.map(function (x) { return '<div class="banner">' + E(boxLabel(x.mailbox)) + " (" + E(x.mailbox) + "): " + E(x.error) + "</div>"; }).join("") + bar + notes +
    (groups.length ? groups.map(function (g) {
      return '<section class="ib-day"><h3 class="ib-day-h">' + E(g.label) + '<span class="ib-n">' + g.rows.length + "</span></h3>" + g.rows.map(mailRow).join("") + "</section>";
    }).join("") + (more ? '<button type="button" class="ib-more" data-inbox-more>Show ' + Math.min(more, 200) + " more (" + more + " left)</button>" : "") : '<div class="card empty">' + empty + "</div>");

  function mailRow(t) {
    var open = !!inboxOpen[t.id];
    var time = new Date(t.receivedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    var link = safeLink(t.webLink);
    var names = function (l) { return l.map(function (p) { return p.name || p.email; }).join(", "); };
    var fu = t.followUp ? (t.followUp.kind === "waiting" ? " fu-waiting" : t.followUp.overdue ? " fu-overdue" : " fu-reply") : "";
    return '<article class="ib-row' + (t.isRead ? " is-read" : "") + (open ? " open" : "") + fu + '">' +
      '<button type="button" class="ib-main" data-inbox-row="' + E(t.id) + '" aria-expanded="' + open + '">' +
        '<span class="ib-dot' + (t.needsYou ? " needs" : "") + '" title="' + E(t.needsYou ? "Needs you — " + t.reason : "FYI — " + t.reason) + '"></span>' +
        '<span class="ib-from">' + (t.waiting ? '<span class="ib-to">To </span>' : "") + E(t.from.name || t.from.email) + (t.messages > 1 ? ' <span class="ib-count">' + t.messages + "</span>" : "") + "</span>" +
        '<span class="ib-text"><span class="ib-subj">' + E(t.subject) + '</span>' + (t.preview ? '<span class="ib-prev"> — ' + E(t.preview) + "</span>" : "") + "</span>" +
        '<span class="ib-meta">' + fuTag(t) + inboxCoTag(t) + (t.flagged ? '<span title="Flagged">⚑</span>' : "") + (t.important ? '<span title="High importance">!</span>' : "") + (t.attachments ? '<span title="Attachments">📎</span>' : "") +
          '<span class="ib-time">' + E(time) + "</span></span></button>" +
      (open ? '<div class="ib-detail">' +
        '<div class="mail-tags"><span class="pill' + (t.needsYou ? " rose" : "") + '">' + E(t.needsYou ? "Needs you · " + t.reason : "FYI · " + t.reason) + "</span>" +
          (boxes.length > 1 ? '<span class="pill" title="' + E(t.mailbox) + '">' + E(t.mailbox === inboxData.mailbox ? "Your inbox" : t.mailbox) + "</span>" : "") +
          (t.unread ? '<span class="pill">' + t.unread + " unread</span>" : "") + "</div>" +
        (t.company ? '<div style="margin:2px 0 6px;">' + inboxCoTag(t, true) + "</div>" : "") +
        (t.followUp ? '<div class="small-note" style="margin-bottom:4px;">' + (t.followUp.kind === "waiting"
          ? "You emailed " + E(t.followUp.who.name || t.followUp.who.email) + " " + E(fuAge(t.followUp.hours)) + " ago and haven't heard back."
          : E(t.followUp.who.name || t.followUp.who.email) + " emailed " + E(fuAge(t.followUp.hours)) + " ago and nothing's been sent back yet.") + "</div>" : "") +
        '<div class="small-note">' + (t.waiting ? "Sent" : "From " + E(t.from.email || t.from.name)) + " · To: " + E(names(t.to) || "—") + (t.cc.length ? " · cc: " + E(names(t.cc)) : "") + "</div>" +
        (t.preview ? '<p class="mail-preview">' + E(t.preview) + (t.preview.length >= 400 ? "…" : "") + "</p>" : "") +
        mailActions(t, link) + "</div>" : "") +
      "</article>";
  }
}

// ---------- Replies (Phase 8) ----------
// Under each open row: Open thread (every message in the conversation),
// Reply / Draft with AI (Claude on Bedrock writes a first draft into the box
// for you to edit; it leaves [[…]] placeholders for prices, certificates,
// NSNs and the like, and Send refuses while any are left), Ignore (hidden
// until a newer message arrives) and Open in Outlook. Keyed by mailbox and
// conversation, so the same thread under Unread and Follow up shares state.
var ibItems = {};        // key -> row, rebuilt on every draw
var ibThread = {};       // key -> { loading, data, error }
var ibShowThread = {};   // key -> thread shown
var ibCompose = {};      // key -> { to, cc, notes, text, busy, error, info, preview }
var ibUndo = null;       // last ignored row, for Undo
var ibRedrawLater = false;
function ibKey(t) { return String(t.mailbox || "") + "|" + String(t.conv || t.id); }
function ibTyping() {
  var a = document.activeElement;
  return !!(a && a.closest && a.closest("[data-ib-compose]"));
}
function ibPlaceholders(text) { return String(text || "").match(/\[\[[^\]]*\]\]/g) || []; }
function phNote(left) {
  return left.length ? '<div class="ib-ph">Fill in or delete ' + left.length + " placeholder" + (left.length === 1 ? "" : "s") + " before sending: " + E(left.slice(0, 6).join("  ")) + "</div>" : "";
}

function mailActions(t, link) {
  var k = ibKey(t), th = ibThread[k], c = ibCompose[k];
  var bar = '<div class="ib-actions">' +
    '<button type="button" class="primary" data-ib-reply="' + E(k) + '"' + (c ? " disabled" : "") + ">Reply</button>" +
    '<button type="button" data-ib-ai="' + E(k) + '"' + (c && c.busy ? " disabled" : "") + ">✦ Draft with AI</button>" +
    '<button type="button" data-ib-thread="' + E(k) + '">' + (ibShowThread[k] ? "Hide thread" : "Open thread") + (t.messages > 1 ? " (" + t.messages + ")" : "") + "</button>" +
    '<button type="button" data-ib-ignore="' + E(k) + '" title="Hide this conversation until someone writes again">Ignore</button>' +
    (link ? '<a class="mail-open" href="' + E(link) + '" target="_blank" rel="noopener noreferrer">Open in Outlook ↗</a>' : "") + "</div>";
  var thread = "";
  if (ibShowThread[k]) {
    thread = !th || th.loading ? '<div class="small-note">Loading the conversation…</div>'
      : th.error ? '<div class="banner">' + E(th.error) + "</div>"
      : '<ol class="ib-thread">' + th.data.messages.map(function (m) {
        var at = m.at ? new Date(m.at) : null;
        return '<li class="ib-msg"><div class="ib-msg-h"><b>' + E(m.from.name || m.from.email) + '</b> <span class="small-note">' + E(m.from.email) + (at ? " · " + E(at.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) : "") + "</span></div>" +
          '<div class="small-note">To: ' + E(m.to.map(function (p) { return p.name || p.email; }).join(", ") || "—") + (m.cc.length ? " · cc: " + E(m.cc.map(function (p) { return p.name || p.email; }).join(", ")) : "") + "</div>" +
          '<div class="ib-msg-text">' + E(m.text || "(no text)") + "</div></li>";
      }).join("") + "</ol>";
  }
  return bar + thread + (c ? composeBox(k, c, th) : "");
}

function composeBox(k, c, th) {
  var d = th && th.data;
  var left = ibPlaceholders(c.text);
  if (c.preview) {
    var p = c.preview;
    return '<div class="ib-compose ib-sent">' +
      '<div class="eyebrow">' + (p.dryRun ? "Dry run — nothing was sent" : "Sent") + "</div>" +
      '<div class="small-note">From ' + E(p.from) + " · To: " + E(p.to.join(", ")) + (p.cc.length ? " · cc: " + E(p.cc.join(", ")) : "") + "<br>Subject: " + E(p.subject) + (p.inThread ? " · in the same Outlook thread" : " · new email from your mailbox") + "</div>" +
      (p.dryRun ? '<div class="ib-msg-text">' + E(p.text) + "</div>" : "") +
      '<div class="nb-foot"><button type="button" class="text-button" data-ib-close="' + E(k) + '">Close</button></div></div>';
  }
  return '<div class="ib-compose" data-ib-compose="' + E(k) + '">' +
    (d ? '<div class="small-note">From <b>' + E(d.from) + "</b>" + (d.shared ? " (a new email from your own mailbox; " + E(d.mailbox) + " is copied)" : "") + (d.staging ? " · <b>staging: dry run</b>" : "") + "</div>" : '<div class="small-note">Loading the conversation…</div>') +
    '<label class="ib-f"><span>To</span><input type="text" data-ib-field="to" value="' + E(c.to) + '" aria-label="To"></label>' +
    '<label class="ib-f"><span>Cc</span><input type="text" data-ib-field="cc" value="' + E(c.cc) + '" aria-label="Cc"></label>' +
    '<label class="ib-f"><span>For AI</span><input type="text" data-ib-field="notes" value="' + E(c.notes) + '" placeholder="Optional: what the reply should say, e.g. “quote by Thursday, ask for the delivery address”" aria-label="What the AI draft should say"></label>' +
    '<textarea rows="10" data-ib-field="text" aria-label="Reply" placeholder="Write your reply, or click Draft with AI">' + E(c.text) + "</textarea>" +
    '<div data-ib-ph>' + phNote(left) + "</div>" +
    (c.info ? '<div class="small-note">' + E(c.info) + "</div>" : "") +
    (c.error ? '<div class="banner">' + E(c.error) + "</div>" : "") +
    '<div class="nb-foot"><button type="button" class="primary" data-ib-send="' + E(k) + '"' + (c.busy || !d ? " disabled" : "") + ">" + (c.busy === "send" ? "Sending…" : d && d.staging ? "Send (dry run)" : "Send") + "</button>" +
    '<button type="button" data-ib-ai="' + E(k) + '"' + (c.busy || !d ? " disabled" : "") + ">" + (c.busy === "ai" ? "Drafting…" : c.text ? "✦ Redraft with AI" : "✦ Draft with AI") + "</button>" +
    '<button type="button" class="text-button" data-ib-close="' + E(k) + '">Discard</button>' +
    '<span class="small-note">AI drafts come from Claude on SOI\'s own AWS account, which reads only this conversation. Check every fact before sending.</span></div></div>';
}

function loadThread(k) {
  var t = ibItems[k];
  if (!t) return Promise.reject(new Error("That email isn't on the list any more."));
  if (ibThread[k] && ibThread[k].data) return Promise.resolve(ibThread[k].data);
  ibThread[k] = { loading: true };
  return api("/api/inbox/thread?mailbox=" + encodeURIComponent(t.mailbox) + "&conv=" + encodeURIComponent(t.conv || t.id)).then(function (data) {
    ibThread[k] = { data: data };
    return data;
  }, function (err) {
    ibThread[k] = { error: err.message };
    throw err;
  });
}

function openCompose(k, thenDraft) {
  if (!ibCompose[k] || ibCompose[k].preview) ibCompose[k] = { to: "", cc: "", notes: "", text: "" };
  drawInbox();
  loadThread(k).then(function (d) {
    var c = ibCompose[k];
    if (!c) return;
    if (!c.to && !c.cc) { c.to = d.to.join(", "); c.cc = d.cc.join(", "); }
    if (thenDraft) aiDraft(k); else { drawInbox(); focusCompose(k); }
  }, function (err) {
    if (ibCompose[k]) ibCompose[k].error = err.message;
    drawInbox();
  });
}
function focusCompose(k) {
  var box = document.querySelector('[data-ib-compose="' + (window.CSS && CSS.escape ? CSS.escape(k) : k) + '"] textarea');
  if (box) box.focus();
}

function aiDraft(k) {
  var c = ibCompose[k], t = ibItems[k];
  if (!c || !t || c.busy) return;
  if (c.text && !confirm("Replace what's in the reply box with a new AI draft?")) return;
  c.busy = "ai"; c.error = ""; c.info = "";
  drawInbox();
  api("/api/inbox/draft", { method: "POST", body: JSON.stringify({ mailbox: t.mailbox, conv: t.conv || t.id, notes: c.notes }) }).then(function (r) {
    c.text = r.text;
    c.info = "Draft from Claude (" + r.model + ")" + (r.placeholders ? " — it left " + r.placeholders + " placeholder" + (r.placeholders === 1 ? "" : "s") + " for you to fill in" : "") + (r.truncated ? " — it was cut short, so check the ending" : "") + ". Edit it before sending.";
  }, function (err) { c.error = err.message; }).then(function () {
    c.busy = false;
    drawInbox();
    focusCompose(k);
  });
}

function sendReply(k) {
  var c = ibCompose[k], t = ibItems[k], d = ibThread[k] && ibThread[k].data;
  if (!c || !t || !d || c.busy) return;
  c.error = "";
  var left = ibPlaceholders(c.text);
  if (!String(c.text).trim()) { c.error = "Write the reply first."; drawInbox(); return; }
  if (left.length) { c.error = "Fill in or delete the [[…]] placeholders first. Nothing was sent."; drawInbox(); return; }
  if (!d.staging && !confirm("Send this reply from " + d.from + " to " + c.to + (c.cc ? " (cc " + c.cc + ")" : "") + "?")) return;
  c.busy = "send";
  drawInbox();
  api("/api/inbox/reply", { method: "POST", body: JSON.stringify({ mailbox: t.mailbox, conv: t.conv || t.id, to: c.to, cc: c.cc, text: c.text }) }).then(function (r) {
    c.preview = r;
    c.busy = false;
    toast(r.dryRun ? "Dry run: nothing was sent (staging)." : "Reply sent.");
    delete ibThread[k]; // the thread now has your reply
    drawInbox();
    if (ibShowThread[k]) loadThread(k).then(drawInbox, drawInbox);
    if (!r.dryRun) setTimeout(function () { loadInbox(true); }, 3000);
  }, function (err) {
    c.busy = false;
    c.error = err.message;
    drawInbox();
  });
}

function ignoreRow(k, undo) {
  var t = undo ? ibUndo && ibUndo.t : ibItems[k];
  if (!t) return;
  api("/api/inbox/ignore", { method: "POST", body: JSON.stringify({ mailbox: t.mailbox, conv: t.conv || t.id, latest: t.receivedAt, undo: !!undo }) }).then(function () {
    if (undo) { ibUndo = null; inboxSig = ""; loadInbox(false); return; }
    ibUndo = { t: t, subject: t.subject };
    delete ibCompose[k]; delete ibShowThread[k];
    var gone = function (x) { return ibKey(x) !== k; };
    inboxData.items = inboxData.items.filter(gone);
    inboxData.followUps = (inboxData.followUps || []).filter(gone);
    inboxData.ignored = (inboxData.ignored || 0) + 1;
    updateInboxBadge();
    drawInbox();
  }, function (err) { toast(err.message, true); });
}

document.addEventListener("input", function (e) {
  var f = e.target.closest && e.target.closest("[data-ib-field]");
  if (!f) return;
  var wrap = f.closest("[data-ib-compose]"), c = wrap && ibCompose[wrap.dataset.ibCompose];
  if (!c) return;
  c[f.dataset.ibField] = f.value;
  var ph = f.dataset.ibField === "text" && wrap.querySelector("[data-ib-ph]");
  if (ph) ph.innerHTML = phNote(ibPlaceholders(f.value));
});
// A list refresh that waited while you typed happens once you leave the box.
document.addEventListener("focusout", function () {
  setTimeout(function () { if (ibRedrawLater && !ibTyping() && page === "inbox") { ibRedrawLater = false; drawInbox(); } }, 0);
});
document.addEventListener("click", function (e) {
  var el = e.target.closest && e.target.closest("[data-ib-reply],[data-ib-ai],[data-ib-thread],[data-ib-ignore],[data-ib-send],[data-ib-close],[data-ib-unignore]");
  if (!el) return;
  var d = el.dataset;
  if (d.ibUnignore !== undefined) return ignoreRow(null, true);
  if (d.ibReply) return openCompose(d.ibReply, false);
  if (d.ibAi) { if (ibCompose[d.ibAi] && !ibCompose[d.ibAi].preview && ibThread[d.ibAi] && ibThread[d.ibAi].data) return aiDraft(d.ibAi); return openCompose(d.ibAi, true); }
  if (d.ibSend) return sendReply(d.ibSend);
  if (d.ibClose) {
    var c = ibCompose[d.ibClose];
    if (c && !c.preview && String(c.text || "").trim() && !confirm("Discard this reply?")) return;
    delete ibCompose[d.ibClose];
    return drawInbox();
  }
  if (d.ibIgnore) return ignoreRow(d.ibIgnore, false);
  if (d.ibThread) {
    var k = d.ibThread;
    ibShowThread[k] = !ibShowThread[k];
    drawInbox();
    if (ibShowThread[k]) loadThread(k).then(drawInbox, drawInbox);
  }
});

// Checks every few minutes on any page, so the sidebar count stays current.
setInterval(function () { if (!document.hidden && me) loadInbox(true); }, 3 * 60 * 1000);
document.addEventListener("visibilitychange", function () { if (!document.hidden && page === "inbox" && me) loadInbox(true); });
document.addEventListener("click", function (e) {
  var tb = e.target.closest && e.target.closest("[data-inbox-box]");
  if (tb) { inboxBox = tb.dataset.inboxBox; drawInbox(); return; }
  var rd = e.target.closest && e.target.closest("[data-inbox-read]");
  if (rd) { inboxRead = rd.dataset.inboxRead; inboxShow = 200; drawInbox(); return; }
  var mo = e.target.closest && e.target.closest("[data-inbox-more]");
  if (mo) { inboxShow += 200; drawInbox(); return; }
  var cb = e.target.closest && e.target.closest("[data-inbox-co]");
  if (cb) { inboxCo = cb.dataset.inboxCo; drawInbox(); return; }
  var kd = e.target.closest && e.target.closest("[data-inbox-kind]");
  if (kd) { inboxKind = kd.dataset.inboxKind; drawInbox(); return; }
  var row = e.target.closest && e.target.closest("[data-inbox-row]");
  if (row) { var id = row.dataset.inboxRow; inboxOpen[id] = !inboxOpen[id]; drawInbox(); return; }
  var b = e.target.closest && e.target.closest("[data-inbox-days]");
  if (!b || page !== "inbox") return;
  inboxDays = +b.dataset.inboxDays;
  inboxSig = "";
  render();
});

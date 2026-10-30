"use strict";
// IT → Requests.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- IT requests (IT → Requests) ----
// Every IT form response: the Excel import plus new ones the flow emails.
// Tabs by status (New / In progress / Resolved); tick rows to change many
// at once. Managers give each an internal priority (P1–P4, separate from
// the form's own urgency). People are matched across spellings (below).
var IT_PRIOS = [
  { id: "P1", label: "P1 · Critical", note: "drop everything" },
  { id: "P2", label: "P2 · High", note: "today" },
  { id: "P3", label: "P3 · Normal", note: "this week" },
  { id: "P4", label: "P4 · Low", note: "when there's time" }
];
var IT_STATUSES = [
  { id: "new", label: "New", note: "Just came in from the form" },
  { id: "progress", label: "In progress", note: "Being worked on" },
  { id: "done", label: "Resolved", note: "Fixed and closed" }
];
var IT_STATUS_LABEL = { new: "New", progress: "In progress", done: "Resolved" };
var itr = { data: null, at: 0, loading: false, error: "", person: "", tab: "all", sort: "newest", picked: {}, adding: false, form: {}, saving: false, view: "list", open: "", compose: null, kbList: null, posting: false };
function canSeeItRequests() { return !!(me && (me.fullAccess || me.departments.indexOf("IT") !== -1)); }
function loadItRequests() {
  if (itr.loading) return;
  itr.loading = true;
  api("/api/it-requests").then(function (d) { matchPeople(d.requests); itr.data = d; itr.error = ""; }, function (err) { itr.error = err.message; })
    .then(function () { itr.loading = false; itr.at = Date.now(); requestRender(); });
}

// One person, however they typed their name: "ELVIS", "elvis" and
// "Elvis Smith" are the same. Requests join up on the same name (ignoring
// capitals and spacing), or the same email when the names agree; a first
// name on its own joins a full name when only one person has that first
// name. Names show in normal capitals. Sets r.pkey and r.pname.
function matchPeople(list) {
  var parent = [];
  var find = function (i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  var join = function (a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  var norm = function (n) { return String(n || "").toLowerCase().replace(/[^a-zÀ-ɏ'\- ]+/g, " ").replace(/\s+/g, " ").trim(); };
  // Two names can be one person: the same, one missing, a first name on
  // its own, or an initial ("J Smith" / "John Smith").
  var fits = function (a, b) {
    if (!a || !b || a === b) return true;
    var x = a.split(" "), y = b.split(" ");
    if (x.length === 1 || y.length === 1) return x[0] === y[0] || (x[0].length === 1 || y[0].length === 1) && x[0][0] === y[0][0];
    return x[x.length - 1] === y[y.length - 1] && x[0][0] === y[0][0] && (x[0].length === 1 || y[0].length === 1 || x[0] === y[0]);
  };
  var byEmail = {}, byName = {};
  list.forEach(function (r, i) {
    parent[i] = i;
    var em = String(r.email || "").trim().toLowerCase();
    var nm = String(r.name || "").indexOf("@") === -1 ? norm(r.name) : "";
    r._em = em; r._nm = nm;
    if (nm) { if (byName[nm] != null) join(byName[nm], i); else byName[nm] = i; }
    // A shared address (front desk, a manager filing for someone) mustn't
    // merge different people, so the names have to agree too.
    if (em) {
      (byEmail[em] = byEmail[em] || []).forEach(function (k) { if (fits(nm, list[k]._nm)) join(k, i); });
      byEmail[em].push(i);
    }
  });
  // First name only -> the one person whose full name starts with it.
  var fullByFirst = {};
  list.forEach(function (r, i) {
    if (r._nm.indexOf(" ") === -1) return;
    var f = r._nm.split(" ")[0];
    (fullByFirst[f] = fullByFirst[f] || {})[find(i)] = 1;
  });
  list.forEach(function (r, i) {
    if (!r._nm || r._nm.indexOf(" ") !== -1) return;
    var roots = Object.keys(fullByFirst[r._nm] || {}).map(function (x) { return find(+x); });
    var uniq = roots.filter(function (x, k) { return roots.indexOf(x) === k; });
    if (uniq.length === 1) join(uniq[0], i);
  });
  // Display name: the fullest version used, in normal capitals.
  var names = {};
  list.forEach(function (r, i) {
    var g = find(i), n = names[g] || (names[g] = { counts: {}, email: "" });
    if (r._nm) n.counts[r._nm] = (n.counts[r._nm] || 0) + 1;
    if (!n.email && r._em) n.email = r._em;
  });
  var title = function (n) { return n.replace(/(^|[\s'\-])([a-zà-ɏ])/g, function (m, a, b) { return a + b.toUpperCase(); }); };
  list.forEach(function (r, i) {
    var g = find(i), n = names[g];
    var best = Object.keys(n.counts).sort(function (a, b) {
      return b.split(" ").length - a.split(" ").length || n.counts[b] - n.counts[a] || b.length - a.length;
    })[0];
    r.pkey = "p" + g;
    r.pname = best ? title(best) : n.email || "Unknown";
    delete r._em; delete r._nm;
  });
  return list;
}
function itrPerson(r) { return r.pname || r.name || r.email || "Unknown"; }

// Duplicates. r.duplicateOf links a request to its original (set by a
// manager). r.repeatOf is only a hint: the same person sent something
// similar (or anything on the same day) in the 7 days before, and nobody
// has said "not a duplicate". r.dupes counts duplicates on an original.
var STOP = { the: 1, and: 1, for: 1, you: 1, please: 1, with: 1, this: 1, that: 1, have: 1, can: 1, not: 1, are: 1, was: 1, but: 1, all: 1, our: 1, from: 1, need: 1, issue: 1, help: 1, its: 1, it: 1 };
function words(t) {
  var w = {};
  String(t || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").forEach(function (x) { if (x.length > 2 && !STOP[x]) w[x] = 1; });
  return w;
}
function similar(a, b) {
  var x = words(a), y = words(b), both = 0, either = 0, k;
  for (k in x) { either++; if (y[k]) both++; }
  for (k in y) if (!x[k]) either++;
  return either ? both / either : 0;
}
function findRepeats(list) {
  var byId = {}, byPerson = {};
  list.forEach(function (r) { byId[r.id] = r; r.repeatOf = ""; r.dupes = 0; });
  list.forEach(function (r) { if (r.duplicateOf && byId[r.duplicateOf]) byId[r.duplicateOf].dupes++; });
  list.forEach(function (r) { if (!r.duplicateOf) (byPerson[r.pkey] = byPerson[r.pkey] || []).push(r); });
  Object.keys(byPerson).forEach(function (k) {
    var mine = byPerson[k].slice().sort(function (a, b) { return String(a.submittedAt).localeCompare(String(b.submittedAt)); });
    mine.forEach(function (r, i) {
      if (r.notDuplicate) return;
      var t = Date.parse(String(r.submittedAt).replace(" ", "T"));
      for (var j = i - 1; j >= 0; j--) {
        var o = mine[j], ot = Date.parse(String(o.submittedAt).replace(" ", "T"));
        if (t - ot > 7 * 864e5) break;
        if (String(o.submittedAt).slice(0, 10) === String(r.submittedAt).slice(0, 10) || similar(r.issue, o.issue) >= 0.3) { r.repeatOf = o.id; break; }
      }
    });
  });
  return byId;
}

function renderItRequests() {
  if (!itr.data || Date.now() - itr.at > 120000) loadItRequests();
  if (itr.error) return '<div class="banner">' + E(itr.error) + "</div>";
  if (!itr.data) return '<div class="empty">Loading requests…</div>';
  // Archived requests sit on their own tab, out of everything else.
  var archived = itr.data.requests.filter(function (r) { return r.archived; });
  var every = itr.data.requests.filter(function (r) { return !r.archived; }), can = itr.data.canRate;
  var byId = findRepeats(every);
  var dupes = every.filter(function (r) { return r.duplicateOf; });
  // Duplicates live on their own tab; everything else counts once.
  var all = every.filter(function (r) { return !r.duplicateOf; });
  var since30 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  var count = function (st) { return all.filter(function (r) { return r.status === st; }).length; };
  var first = all.length ? all[all.length - 1].submittedAt : "";
  var unrated = all.filter(function (r) { return r.status !== "done" && !r.priority; }).length;

  // By person
  var people = {};
  all.forEach(function (r) {
    var p = people[r.pkey] || (people[r.pkey] = { key: r.pkey, name: itrPerson(r), company: r.company, n: 0, new: 0, progress: 0, done: 0, p12: 0, last: "" });
    p.n++; p[r.status] = (p[r.status] || 0) + 1;
    if (r.priority === "P1" || r.priority === "P2") p.p12++;
    if (r.submittedAt > p.last) p.last = r.submittedAt;
    if (!p.company && r.company) p.company = r.company;
  });
  var plist = Object.keys(people).map(function (k) { return people[k]; })
    .sort(function (a, b) { return b.n - a.n || a.name.localeCompare(b.name); });
  if (itr.person && !people[itr.person]) itr.person = "";

  var mineOnly = function (r) { return !itr.person || r.pkey === itr.person; };
  var inPerson = all.filter(mineOnly);
  var hints = inPerson.filter(function (r) { return r.repeatOf && r.status !== "done"; });
  var rows = itr.tab === "archived" ? archived.filter(mineOnly)
    : itr.tab === "dupes"
    ? hints.concat(dupes.filter(mineOnly))
    : inPerson.filter(function (r) { return itr.tab === "all" || r.status === itr.tab; });
  var prank = function (r) { return r.priority ? +r.priority.slice(1) : 9; };
  rows.sort(function (a, b) {
    if (itr.sort === "oldest") return String(a.submittedAt).localeCompare(String(b.submittedAt));
    if (itr.sort === "priority") return prank(a) - prank(b) || String(b.submittedAt).localeCompare(String(a.submittedAt));
    if (itr.sort === "person") return itrPerson(a).localeCompare(itrPerson(b)) || String(b.submittedAt).localeCompare(String(a.submittedAt));
    return String(b.submittedAt).localeCompare(String(a.submittedAt));
  });
  // Keep only ticks on rows that still exist.
  var ids = {}; every.forEach(function (r) { ids[r.id] = 1; });
  Object.keys(itr.picked).forEach(function (id) { if (!ids[id]) delete itr.picked[id]; });
  var picked = Object.keys(itr.picked);
  var allShownPicked = rows.length > 0 && rows.every(function (r) { return itr.picked[r.id]; });

  var prioCell = function (r) {
    if (!can) return r.priority ? '<span class="prio prio-' + r.priority + '">' + E(r.priority) + "</span>" : '<span class="prio prio-none">Not rated</span>';
    return '<select class="fb-in" data-itr-prio="' + E(r.id) + '" aria-label="Internal priority"><option value="">Rate…</option>' + IT_PRIOS.map(function (p) {
      return '<option value="' + p.id + '"' + (r.priority === p.id ? " selected" : "") + ">" + E(p.label) + "</option>";
    }).join("") + "</select>";
  };
  var statusCell = function (r) {
    if (r.archived) {
      return '<span class="st st-archived">Archived</span><span class="co-note">' + E(r.archivedAt ? fmtDate(new Date(r.archivedAt).toISOString()) : "") + (r.archivedBy ? " · " + E(r.archivedBy) : "") + "</span>" +
        (can ? '<span class="itr-row-acts"><button type="button" class="text-button" data-itr-restore="' + E(r.id) + '">Restore</button><button type="button" class="text-button danger" data-itr-delete="' + E(r.id) + '">Delete forever</button></span>' : "");
    }
    return statusSelect(r) + (can ? '<span class="itr-row-acts"><button type="button" class="text-button" data-itr-archive="' + E(r.id) + '">Archive</button></span>' : "");
  };
  var statusSelect = function (r) {
    if (r.duplicateOf) {
      if (!can) return '<span class="st st-dup">Duplicate</span>';
      // Picking a status takes it out of duplicates.
      return '<select class="st-select st-dup" data-itr-st="' + E(r.id) + '" aria-label="Status"><option value="dup" selected>Duplicate</option>' + IT_STATUSES.map(function (s) {
        return '<option value="' + s.id + '">Move to ' + E(s.label) + "</option>";
      }).join("") + "</select>";
    }
    if (!can) return '<span class="st st-' + r.status + '">' + E(IT_STATUS_LABEL[r.status]) + "</span>";
    return '<select class="st-select st-' + r.status + '" data-itr-st="' + E(r.id) + '" aria-label="Status">' + IT_STATUSES.map(function (s) {
      return '<option value="' + s.id + '"' + (r.status === s.id ? " selected" : "") + ">" + E(s.label) + "</option>";
    }).join("") + "</select>";
  };
  var when = function (s) { return s ? E(fmtDate(s)) + '<span class="co-note">' + E(String(s).slice(11, 16)) + "</span>" : "—"; };
  var tabCount = function (st) {
    if (st === "dupes") return dupes.filter(mineOnly).length;
    if (st === "archived") return archived.filter(mineOnly).length;
    if (st === "sla") return inPerson.filter(function (r) { var x = itrSla(r); return r.status !== "done" && (x.resp.state === "breached" || x.resol.state === "breached"); }).length;
    return st === "all" ? inPerson.length : inPerson.filter(function (r) { return r.status === st; }).length;
  };
  var short = function (o) { return o ? fmtDate(o.submittedAt) + " — " + (String(o.issue || "").length > 60 ? o.issue.slice(0, 60) + "…" : o.issue || "no description") : "a request that's gone"; };
  var dupCell = function (r) {
    if (r.duplicateOf) return '<span class="dup-note">Duplicate of ' + E(short(byId[r.duplicateOf])) +
      (can ? ' <button type="button" class="text-button" data-itr-main="' + E(r.id) + '">Make this the main one</button>' +
        ' <button type="button" class="text-button" data-itr-undup="' + E(r.id) + '">Undo</button>' : "") + "</span>";
    var out = r.dupes ? '<span class="co-note">+' + r.dupes + (r.dupes === 1 ? " duplicate" : " duplicates") + "</span>" : "";
    if (r.repeatOf && r.status !== "done") {
      out += '<span class="dup-hint">Looks like a repeat of their ' + E(fmtDate(byId[r.repeatOf].submittedAt)) + " request" +
        (can ? ' <button type="button" class="text-button" data-itr-dup="' + E(r.id) + '" data-of="' + E(r.repeatOf) + '">Mark duplicate</button>' +
          ' <button type="button" class="text-button" data-itr-notdup="' + E(r.id) + '">Not a duplicate</button>' : "") + "</span>";
    }
    return out;
  };

  var personOpts = '<option value="">Everyone</option>' + plist.map(function (p) {
    return '<option value="' + E(p.key) + '"' + (p.key === itr.person ? " selected" : "") + ">" + E(p.name) + " (" + p.n + ")</option>";
  }).join("");

  var bulk = can && picked.length && itr.tab === "archived"
    ? '<div class="bulk-bar"><b>' + picked.length + ' selected</b><button type="button" class="st-btn st-progress" data-itr-restore>Restore</button>' +
      '<button type="button" class="st-btn st-del" data-itr-delete>Delete forever</button><span class="grow"></span><button type="button" class="text-button" data-itr-clear>Clear</button></div>'
    : can && picked.length
    ? '<div class="bulk-bar"><b>' + picked.length + " selected</b><span>Mark as</span>" + IT_STATUSES.map(function (s) {
        return '<button type="button" class="st-btn st-' + s.id + '" data-itr-bulk="' + s.id + '">' + E(s.label) + "</button>";
      }).join("") + (picked.length > 1 ? '<span>Merge as duplicates,</span>' +
        '<button type="button" class="st-btn st-dup" data-itr-merge="newest" title="The most recent one stays; the others become its duplicates">keep newest</button>' +
        '<button type="button" class="st-btn st-dup" data-itr-merge="oldest" title="The earliest one stays; the others become its duplicates">keep oldest</button>' : "") +
      '<button type="button" class="st-btn" data-itr-archive>Archive</button>' +
      '<span class="grow"></span><button type="button" class="text-button" data-itr-clear>Clear</button></div>'
    : "";

  var replied = all.filter(function (r) { return r.replyPending; });
  var replyBanner = replied.length ? '<div class="banner itr-reply-banner"><b>' + replied.length + (replied.length === 1 ? " person" : " people") + " replied to a resolved ticket</b> — " +
    E(replied.slice(0, 3).map(itrPerson).join(", ")) + (replied.length > 3 ? " and more" : "") + '. <button type="button" class="text-button" data-itr-replied>Show them</button></div>' : "";
  return itSyncLine(itr.data.sync, can) + replyBanner + '<div class="summary-cards four">' +
      metric("Requests", all.length, (first ? "Since " + fmtDate(first) + " · " : "") + all.filter(function (r) { return r.submittedAt >= since30; }).length + " in the last 30 days") +
      metric("New", count("new"), "Just came in from the form", count("new") > 0) +
      metric("In progress", count("progress"), unrated ? unrated + " open ones not rated yet" : "All rated") +
      metric("Resolved", count("done"), "Fixed and closed") + "</div>" +
    '<div class="tabs" role="tablist" style="margin-top:4px;">' + [{ id: "all", label: "All" }].concat(IT_STATUSES, [{ id: "sla", label: "SLAs" }, { id: "dupes", label: "Duplicates" }, { id: "archived", label: "Archived" }]).map(function (t) {
      var n = tabCount(t.id);
      return '<button type="button" role="tab" class="tab ' + (itr.tab === t.id ? "active" : "") + '" aria-selected="' + (itr.tab === t.id) + '" data-itr-tab="' + t.id + '">' +
        E(t.label) + (n ? '<span class="badge' + (t.id === "sla" ? " hint-badge" : "") + '"' + (t.id === "sla" ? ' title="Open tickets past an SLA target"' : "") + ">" + n + (t.id === "sla" ? " breached" : "") + "</span>" : "") + (t.id === "dupes" && hints.length ? '<span class="badge hint-badge" title="Possible repeats to review">' + hints.length + " to review</span>" : "") + "</button>";
    }).join("") + "</div>" +
    (itr.tab === "archived" ? '<p class="small-note" style="margin:6px 0 0;">Archived requests stay here, out of the other tabs, the numbers and the charts, until you restore them. <b>Delete forever</b> removes a request, its IT task and its notebook write-up for good.</p>' : "") +
    (itr.tab === "dupes" ? '<p class="small-note" style="margin:6px 0 0;">Possible repeats to review come first (same person, something similar within 7 days), then the ones you\'ve marked. Duplicates don\'t count in the other tabs, the numbers or the charts.</p>' : "") +
    (itr.tab === "sla" ? renderItSlaTab(inPerson) : (
    '<div class="table-toolbar"><select id="itrPerson" aria-label="Show one person">' + personOpts + "</select>" +
      '<select id="itrSort" aria-label="Sort by">' + [["newest", "Newest first"], ["oldest", "Oldest first"], ["priority", "Priority"], ["person", "Person A–Z"]].map(function (x) {
        return '<option value="' + x[0] + '"' + (itr.sort === x[0] ? " selected" : "") + ">Sort: " + x[1] + "</option>";
      }).join("") + "</select>" +
      (itr.person ? '<button type="button" class="text-button" data-itr-who="">Show everyone</button>' : "") +
      '<span class="grow" style="flex:1"></span>' +
      (can ? '<input type="file" id="itrFile" accept=".xlsx" hidden><button type="button" id="itrImport">Import from Excel</button>' : "") +
      (["all", "new", "progress", "done"].indexOf(itr.tab) !== -1 ? '<div class="seg"><button type="button" data-itr-view="list" class="' + (itr.view !== "board" ? "active" : "") + '">List</button><button type="button" data-itr-view="board" class="' + (itr.view === "board" ? "active" : "") + '">Board</button></div>' : "") +
      '<button type="button" class="primary" data-itr-add>+ Add ticket</button></div>' +
    (itr.adding ? itrAddForm(plist) : "") +
    bulk +
    (itr.view === "board" && ["all", "new", "progress", "done"].indexOf(itr.tab) !== -1 ? renderItBoard(inPerson, can) : (
    '<div class="table-wrap"><table class="wide"><thead><tr>' +
      (can ? '<th class="center" style="width:34px;"><input type="checkbox" class="check" data-itr-pickall' + (allShownPicked ? " checked" : "") + ' aria-label="Select all shown"></th>' : "") +
      "<th>Submitted</th><th>Person</th><th>Issue</th><th>Form says</th><th>Priority</th><th>Status</th><th>Contact</th></tr></thead><tbody>" +
    (rows.length ? rows.map(function (r) {
      var on = !!itr.picked[r.id];
      return '<tr class="' + (on ? "picked " : "") + (r.status === "done" ? "done" : "") + '">' +
        (can ? '<td class="center"><input type="checkbox" class="check" data-itr-pick="' + E(r.id) + '"' + (on ? " checked" : "") + ' aria-label="Select this request"></td>' : "") +
        "<td>" + when(r.submittedAt) + "</td>" +
        '<td><button type="button" class="itr-person" data-itr-who="' + E(r.pkey) + '">' + E(itrPerson(r)) + "</button>" +
          '<span class="co-note">' + E([r.company, r.remote === "Yes" ? "Remote" : ""].filter(Boolean).join(" · ")) + "</span></td>" +
        '<td><button type="button" class="itr-issue itr-open" data-itr-open="' + E(r.id) + '" title="Open the ticket">' + E(r.issue || "—") + "</button>" +
          ((r.activity || []).length ? '<span class="co-note">' + (r.activity || []).filter(function (a) { return a.type === "reply" || a.type === "note"; }).length + " notes / replies" + (r.ackAt ? " · auto-acknowledged" : "") + "</span>" : "") +
          (r.notes ? '<span class="itr-note"><b>Note:</b> ' + E(r.notes) + "</span>" : "") +
          (r.source === "manual" ? '<span class="co-note">Added by hand' + (r.addedBy ? " · " + E(r.addedBy) : "") + "</span>" : "") +
          (r.status === "done" && (r.resolution || r.notifiedAt) ? '<span class="itr-note" style="border-left-color:#9fbf8f;"><b>Resolved' + (r.resolution ? ":</b> " + E(r.resolution) : "</b>") + (r.notifiedAt ? '<br><span class="small-note">Emailed ' + E(r.email) + " " + E(new Date(r.notifiedAt).toLocaleDateString()) + (r.ref ? " · " + E(r.ref) : "") + "</span>" : "") + "</span>" : "") +
          itrReplies(r, can) +
          dupCell(r) + "</td>" +
        "<td>" + E(r.urgency || "—") + "</td><td>" + prioCell(r) + "</td><td>" + statusCell(r) + "</td>" +
        "<td>" + E(r.contact || "—") + (r.phone ? '<span class="co-note">' + E(r.phone) + "</span>" : "") + (r.email || can ? '<span class="co-note">' + E(r.email || "no email") + (can ? ' <button type="button" class="text-button" data-itr-email="' + E(r.id) + '" title="Change this ticket\'s email address">✎</button>' : "") + "</span>" : "") + "</td></tr>";
    }).join("") : '<tr><td colspan="' + (can ? 8 : 7) + '" class="empty">' + (itr.tab === "archived" ? "Nothing archived. Select requests and choose Archive, or use Archive under a status." : itr.tab === "dupes" ? "No duplicates." : all.length ? "Nothing here." : can ? "No requests yet — use Import from Excel for past form answers." : "No requests yet.") + "</td></tr>") +
    "</tbody></table></div>")))) +
    '<div class="section-title" style="margin-top:26px;"><div><h2>By person</h2><span class="small-note">Click a name to see only their requests.</span></div></div>' +
    '<div class="table-wrap"><table class="plain"><thead><tr><th>Person</th><th>Company</th><th>Requests</th><th>New</th><th>In progress</th><th>Resolved</th><th>P1 / P2</th><th>Last request</th></tr></thead><tbody>' +
    (plist.length ? plist.map(function (p) {
      return '<tr><td><button type="button" class="itr-person" data-itr-who="' + E(p.key) + '">' + E(p.name) + "</button></td><td>" + E(p.company || "—") + "</td><td>" + p.n + "</td><td>" + (p.new || 0) + "</td><td>" + (p.progress || 0) + "</td><td>" + (p.done || 0) + "</td><td>" + p.p12 + "</td><td>" + E(fmtDate(p.last)) + "</td></tr>";
    }).join("") : '<tr><td colspan="8" class="empty">No requests yet.</td></tr>') + "</tbody></table></div>" +
    '<p class="small-note" style="margin-top:12px;">Priority is your internal rating: ' + IT_PRIOS.map(function (p) { return p.id + " " + p.note; }).join(" · ") +
    "." +
    " New form answers arrive every few minutes as New.</p>";
}
// Replies to the "Resolved" email. A new one is flagged until someone
// reopens the ticket or keeps it resolved.
function itrReplies(r, can) {
  var rs = r.replies || [];
  if (!rs.length) return "";
  return rs.map(function (x, i) {
    var last = i === rs.length - 1;
    return '<span class="itr-note itr-reply' + (last && r.replyPending ? " pending" : "") + '"><b>↩ ' + E(x.name || x.from || "Reply") + "</b> replied " + E(new Date(x.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) +
      "<br>" + E(x.text || "(no text)") +
      (last && r.replyPending && can ? '<span class="itr-reply-acts"><button type="button" class="st-btn st-progress" data-itr-reopen="' + E(r.id) + '">Reopen</button><button type="button" class="text-button" data-itr-keep="' + E(r.id) + '">Keep resolved</button></span>' : "") + "</span>";
  }).join("");
}
// ---------- Ticket card, board and SLAs ----------
// Click a ticket to open its card: details, the activity (replies emailed
// to the requester, internal work notes, status changes, the automatic
// acknowledgement, the requester's own replies), files, and a box to write
// a reply (emailed, with attachments and optionally a KB article) or an
// internal note. SLA targets come from Admin → IT ticket SLAs.
function itrStart(r) { return r.addedAt || Date.parse(String(r.submittedAt || "").replace(" ", "T")) || 0; }
function itrResolvedAt(r) {
  if (r.resolvedAt) return r.resolvedAt;
  var st = (r.activity || []).filter(function (a) { return a.type === "status" && a.text === "Resolved"; }).pop();
  return st ? st.at : r.status === "done" ? (r.updatedAt || 0) : 0;
}
function itrDur(ms) {
  var m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return m + "m";
  var h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d >= 1 ? d + "d " + (h % 24) + "h" : h + "h " + (m % 60) + "m";
}
// { resp, resol }: each { state: met | late | due | breached | na, text }.
function itrSla(r) {
  var sla = (itr.data && itr.data.sla) || null, start = itrStart(r), now = Date.now();
  if (!sla || !start || start < (sla.since || 0) || r.source === "import") return { resp: { state: "na", text: "Before SLAs" }, resol: { state: "na", text: "Before SLAs" } };
  var one = function (doneAt, dueAt) {
    if (doneAt) return doneAt <= dueAt ? { state: "met", text: "Met in " + itrDur(doneAt - start) } : { state: "late", text: "Late by " + itrDur(doneAt - dueAt) };
    return now <= dueAt ? { state: "due", text: "Due in " + itrDur(dueAt - now) } : { state: "breached", text: "Breached " + itrDur(now - dueAt) + " ago" };
  };
  var hours = sla.resolveHours[r.priority] || sla.resolveHours.P3;
  return { resp: one(r.firstResponseAt, start + sla.respondMinutes * 60000), resol: one(r.status === "done" ? itrResolvedAt(r) || now : 0, start + hours * 3600000) };
}
function itrSlaChip(x, label) { return x.state === "na" ? "" : '<span class="sla-chip sla-' + x.state + '" title="' + E(label) + '">' + E(label.split(" ")[0]) + " · " + E(x.text) + "</span>"; }

// The SLA tab: open tickets first (most urgent first), then the last 30
// days of resolved ones.
function renderItSlaTab(list) {
  var sla = itr.data.sla, cutoff = Date.now() - 30 * 864e5;
  var rows = list.filter(function (r) { return r.status !== "done" || itrResolvedAt(r) >= cutoff; }).map(function (r) { return { r: r, s: itrSla(r) }; })
    .filter(function (x) { return x.s.resp.state !== "na"; });
  var rank = { breached: 0, due: 1, late: 2, met: 3 };
  rows.sort(function (a, b) { return (a.r.status === "done") - (b.r.status === "done") || rank[a.s.resol.state] - rank[b.s.resol.state] || rank[a.s.resp.state] - rank[b.s.resp.state] || itrStart(a.r) - itrStart(b.r); });
  var resp = rows.filter(function (x) { return x.s.resp.state === "met" || x.s.resp.state === "late"; });
  var pct = resp.length ? Math.round(100 * resp.filter(function (x) { return x.s.resp.state === "met"; }).length / resp.length) + "%" : "—";
  var breached = rows.filter(function (x) { return x.s.resp.state === "breached" || x.s.resol.state === "breached"; }).length;
  var cell = function (x) { return '<span class="sla-chip sla-' + x.state + '">' + E(x.text) + "</span>"; };
  return '<div class="summary-cards four">' +
    metric("Responded on time", pct, "First response within " + sla.respondMinutes + " min (last 30 days)") +
    metric("Breached now", breached, "Open tickets past a target", breached > 0) +
    metric("Auto-acknowledged", rows.filter(function (x) { return x.r.ackAt; }).length, sla.ackOn ? "“We got your ticket” after " + sla.ackMinutes + " min" : "Switched off in Admin") +
    metric("Resolution targets", "P1 " + sla.resolveHours.P1 + "h", "P2 " + sla.resolveHours.P2 + "h · P3 " + sla.resolveHours.P3 + "h · P4 " + sla.resolveHours.P4 + "h") + "</div>" +
    '<div class="table-wrap"><table class="wide"><thead><tr><th>Ticket</th><th>Person</th><th>Priority</th><th>Status</th><th>Age</th><th>First response</th><th>Resolution</th></tr></thead><tbody>' +
    (rows.length ? rows.map(function (x) {
      var r = x.r;
      return "<tr><td><button type=\"button\" class=\"itr-open\" data-itr-open=\"" + E(r.id) + "\">" + E((r.ref ? r.ref + " · " : "") + String(r.issue || "—").slice(0, 70)) + "</button></td><td>" + E(itrPerson(r)) + "</td><td>" + E(r.priority || "P3 (not rated)") + "</td><td>" + E(IT_STATUS_LABEL[r.status]) + "</td><td>" + E(itrDur(Date.now() - itrStart(r))) + "</td><td>" + cell(x.s.resp) + (r.ackAt ? '<span class="co-note">Auto-acknowledged</span>' : "") + "</td><td>" + cell(x.s.resol) + "</td></tr>";
    }).join("") : '<tr><td colspan="7" class="empty">No tickets under SLA yet — SLAs count tickets that came in after they were switched on.</td></tr>') +
    "</tbody></table></div>" +
    '<p class="small-note" style="margin-top:10px;">First response = your first reply, or moving it off New. Resolution targets go by priority (unrated counts as P3). Change the targets in Admin → IT ticket SLAs.</p>';
}

// Board view: New / In progress / Resolved (last 14 days).
function renderItBoard(list, can) {
  var cutoff = Date.now() - 14 * 864e5;
  var col = function (st, label) {
    var cards = list.filter(function (r) { return r.status === st && (st !== "done" || itrResolvedAt(r) >= cutoff); })
      .sort(function (a, b) { return (a.priority || "P9").localeCompare(b.priority || "P9") || itrStart(a) - itrStart(b); });
    return '<section class="tk-col"><header><b>' + E(label) + '</b><span class="ib-n">' + cards.length + "</span></header>" + (cards.length ? cards.map(function (r) {
      var s = itrSla(r);
      return '<button type="button" class="tk-card" data-itr-open="' + E(r.id) + '">' +
        '<span class="tk-top">' + (r.priority ? '<span class="prio prio-' + E(r.priority) + '">' + E(r.priority) + "</span>" : "") + '<span class="co-note">' + E(r.ref || "") + "</span>" + (r.replyPending ? '<span class="sla-chip sla-due">Replied</span>' : "") + "</span>" +
        '<span class="tk-issue">' + E(String(r.issue || "—").slice(0, 110)) + "</span>" +
        '<span class="tk-who">' + E(itrPerson(r)) + " · " + E(itrDur(Date.now() - itrStart(r))) + " ago</span>" +
        (st !== "done" ? '<span class="tk-sla">' + itrSlaChip(s.resp, "Response target") + itrSlaChip(s.resol, "Resolution target") + "</span>" : "") + "</button>";
    }).join("") : '<div class="brd-empty">Nothing here</div>') + "</section>";
  };
  return '<div class="tk-cols">' + col("new", "New") + col("progress", "In progress") + col("done", "Resolved (14 days)") + "</div>";
}

// The card itself.
function itrCompose() { return itr.compose || (itr.compose = { kind: "reply", text: "", files: [], kbId: "" }); }
function openItCard(id) { itr.open = id; itr.compose = null; drawItCard(); if (itr.data && itr.data.notebook && !itr.kbList) api("/api/it-notebook").then(function (d) { itr.kbList = d.articles || []; if (itr.open) drawItCard(); }, function () { itr.kbList = []; }); }
function closeItCard() { itr.open = ""; itr.compose = null; var b = $("#itCard"); if (b) b.remove(); }
function drawItCard() {
  var r = itr.data && itr.data.requests.filter(function (x) { return x.id === itr.open; })[0];
  if (!r) { closeItCard(); return; }
  var can = itr.data.canRate, c = itrCompose(), s = itrSla(r);
  var files = r.files || [], fileById = {};
  files.forEach(function (f) { fileById[f.id] = f; });
  var when = function (t) { return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  var events = [{ at: itrStart(r), type: "submitted", text: r.issue || "", by: itrPerson(r) }].concat(r.activity || [],
    (r.replies || []).map(function (x) { return { at: x.at, type: "incoming", text: x.text, by: x.name || x.from }; }));
  events.sort(function (a, b) { return a.at - b.at; });
  var LABEL = { submitted: "Submitted", reply: "Emailed reply", note: "Internal work note", status: "Status", ack: "Auto-acknowledged", resolved: "Resolved email", incoming: "Requester replied" };
  var ev = function (a) {
    var fl = (a.files || []).map(function (fid) { var f = fileById[fid]; return f ? '<button type="button" class="text-button" data-itf-dl="' + E(f.id) + '">📎 ' + E(f.name) + "</button>" : ""; }).join(" ");
    return '<div class="tk-ev tk-' + a.type + '"><div class="tk-ev-h"><b>' + E(LABEL[a.type] || a.type) + (a.type === "status" ? " → " + E(a.text) : "") + "</b><span>" + E(a.by || "") + " · " + E(when(a.at)) + (a.emailedTo ? " · to " + E(a.emailedTo) : "") + "</span></div>" +
      (a.type !== "status" && a.text ? '<div class="tk-ev-b">' + E(a.text) + "</div>" : "") +
      (a.kb ? '<div class="small-note">Included KB-' + String(a.kb.kb).padStart(4, "0") + " · " + E(a.kb.title) + "</div>" : "") + (fl ? '<div class="tk-files">' + fl + "</div>" : "") + "</div>";
  };
  var pick = function (field, opts, cur) { return '<select data-itc="' + field + '">' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === cur ? " selected" : "") + ">" + E(o[1]) + "</option>"; }).join("") + "</select>"; };
  var kbs = (itr.kbList || []);
  var html = '<div class="rs-modal" data-itcard><div class="rs-card tk-card-modal" role="dialog" aria-modal="true" aria-labelledby="itcT">' +
    '<div class="brd-case-head"><div><div class="eyebrow">IT ticket' + (r.ref ? " · " + E(r.ref) : "") + " · " + E(r.company || "SOI") + '</div><h3 id="itcT">' + E(subjectIssue(r.issue || "IT request")) + "</h3>" +
      '<div class="small-note">' + E(itrPerson(r)) + " · submitted " + E(when(itrStart(r))) + (r.urgency ? " · form says " + E(r.urgency) : "") + "</div></div>" +
      '<button type="button" class="text-button" data-itc-close>Close ✕</button></div>' +
    '<div class="tk-meta">' +
      (can ? '<label>Status ' + pick("status", [["new", "New"], ["progress", "In progress"], ["done", "Resolved"]], r.status) + "</label>" +
        '<label>Priority ' + pick("priority", [["", "Not rated"]].concat(IT_PRIOS.map(function (p) { return [p.id, p.label]; })), r.priority || "") + "</label>" : "<span>" + E(IT_STATUS_LABEL[r.status]) + "</span>") +
      '<span class="tk-contact">' + E(r.email || "no email") + (can ? ' <button type="button" class="text-button" data-itr-email="' + E(r.id) + '">✎</button>' : "") + (r.phone ? " · " + E(r.phone) : "") + (r.contact ? " · prefers " + E(r.contact) : "") + "</span>" +
      '<span class="tk-sla">' + itrSlaChip(s.resp, "Response target") + itrSlaChip(s.resol, "Resolution target") + "</span></div>" +
    '<div class="tk-issue-full">' + E(r.issue || "No description.") + (r.notes ? "\n\n" + E(r.notes) : "") + "</div>" +
    '<div class="card-label" style="margin-top:14px;">Activity</div><div class="tk-timeline">' + events.map(ev).join("") + "</div>" +
    (can ? '<div class="tk-compose">' +
      '<div class="seg"><button type="button" data-itc-kind="reply" class="' + (c.kind === "reply" ? "active" : "") + '">Email the requester</button><button type="button" data-itc-kind="note" class="' + (c.kind === "note" ? "active" : "") + '">Internal work note</button></div>' +
      '<p class="small-note" style="margin:6px 0;">' + (c.kind === "reply" ? (r.email ? "Sent to " + E(r.email) + " as soon as you post it, with the ticket number so their reply comes back here." : "This ticket has no email — fix it with ✎, or add an internal note.") : "Only IT sees work notes; nothing is emailed.") + "</p>" +
      '<textarea id="itcText" rows="4" placeholder="' + (c.kind === "reply" ? "Update for the requester…" : "What you checked, what you tried, what's next…") + '">' + E(c.text) + "</textarea>" +
      '<div class="tk-compose-row">' +
        (c.files.length ? c.files.map(function (f) { return '<span class="fchip">📎 ' + E(f.name) + '<button type="button" data-itc-unfile="' + E(f.id) + '" aria-label="Remove">×</button></span>'; }).join("") : "") +
        '<input type="file" id="itcFile" multiple hidden><button type="button" data-itc-attach>📎 Attach files</button>' +
        (itr.data.notebook ? '<select data-itc-kb aria-label="Include a KB article"><option value="">Include a KB article…</option>' + kbs.map(function (a) { return '<option value="' + E(a.id) + '"' + (a.id === c.kbId ? " selected" : "") + ">KB-" + String(a.kb).padStart(4, "0") + " · " + E(a.title) + "</option>"; }).join("") + "</select>" : "") +
        '<span class="grow"></span><button type="button" class="primary" data-itc-post' + (itr.posting ? " disabled" : "") + ">" + (itr.posting ? "Sending…" : c.kind === "reply" ? "Send to requester" : "Add work note") + "</button></div></div>" : "") +
    '<div class="tk-foot">' + (can && r.status !== "done" ? '<button type="button" data-itc-resolve>Resolve…</button>' : "") +
      (itr.data.notebook ? '<button type="button" data-itc-kbnew>Write a KB article from this ticket</button>' : "") +
      (files.length ? '<span class="small-note">Files: ' + files.map(function (f) { return '<button type="button" class="text-button" data-itf-dl="' + E(f.id) + '">' + E(f.name) + "</button>"; }).join(", ") + "</span>" : "") + "</div>" +
    "</div></div>";
  var box = $("#itCard");
  if (!box) { box = document.createElement("div"); box.id = "itCard"; document.body.appendChild(box); }
  box.innerHTML = html;
  var tl = box.querySelector(".tk-timeline"); if (tl) tl.scrollTop = tl.scrollHeight;
}
function itcSaved(rec) {
  var i = itr.data.requests.findIndex(function (x) { return x.id === rec.id; });
  if (i !== -1) { matchPeople([rec]); itr.data.requests[i] = Object.assign({}, itr.data.requests[i], rec); }
  render(); drawItCard();
}
document.addEventListener("input", function (e) { if (e.target.id === "itcText" && itr.open) itrCompose().text = e.target.value; });
document.addEventListener("change", function (e) {
  var t = e.target;
  if (!itr.open || !t.closest || !t.closest("#itCard")) return;
  if (t.dataset.itc === "status") {
    if (t.value === "done") { var rid0 = itr.open; closeItCard(); resolveDialog([rid0]); return; }
    changeItRequests([itr.open], { status: t.value }); setTimeout(drawItCard, 50); return;
  }
  if (t.dataset.itc === "priority") { changeItRequests([itr.open], { priority: t.value }); setTimeout(drawItCard, 50); return; }
  if ("itcKb" in t.dataset) { itrCompose().kbId = t.value; return; }
  if (t.id === "itcFile") {
    var id = itr.open, list = Array.prototype.slice.call(t.files || []);
    list.reduce(function (p, f) {
      return p.then(function () {
        return fetch("/api/it-requests/" + encodeURIComponent(id) + "/files?name=" + encodeURIComponent(f.name), { method: "POST", headers: { Authorization: "Bearer " + token(), "Content-Type": "application/octet-stream" }, body: f })
          .then(function (res) { return res.json().then(function (x) { if (!res.ok) throw new Error(f.name + ": " + (x.error || "upload failed")); return x; }); })
          .then(function (meta) {
            itrCompose().files.push(meta);
            var r = itr.data.requests.filter(function (x) { return x.id === id; })[0]; if (r) { r.files = r.files || []; r.files.push(meta); }
          });
      });
    }, Promise.resolve()).then(drawItCard, function (err) { toast(err.message, true); drawItCard(); });
  }
});
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-itr-open],[data-itc-close],[data-itc-kind],[data-itc-attach],[data-itc-unfile],[data-itc-post],[data-itc-resolve],[data-itc-kbnew],[data-itf-dl],[data-itr-view]");
  if (!t) { if (e.target.hasAttribute && e.target.hasAttribute("data-itcard")) closeItCard(); return; }
  var ds = t.dataset;
  if ("itrView" in ds) { itr.view = ds.itrView; render(); return; }
  if ("itrOpen" in ds) { openItCard(ds.itrOpen); return; }
  if ("itcClose" in ds) { closeItCard(); return; }
  if ("itcKind" in ds) { itrCompose().kind = ds.itcKind; drawItCard(); return; }
  if ("itcAttach" in ds) { $("#itcFile").click(); return; }
  if ("itcUnfile" in ds) { var cc = itrCompose(); cc.files = cc.files.filter(function (f) { return f.id !== ds.itcUnfile; }); drawItCard(); return; }
  if ("itfDl" in ds) {
    var rr = itr.data.requests.filter(function (x) { return x.id === itr.open; })[0], meta = rr && (rr.files || []).filter(function (f) { return f.id === ds.itfDl; })[0];
    fetch("/api/it-requests/" + encodeURIComponent(itr.open) + "/files/" + encodeURIComponent(ds.itfDl), { headers: { Authorization: "Bearer " + token() } })
      .then(function (res) { if (!res.ok) throw new Error("Couldn't download that file"); return res.blob(); })
      .then(function (b) { var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = meta ? meta.name : "file"; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }, function (err) { toast(err.message, true); });
    return;
  }
  if ("itcResolve" in ds) { var rid = itr.open; closeItCard(); resolveDialog([rid]); return; }
  if ("itcPost" in ds) {
    var c = itrCompose(), id = itr.open;
    c.text = ($("#itcText") || {}).value || c.text;
    if (!c.text.trim() && !c.files.length && !c.kbId) { toast("Write something first.", true); return; }
    itr.posting = true; drawItCard();
    api("/api/it-requests/" + encodeURIComponent(id) + "/activity", { method: "POST", body: JSON.stringify({ kind: c.kind, text: c.text, fileIds: c.files.map(function (f) { return f.id; }), kbId: c.kbId }) })
      .then(function (rec) { itr.posting = false; var k = c.kind; itr.compose = { kind: k, text: "", files: [], kbId: "" }; toast(k === "reply" ? "Sent to " + rec.email + "." : "Work note added."); itcSaved(rec); },
            function (err) { itr.posting = false; drawItCard(); toast(err.message, true); });
    return;
  }
  if ("itcKbnew" in ds) {
    var r = itr.data.requests.filter(function (x) { return x.id === itr.open; })[0];
    if (!r) return;
    var parts = r.resolutionParts || {};
    var body = "# Problem\n" + (r.issue || "") + (parts.cause ? "\n\n# Cause\n" + parts.cause : "") + "\n\n# Fix\n" + (parts.fix || r.resolution || "") + (parts.action ? "\n\n# What the user needs to do\n" + parts.action : "");
    api("/api/it-notebook/articles", { method: "POST", body: JSON.stringify({ title: subjectIssue(r.issue || "IT fix"), body: body, fromRequest: r.id }) })
      .then(function (a) {
        api("/api/it-notebook/tickets/" + encodeURIComponent(r.id), { method: "PUT", body: JSON.stringify({ articleId: a.id }) }).catch(function () {});
        (itr.kbList = itr.kbList || []).unshift(a);
        nb.at = 0;
        toast("KB-" + String(a.kb).padStart(4, "0") + " created — finish it on IT → Resolved → Knowledge base.");
        drawItCard();
      }, function (err) { toast(err.message, true); });
  }
});
document.addEventListener("keydown", function (e) { if (e.key === "Escape" && itr.open && $("#itCard")) closeItCard(); });

// A ticket that didn't come through the form (a call, a walk-up, Teams).
function itrAddForm(plist) {
  var f = itr.form;
  var field = function (key, label, html) { return '<div class="nb-field"><label for="itf-' + key + '">' + label + "</label>" + html + "</div>"; };
  var inp = function (key, type, ph, extra) { return '<input id="itf-' + key + '" type="' + type + '" data-itr-f="' + key + '" value="' + E(f[key] || "") + '" placeholder="' + E(ph) + '" autocomplete="off"' + (extra || "") + ">"; };
  return '<div class="card" style="margin-bottom:14px;padding:20px 22px;"><div class="card-label">New ticket</div>' +
    '<datalist id="itrPeople">' + plist.map(function (p) { return '<option value="' + E(p.name) + '">'; }).join("") + "</datalist>" +
    '<div class="grid-2" style="gap:0 16px;">' +
      field("name", "Who's it for", inp("name", "text", "Name", ' list="itrPeople"')) +
      field("email", "Email (optional)", inp("email", "email", "name@soiaviation.com")) +
      field("company", "Company", '<select id="itf-company" data-itr-f="company">' + ["SOI", "CAS", "RedSun", "NanoTech"].map(function (c) {
        return '<option' + ((f.company || "SOI") === c ? " selected" : "") + ">" + c + "</option>"; }).join("") + "</select>") +
      field("priority", "Priority", '<select id="itf-priority" data-itr-f="priority"><option value="">Rate later</option>' + IT_PRIOS.map(function (p) {
        return '<option value="' + p.id + '"' + (f.priority === p.id ? " selected" : "") + ">" + E(p.label) + "</option>"; }).join("") + "</select>") +
    "</div>" +
    field("issue", "What's the issue", '<textarea id="itf-issue" rows="3" data-itr-f="issue" placeholder="e.g. Outlook keeps asking for a password">' + E(f.issue || "") + "</textarea>") +
    '<div class="nb-foot"><button type="button" class="primary" data-itr-save' + (itr.saving ? " disabled" : "") + ">" + (itr.saving ? "Adding…" : "Add ticket") + '</button><button type="button" class="text-button" data-itr-cancel>Cancel</button>' +
    '<span class="small-note">It starts as New here on Requests.</span></div></div>';
}
document.addEventListener("input", function (e) { var k = e.target.dataset && e.target.dataset.itrF; if (k) itr.form[k] = e.target.value; });
document.addEventListener("change", function (e) { var k = e.target.dataset && e.target.dataset.itrF; if (k) itr.form[k] = e.target.value; });

// Whether form emails are coming through, and why not if they aren't.
function itSyncLine(st, can) {
  if (!st) return "";
  var btn = can ? ' <button type="button" class="text-button" data-itr-checknow>Check now</button>' : "";
  if (!st.configured) return '<div class="banner"><b>Form emails aren\'t connected.</b> Set <code>IT_REQUESTS_MAILBOX</code> on the stack in Portainer to the mailbox the flow emails (and redeploy). Until then, only imported answers show here.</div>';
  if (st.ok === false) return '<div class="banner"><b>Couldn\'t check ' + E(st.mailbox) + " for form emails.</b> " + E(st.error) + btn + "</div>";
  var ago = st.at ? Math.max(0, Math.round((Date.now() - st.at) / 60000)) : null;
  return '<p class="small-note" style="margin:14px 0 0;">Form emails: <b>' + E(st.mailbox) + "</b> · " +
    (ago == null ? "first check in progress" : "checked " + (ago < 1 ? "just now" : ago + " min ago") + " · " + st.matched + " form email" + (st.matched === 1 ? "" : "s") + " in the last 2 weeks" + (st.added ? ", " + st.added + " new" : "")) +
    (st.replies ? " · " + st.replies + " ticket repl" + (st.replies === 1 ? "y" : "ies") + " picked up" : "") +
    (st.unmatched ? " · " + st.unmatched + " repl" + (st.unmatched === 1 ? "y" : "ies") + " with a ticket number that isn't here" : "") +
    " · every " + st.everyMinutes + " minutes" + btn + "</p>";
}
// Resolving asks how it was resolved and offers to email the requester
// (the email asks them to reply if the issue is still there; replies come
// to you).
// Same as the server's subject line (index.js subjectIssue): first sentence
// if it's long enough, up to 100 characters, never cutting a word.
function subjectIssue(text) {
  var t = String(text || "").replace(/\s+/g, " ").trim();
  var first = (t.match(/^.*?[.!?](?=\s|$)/) || [t])[0];
  var pick = first.length >= 20 ? first : t;
  if (pick.length <= 100) return pick.replace(/[.!?]+$/, "");
  return pick.slice(0, 100).replace(/\s+\S*$/, "") + "…";
}
function resolveDialog(ids) {
  var list = itr.data.requests.filter(function (r) { return ids.indexOf(r.id) !== -1; });
  var withEmail = list.filter(function (r) { return r.email; });
  var one = list.length === 1 ? list[0] : null;
  var who = (me && (me.name || me.username)) || "IT";
  who = who.charAt(0).toUpperCase() + who.slice(1);
  var fld = function (id, label, rows, ph, val) {
    return '<div class="nb-field"><label for="rs-' + id + '">' + label + '</label><textarea id="rs-' + id + '" data-rs-part="' + id + '" rows="' + rows + '" placeholder="' + E(ph) + '">' + E(val || "") + "</textarea></div>";
  };
  var box = document.createElement("div");
  box.className = "rs-modal";
  box.innerHTML = '<div class="rs-card rs-wide" role="dialog" aria-modal="true" aria-labelledby="rsTitle"><h3 id="rsTitle">Resolve ' + (one ? "this ticket" : list.length + " tickets") + "</h3>" +
    (one ? '<p class="small-note" style="margin:0 0 10px;">' + E(itrPerson(one)) + (one.submittedAt ? " · " + E(fmtDate(one.submittedAt)) : "") + "</p>" : "") +
    fld("issue", "What was the issue?", 2, one ? "" : "Leave blank to use each ticket's own description", one ? String(one.issue || "").slice(0, 600) : "") +
    fld("cause", 'What caused it? <span class="opt">optional</span>', 2, "e.g. A saved password from before the reset.") +
    fld("fix", "How did you fix it?", 3, "e.g. Cleared the saved password and signed back in to Outlook.") +
    fld("action", 'Anything they need to do? <span class="opt">optional</span>', 2, "e.g. Restart your laptop once before signing in.") +
    // One ticket: the address can be fixed here (it's saved on the ticket).
    (one ? '<div class="rs-email"><label class="small-note" style="display:flex;gap:7px;align-items:center;"><input type="checkbox" class="check" id="rsNotify"' + (one.email ? " checked" : "") + "> <span>Email the requester at</span></label>" +
        '<input id="rsEmail" type="email" value="' + E(one.email || "") + '" placeholder="name@company.com" aria-label="Requester email">' +
        '<span class="small-note">Wrong address? Fix it here — it\'s saved on the ticket. Replies come to you and show up on the ticket.</span></div>' +
        '<div class="rs-preview" id="rsPreview" aria-live="polite"></div>'
    : withEmail.length ? '<label class="small-note" style="display:flex;gap:7px;align-items:flex-start;margin-top:4px;"><input type="checkbox" class="check" id="rsNotify" checked> <span>Email ' + (withEmail.length === 1 ? E(withEmail[0].email) : withEmail.length + " requesters") + " — replies come to you and show up on the ticket here.</span></label>" +
        (withEmail.length < list.length ? '<p class="small-note" style="margin:6px 0 0;">' + (list.length - withEmail.length) + " without an email won't be emailed.</p>" : "") +
        '<div class="rs-preview" id="rsPreview" aria-live="polite"></div>'
      : '<p class="small-note">No email on ' + (one ? "this ticket" : "these tickets") + ", so nobody will be emailed.</p>") +
    '<div class="nb-foot" style="margin-top:14px;"><span class="grow"></span><button type="button" class="text-button" data-rs-cancel>Cancel</button><button type="button" class="primary" data-rs-ok>Resolve</button></div></div>';
  document.body.appendChild(box);
  var parts = function () {
    var o = {};
    box.querySelectorAll("[data-rs-part]").forEach(function (t) { var v = t.value.trim(); if (v) o[t.dataset.rsPart] = v; });
    return o;
  };
  // What the email will look like, for the first ticket with an email.
  var preview = function () {
    var pv = $("#rsPreview"), n = $("#rsNotify");
    if (!pv) return;
    pv.hidden = !(n && n.checked);
    var r = one ? Object.assign({}, one, { email: (($("#rsEmail") || {}).value || "").trim() }) : withEmail[0], p = parts();
    var sec = function (label, t) { return t ? "<p><b>" + label + "</b><br>" + E(t).replace(/\n/g, "<br>") + "</p>" : ""; };
    pv.innerHTML = '<div class="rs-pv-head">Preview' + (one ? " — to " + E(r.email || "(no address yet)") : withEmail.length > 1 ? " (first of " + withEmail.length + ")" : "") + '</div><div class="rs-pv-subj">Resolved: your IT request — ' + E(subjectIssue(r.issue)) + "</div>" +
      "<p>Hi " + E((r.name || "").split(" ")[0] || "there") + ",</p><p>Good news — your IT request" + (r.submittedAt ? " from " + E(String(r.submittedAt).slice(0, 10)) : "") + " has been <b>resolved</b>.</p>" +
      '<div class="rs-pv-box">' + sec("The issue", p.issue || r.issue) + sec("What caused it", p.cause) + sec("How it was fixed", p.fix || "…") + sec("What you need to do", p.action) + "</div>" +
      "<p>If you're still having this issue, just reply to this email and it'll come straight to " + E(who) + ".</p><p>Thanks,<br>" + E(who) + "<br>SOI Aviation IT</p>";
  };
  preview();
  box.addEventListener("input", function (e) {
    if (e.target.id === "rsEmail" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.target.value.trim())) { var nb = $("#rsNotify"); if (nb) nb.checked = true; }
  });
  box.addEventListener("input", preview);
  box.addEventListener("change", preview);
  var close = function () { box.remove(); render(); };
  box.addEventListener("click", function (e) {
    if (e.target === box || e.target.closest("[data-rs-cancel]")) { close(); return; }
    if (e.target.closest("[data-rs-ok]")) {
      var p = parts(), notify = !!($("#rsNotify") && $("#rsNotify").checked);
      var change = { status: "done", parts: p, notify: notify };
      if (one) {
        var addr = (($("#rsEmail") || {}).value || "").trim();
        if (addr && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) { toast("That email address doesn't look right.", true); $("#rsEmail").focus(); return; }
        if (notify && !addr) { toast("Add the requester's email, or untick Email.", true); $("#rsEmail").focus(); return; }
        if (addr !== (one.email || "")) change.email = addr;
      }
      if (notify && !p.fix && !confirm("Send the email without saying how it was fixed?")) return;
      box.remove();
      changeItRequests(ids, change);
    }
  });
  box.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  setTimeout(function () { var n = $(one ? "#rs-fix" : "#rs-issue"); if (n) n.focus(); }, 0);
}
function changeItRequests(ids, change) {
  var set = {}; ids.forEach(function (id) { set[id] = 1; });
  var hit = itr.data ? itr.data.requests.filter(function (x) { return set[x.id]; }) : [];
  hit.forEach(function (r) {
    Object.assign(r, change);
    if ("duplicateOf" in change) { r.status = change.duplicateOf ? "done" : change.status || "progress"; r.notDuplicate = !change.duplicateOf; }
  });
  render();
  var req = ids.length === 1
    ? api("/api/it-requests/" + encodeURIComponent(ids[0]), { method: "PATCH", body: JSON.stringify(change) })
    : api("/api/it-requests/bulk", { method: "POST", body: JSON.stringify(Object.assign({ ids: ids }, change)) });
  req.then(function (res) {
    if (hit.some(function (r) { return r.taskId; })) refresh();
    if (change.notify && res) {
      var probs = res.emailProblems || [];
      toast((res.emailed ? "Resolved — emailed " + res.emailed + " requester" + (res.emailed === 1 ? "" : "s") + "." : "Resolved.") + (probs.length ? " Not emailed — " + probs.join("; ") : ""), !!probs.length);
      itr.at = 0; requestRender();
    } else if (change.parts) { itr.at = 0; requestRender(); if (ids.length > 1) toast(ids.length + " requests marked Resolved."); }
    else if (change.status && ids.length > 1) toast(ids.length + " requests marked " + IT_STATUS_LABEL[change.status] + ".");
    if (change.duplicateOf) toast(ids.length === 1 ? "Marked as a duplicate." : ids.length + " requests merged as duplicates.");
    if ("duplicateOf" in change || "archived" in change) { itr.at = 0; requestRender(); }
    nb.at = 0; // the Resolved tab picks it up next time
  }, function (err) { toast(err.message, true); itr.at = 0; render(); });
}
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-itr-email],[data-itr-archive],[data-itr-restore],[data-itr-delete],[data-itr-reopen],[data-itr-keep],[data-itr-replied],[data-itr-tab],[data-itr-who],[data-itr-bulk],[data-itr-clear],[data-itr-merge],[data-itr-dup],[data-itr-notdup],[data-itr-undup],[data-itr-main],[data-itr-checknow],[data-itr-add],[data-itr-save],[data-itr-cancel],#itrImport");
  if (!t) return;
  var ds = t.dataset;
  if ("itrArchive" in ds || "itrRestore" in ds) {
    var arch = "itrArchive" in ds, aid = arch ? ds.itrArchive : ds.itrRestore;
    var aids = aid ? [aid] : Object.keys(itr.picked);
    if (!aids.length) return;
    itr.picked = {};
    changeItRequests(aids, { archived: arch });
    toast(aids.length === 1 ? (arch ? "Archived — it's on the Archived tab." : "Restored.") : aids.length + " requests " + (arch ? "archived." : "restored."));
    return;
  }
  if ("itrDelete" in ds) {
    var dids = ds.itrDelete ? [ds.itrDelete] : Object.keys(itr.picked);
    if (!dids.length) return;
    if (!confirm("Delete " + (dids.length === 1 ? "this request" : dids.length + " requests") + " forever?\n\nIts IT task and notebook write-up go too. This can't be undone.")) return;
    itr.picked = {};
    api("/api/it-requests/delete", { method: "POST", body: JSON.stringify({ ids: dids }) }).then(function (r) {
      toast(r.deleted + " request" + (r.deleted === 1 ? "" : "s") + " deleted forever.");
      itr.at = 0; nb.at = 0; requestRender(); refresh();
    }, function (err) { toast(err.message, true); });
    return;
  }
  if ("itrEmail" in ds) {
    var er = itr.data.requests.filter(function (x) { return x.id === ds.itrEmail; })[0];
    if (!er) return;
    var na = prompt("Email address for " + itrPerson(er) + ":", er.email || "");
    if (na == null) return;
    na = na.trim();
    if (na && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(na)) { toast("That email address doesn't look right.", true); return; }
    if (na === (er.email || "")) return;
    changeItRequests([er.id], { email: na });
    toast(na ? "Email changed to " + na + "." : "Email removed.");
    return;
  }
  if ("itrReopen" in ds) { changeItRequests([ds.itrReopen], { status: "progress", replySeen: true, replyPending: false }); toast("Reopened — it's In progress again."); return; }
  if ("itrKeep" in ds) { changeItRequests([ds.itrKeep], { replySeen: true, replyPending: false }); return; }
  if ("itrReplied" in ds) { itr.tab = "done"; itr.person = ""; render(); return; }
  if (t.id === "itrImport") { $("#itrFile").click(); return; }
  if ("itrAdd" in ds) { itr.adding = true; render(); var n = $("#itf-name"); if (n) n.focus(); return; }
  if ("itrCancel" in ds) { itr.adding = false; itr.form = {}; render(); return; }
  if ("itrSave" in ds) {
    var f = itr.form;
    if (!String(f.issue || "").trim()) { toast("Describe the issue first.", true); var iss = $("#itf-issue"); if (iss) iss.focus(); return; }
    itr.saving = true; render();
    api("/api/it-requests", { method: "POST", body: JSON.stringify({ name: f.name, email: f.email, company: f.company || "SOI", priority: f.priority, issue: f.issue }) }).then(function () {
      itr.saving = false; itr.adding = false; itr.form = {}; itr.tab = "new"; itr.at = 0;
      toast("Ticket added.");
      render(); refresh();
    }, function (err) { itr.saving = false; toast(err.message, true); render(); });
    return;
  }
  if ("itrChecknow" in ds) {
    t.disabled = true; t.textContent = "Checking…";
    api("/api/it-requests/check-now", { method: "POST", body: "{}" }).then(function (st) {
      if (itr.data) itr.data.sync = st;
      toast(st.ok === false ? "Couldn't check: " + st.error : st.added ? st.added + " new request" + (st.added === 1 ? "" : "s") + " added." : "Checked — " + st.matched + " form email" + (st.matched === 1 ? "" : "s") + ", nothing new.", st.ok === false);
      itr.at = 0; render(); if (st.added) refresh();
    }, function (err) { toast(err.message, true); render(); });
    return;
  }
  if (ds.itrTab) { itr.tab = ds.itrTab; render(); return; }
  if ("itrWho" in ds) { itr.person = itr.person === ds.itrWho ? "" : ds.itrWho; render(); window.scrollTo(0, 0); return; }
  if (ds.itrBulk) {
    var ids = Object.keys(itr.picked);
    if (!ids.length) return;
    itr.picked = {};
    if (ds.itrBulk === "done") resolveDialog(ids); else changeItRequests(ids, { status: ds.itrBulk });
    return;
  }
  if ("itrClear" in ds) { itr.picked = {}; render(); }
  if (ds.itrMerge) {
    var sel = itr.data.requests.filter(function (r) { return itr.picked[r.id]; })
      .sort(function (a, b) { return String(a.submittedAt).localeCompare(String(b.submittedAt)); });
    if (sel.length < 2) return;
    if (ds.itrMerge === "newest") sel.reverse();
    var keep = sel[0];
    if (keep.duplicateOf) {
      // The one to keep is itself a duplicate: make it the main one first.
      toast("Use “Make this the main one” on that request first.", true);
      return;
    }
    if (!confirm("Keep the " + fmtDate(keep.submittedAt) + " request from " + itrPerson(keep) + " and mark the other " + (sel.length - 1) + " as its duplicates?")) return;
    itr.picked = {};
    changeItRequests(sel.slice(1).map(function (r) { return r.id; }), { duplicateOf: keep.duplicateOf || keep.id });
  }
  if (ds.itrDup) changeItRequests([ds.itrDup], { duplicateOf: ds.of });
  if (ds.itrNotdup) changeItRequests([ds.itrNotdup], { notDuplicate: true });
  if (ds.itrUndup) changeItRequests([ds.itrUndup], { duplicateOf: "" });
  if (ds.itrMain) {
    api("/api/it-requests/" + encodeURIComponent(ds.itrMain), { method: "PATCH", body: JSON.stringify({ makeOriginal: true }) }).then(function () {
      toast("That's the main request now; the others are its duplicates.");
      itr.at = 0; nb.at = 0; render(); refresh();
    }, function (err) { toast(err.message, true); });
  }
});
document.addEventListener("change", function (e) {
  var t = e.target;
  if (t.id === "itrPerson") { itr.person = t.value; render(); }
  else if (t.id === "itrSort") { itr.sort = t.value; render(); }
  else if (t.dataset && t.dataset.itrPrio) changeItRequests([t.dataset.itrPrio], { priority: t.value });
  else if (t.dataset && t.dataset.itrSt) {
    var cur = itr.data.requests.filter(function (x) { return x.id === t.dataset.itrSt; })[0];
    if (cur && cur.duplicateOf) { if (t.value !== "dup") changeItRequests([cur.id], { duplicateOf: "", status: t.value }); }
    else if (t.value === "done") resolveDialog([t.dataset.itrSt]);
    else changeItRequests([t.dataset.itrSt], { status: t.value });
  }
  else if (t.dataset && t.dataset.itrPick) { if (t.checked) itr.picked[t.dataset.itrPick] = 1; else delete itr.picked[t.dataset.itrPick]; render(); }
  else if (t.dataset && "itrPickall" in t.dataset) {
    Array.prototype.forEach.call(document.querySelectorAll("[data-itr-pick]"), function (box) { if (t.checked) itr.picked[box.dataset.itrPick] = 1; else delete itr.picked[box.dataset.itrPick]; });
    render();
  }
  else if (t.id === "itrFile" && t.files && t.files[0]) {
    var file = t.files[0];
    toast("Importing " + file.name + "…");
    fetch("/api/it-requests/import", { method: "POST", headers: { "Content-Type": "application/octet-stream", Authorization: "Bearer " + token() }, body: file })
      .then(function (res) { return res.json().then(function (d) { if (!res.ok) throw new Error(d.error || "Import failed"); return d; }); })
      .then(function (d) { toast("Imported " + d.rows + " responses: " + d.added + " new, " + d.updated + " updated."); itr.at = 0; render(); },
            function (err) { toast(err.message, true); });
  }
});

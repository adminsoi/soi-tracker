"use strict";
// Documents: department folders on SOI's S3 and each board file's documents.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- Documents ----
// Read-only unless you're a document editor or one granted you edit access to a folder (the server
// checks every request). Edit = add files and folders, new versions, rename,
// move (drag onto a folder or the path above), archive. Documents open in a
// viewer on the page with no download link; big copies are blocked. That only
// discourages copying — a screenshot still works — and the page says so.
var dcs = { meta: null, metaAt: 0, loading: false, error: "", space: "", folder: "", list: null, listKey: "", listAt: 0, listLoading: "", listError: "",
  tab: "browse", access: null, accessAt: 0, accessLoading: false, accessError: "", until: {}, noExpiry: {}, dragOver: false };
var DC_COPY_MAX = 200; // characters; bigger copies on this page are blocked
var DC_PREVIEW = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/csv"]; // as documents.js on the server

function loadDocMeta() {
  if (dcs.loading) return;
  dcs.loading = true;
  api("/api/documents").then(function (d) { dcs.meta = d; dcs.error = ""; }, function (err) { dcs.error = err.message; })
    .then(function () { dcs.loading = false; dcs.metaAt = Date.now(); requestRender(); });
}
function dcKey() { return dcs.space + "/" + dcs.folder; }
function loadDocList() {
  var key = dcKey();
  if (dcs.listLoading === key) return;
  dcs.listLoading = key;
  api("/api/documents/list?space=" + encodeURIComponent(dcs.space) + "&folder=" + encodeURIComponent(dcs.folder)).then(function (d) {
    if (dcKey() !== key) return;
    dcs.list = d; dcs.listKey = key; dcs.listError = "";
  }, function (err) { if (dcKey() === key) { dcs.listError = err.message; dcs.listKey = key; dcs.list = null; } })
    .then(function () { dcs.listLoading = ""; dcs.listAt = Date.now(); requestRender(); });
}
function loadDocAccess() {
  if (dcs.accessLoading) return;
  dcs.accessLoading = true;
  api("/api/documents/access").then(function (d) { dcs.access = d; dcs.accessError = ""; }, function (err) { dcs.accessError = err.message; })
    .then(function () { dcs.accessLoading = false; dcs.accessAt = Date.now(); requestRender(); });
}
function dcRefresh() { dcs.listAt = 0; dcs.metaAt = 0; dcs.accessAt = 0; requestRender(); }
function dcSpace(id) { return ((dcs.meta && dcs.meta.spaces) || []).filter(function (s) { return s.id === id; })[0] || null; }
function dcOpen(space, folder) { dcs.space = space; dcs.folder = folder || ""; dcs.list = null; dcs.listError = ""; render(); }
function dcSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
function dcDate(ms) { return ms ? new Date(ms).toLocaleDateString() : ""; }
function dcInDays(n) { var d = new Date(Date.now() + n * 86400000); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
// HR and Finance folders are for policies and templates, not people's files.
var DC_PRIVATE_NOTE = { "HR": "Not for employment files, pay or performance — those stay on People, HR → Payroll and Performance.",
  "Accounting & Finance": "Not for receipts or reimbursements — those stay on Finance." };

function renderDocuments() {
  setBreadcrumb(["Company", "Documents"]);
  if (!dcs.loading && (dcs.error ? Date.now() - dcs.metaAt > 15000 : !dcs.meta || Date.now() - dcs.metaAt > 60000)) loadDocMeta();
  var admin = dcs.meta && dcs.meta.grantsAdmin;
  if (!admin && dcs.tab === "access") dcs.tab = "browse";
  var head = '<div class="intro"><div><div class="eyebrow">Company</div><h1>Documents</h1>' +
    "<p>Your departments' folders on SOI's S3, and the documents on each Operations and US Gov board file you can see. Only the document editors (Ramin, Greg, Shreya and Nyssa) change files directly; everyone else uses <b>Request to edit</b> on a folder, and an editor grants it.</p>" +
    "<p>There's no download button and large copies are blocked, but that only discourages copying — anyone can still take a screenshot or photo of the screen. Treat everything here as confidential. Employment files, pay, performance and receipts are not in Documents.</p></div></div>";
  if (dcs.error && !dcs.meta) return head + '<div class="banner">' + E(dcs.error) + "</div>";
  if (!dcs.meta) return head + '<div class="empty">Loading folders…</div>';
  var tabs = admin ? '<div class="tabs" role="tablist">' +
    '<button type="button" role="tab" class="tab ' + (dcs.tab === "browse" ? "active" : "") + '" aria-selected="' + (dcs.tab === "browse") + '" data-dc-tab="browse">Folders</button>' +
    '<button type="button" role="tab" class="tab ' + (dcs.tab === "access" ? "active" : "") + '" aria-selected="' + (dcs.tab === "access") + '" data-dc-tab="access">Edit requests' + (dcs.access && dcs.access.requests.length ? " · " + dcs.access.requests.length : "") + "</button></div>" : "";
  if (admin && (!dcs.access || Date.now() - dcs.accessAt > 60000) && !dcs.accessLoading && !(dcs.accessError && Date.now() - dcs.accessAt < 15000)) loadDocAccess();
  if (dcs.tab === "access") return head + tabs + renderDocAccess();
  return head + tabs + (dcs.space && dcSpace(dcs.space) ? renderDocFolder() : renderDocSpaces());
}

// Every space you can see: department folders by company, then board files.
function renderDocSpaces() {
  dcs.space = "";
  var spaces = dcs.meta.spaces;
  if (!spaces.length) return '<div class="empty">Your login has no departments yet. Ask an admin to add one.</div>';
  var byCo = {}, boards = [];
  spaces.forEach(function (s) { if (s.kind === "board") boards.push(s); else (byCo[s.company] = byCo[s.company] || []).push(s); });
  var cos = COMPANY_ORDER.filter(function (c) { return byCo[c]; });
  var order = function (a, b) { var i = DEPT_ORDER.indexOf(a.dept), j = DEPT_ORDER.indexOf(b.dept); return (i === -1 ? 99 : i) - (j === -1 ? 99 : j); };
  var tile = function (s, sub) {
    return '<button type="button" class="dc-tile" data-dc-space="' + E(s.id) + '"><span class="dc-ic" aria-hidden="true">📁</span><b>' + E(s.label) + "</b><small>" + E(sub) + "</small></button>";
  };
  var grants = dcs.meta.grants.length ? '<div class="banner">You can edit: ' + dcs.meta.grants.map(function (g) {
    return "<b>" + E(g.path) + "</b> (" + (g.until ? "until " + E(dcDate(g.until)) : "no end date") + ")";
  }).join(", ") + ".</div>" : "";
  return grants + cos.map(function (c) {
    return '<div class="card-label dc-group">' + E(cos.length > 1 ? c : "Department folders") + '</div><div class="dc-tiles">' +
      byCo[c].sort(order).map(function (s) { return tile(s, cos.length > 1 ? COMPANY_SHORT[c] + " · department folder" : "Department folder"); }).join("") + "</div>";
  }).join("") + (boards.length ? '<div class="card-label dc-group">Board files</div><div class="dc-tiles">' +
    boards.map(function (s) { return tile(s, "One folder per board file · read-only"); }).join("") + "</div>" : "");
}

function renderDocFolder() {
  var sp = dcSpace(dcs.space);
  if (dcs.listKey !== dcKey() || (!dcs.listLoading && Date.now() - dcs.listAt > 60000 && !dcs.listError)) loadDocList();
  var d = dcs.listKey === dcKey() ? dcs.list : null;
  var crumbs = '<div class="dc-path" role="navigation" aria-label="Folder path"><button type="button" class="text-button" data-dc-home>All folders</button> › ' +
    '<button type="button" class="text-button" data-dc-crumb="" data-dc-drop="">' + E((sp.kind === "dept" && dcs.meta.spaces.some(function (s) { return s.kind === "dept" && s.company !== sp.company; }) ? COMPANY_SHORT[sp.company] + " · " : "") + sp.label) + "</button>" +
    (d ? d.path.map(function (p) { return ' › <button type="button" class="text-button" data-dc-crumb="' + E(p.id) + '" data-dc-drop="' + E(p.id) + '">' + E(p.name) + "</button>"; }).join("") : "") + "</div>";
  if (dcs.listError && dcs.listKey === dcKey()) return crumbs + '<div class="banner">' + E(dcs.listError) + "</div>";
  if (!d) return crumbs + '<div class="empty">Loading…</div>';
  var bar;
  if (sp.kind === "board") bar = '<span class="dc-badge">Read-only</span><span class="small-note">Add or change these documents on the board file\'s case file.</span>';
  else if (d.canEdit) bar = '<span class="dc-badge dc-edit">You can edit here' + (d.editUntil ? " until " + E(dcDate(d.editUntil)) : d.editUntil === null ? " (no end date)" : "") + "</span>" +
    '<button type="button" data-dc-newfolder>+ New folder</button><button type="button" class="primary" data-dc-upload>Upload files</button>' +
    '<input type="file" id="dcFile" multiple hidden><input type="file" id="dcVersion" hidden>';
  else bar = '<span class="dc-badge">View only</span>' + (d.request
    ? '<span class="small-note">Edit requested — ticket ' + E(d.request.ref) + " is with the document editors and IT.</span>"
    : '<button type="button" data-dc-request>Request to edit</button><span class="small-note">Only the document editors change files directly; ask and one of them grants you access.</span>');
  var note = sp.kind === "dept" && DC_PRIVATE_NOTE[sp.dept] ? '<p class="small-note">' + E(DC_PRIVATE_NOTE[sp.dept]) + "</p>" : "";
  var rows = d.folders.map(function (f) {
    return '<tr class="dc-row" data-dc-folder="' + E(f.id) + '" data-dc-drop="' + E(f.id) + '"' + (d.canEdit ? ' draggable="true" data-dc-drag="folder:' + E(f.id) + '"' : "") + ">" +
      '<td><span class="dc-ic" aria-hidden="true">📁</span><button type="button" class="dc-name" data-dc-folder-open="' + E(f.id) + '">' + E(f.name) + "</button>" + (f.count ? ' <span class="small-note">' + f.count + " document" + (f.count === 1 ? "" : "s") + "</span>" : "") + "</td>" +
      "<td>Folder</td><td></td><td>" + E(dcDate(f.at)) + "</td><td>" + E(f.by || "") + "</td>" +
      '<td class="dc-acts">' + (d.canEdit ? '<button type="button" class="text-button" data-dc-rename-folder="' + E(f.id) + '">Rename</button><button type="button" class="text-button danger" data-dc-archive-folder="' + E(f.id) + '">Archive</button>' : "") + "</td></tr>";
  }).concat(d.files.map(function (f) {
    return '<tr class="dc-row"' + (d.canEdit ? ' draggable="true" data-dc-drag="file:' + E(f.id) + '"' : "") + ">" +
      '<td><span class="dc-ic" aria-hidden="true">' + "📄" + '</span><button type="button" class="dc-name" data-dc-view="' + E(f.id) + '">' + E(f.name) + "</button>" + (f.versions > 1 ? ' <span class="small-note">v' + f.versions + "</span>" : "") + "</td>" +
      "<td>" + E(dcKind(f.type)) + "</td><td>" + E(dcSize(f.size)) + "</td><td>" + E(dcDate(f.at)) + "</td><td>" + E(f.by || "") + "</td>" +
      // Preview first and easy to spot; Edit in Word downloads it for editors.
      '<td class="dc-acts"><button type="button" class="dc-preview" data-dc-view="' + E(f.id) + '" title="' + (f.preview ? "Open it here" : "No preview for this kind of file") + '">' + (f.preview ? "👁 Preview" : "Open") + "</button>" +
      (d.canEdit && sp.kind === "dept" ? '<button type="button" class="dc-preview" data-dc-edit="' + E(f.id) + '" title="Download it, edit it in Word (or its own app), then upload it with New version">✎ Edit in Word</button>' : "") +
      '<button type="button" class="text-button" data-dc-addto="' + E(f.id) + '">Add to…</button>' + (d.canEdit ? '<button type="button" class="text-button" data-dc-version="' + E(f.id) + '">New version</button><button type="button" class="text-button" data-dc-rename="' + E(f.id) + '">Rename</button><button type="button" class="text-button danger" data-dc-archive="' + E(f.id) + '">Archive</button>' : "") + "</td></tr>";
  }));
  var table = rows.length ? '<table class="plain dc-table"><thead><tr><th>Name</th><th>Kind</th><th>Size</th><th>Updated</th><th>By</th><th></th></tr></thead><tbody>' + rows.join("") + "</tbody></table>"
    : '<div class="empty">' + (d.canEdit ? "This folder is empty. Drag files here from your computer, or use Upload files." : "This folder is empty.") + "</div>";
  return crumbs + '<div class="dc-bar">' + bar + "</div>" + note +
    '<div class="card dc-drop' + (d.canEdit ? " dc-can-drop" : "") + (dcs.dragOver ? " dc-over" : "") + '" id="dcDrop">' + table +
    (d.canEdit && rows.length ? '<p class="small-note dc-hint">Drag files here from your computer to upload. Drag a row onto a folder, or onto a name in the path above, to move it.</p>' : "") + "</div>";
}
function dcKind(type) {
  if (type === "application/pdf") return "PDF";
  if (/^image\//.test(type)) return "Picture";
  if (type === "text/csv") return "CSV";
  if (type === "text/plain") return "Text";
  if (/word/.test(type)) return "Word";
  if (/sheet|excel/.test(type)) return "Excel";
  if (/presentation/.test(type)) return "PowerPoint";
  if (/outlook|rfc822/.test(type)) return "Email";
  return "File";
}

// ---- IT: requests, grants and archived items ----
function renderDocAccess() {
  if (dcs.accessError && !dcs.access) return '<div class="banner">' + E(dcs.accessError) + "</div>";
  var a = dcs.access;
  if (!a) return '<div class="empty">Loading…</div>';
  var reqs = a.requests.length ? '<table class="plain dc-table"><thead><tr><th>Ticket</th><th>Who</th><th>Folder</th><th>Why</th><th>Until</th><th></th></tr></thead><tbody>' +
    a.requests.map(function (r) {
      var self = sameUser(r.by, me.username), none = !!dcs.noExpiry[r.id];
      return "<tr><td>" + E(r.ref) + "<span class=\"co-note\">" + E(dcDate(r.at)) + "</span></td><td>" + E(r.by) + "</td><td>" + E(r.where) + (r.gone ? ' <span class="small-note">(folder archived)</span>' : "") + "</td>" +
        "<td>" + E(String(r.issue || "").replace(/^Edit access to Documents › [^:]*: /, "")) + "</td>" +
        '<td><input type="date" data-dc-until="' + E(r.id) + '" value="' + E(dcs.until[r.id] || dcInDays(a.grantDays)) + '"' + (none ? " disabled" : "") + ' aria-label="Edit access ends"><label class="small-note dc-noexp"><input type="checkbox" data-dc-noexp="' + E(r.id) + '"' + (none ? " checked" : "") + "> No end date</label></td>" +
        '<td class="dc-acts">' + (self ? '<span class="small-note">Your own — someone else in IT decides it</span>' :
          '<button type="button" class="primary" data-dc-grant="' + E(r.id) + '"' + (r.gone ? " disabled" : "") + '>Grant</button><button type="button" class="text-button danger" data-dc-decline="' + E(r.id) + '">Decline</button>') + "</td></tr>";
    }).join("") + "</tbody></table>" : '<div class="empty">No open edit requests.</div>';
  var grants = a.grants.length ? '<table class="plain dc-table"><thead><tr><th>Who</th><th>Folder (and everything in it)</th><th>Until</th><th>Granted</th><th></th></tr></thead><tbody>' +
    a.grants.map(function (g) {
      return "<tr" + (g.live ? "" : ' class="dc-past"') + "><td>" + E(g.user) + "</td><td>" + E(g.where) + "</td><td>" + (g.revokedAt ? "Revoked " + E(dcDate(g.revokedAt)) + " by " + E(g.revokedBy) : g.until ? (g.live ? "" : "Ended ") + E(dcDate(g.until)) : "No end date") + "</td>" +
        "<td>" + E(g.by) + " · " + E(dcDate(g.at)) + (g.ref ? '<span class="co-note">' + E(g.ref) + "</span>" : "") + "</td>" +
        '<td class="dc-acts">' + (g.live ? '<button type="button" class="text-button danger" data-dc-revoke="' + E(g.id) + '">Revoke</button>' : "") + "</td></tr>";
    }).join("") + "</tbody></table>" : '<div class="empty">Nobody has edit access right now.</div>';
  var arch = a.archived.length ? '<table class="plain dc-table"><thead><tr><th>Name</th><th>Was in</th><th>Archived</th><th></th></tr></thead><tbody>' +
    a.archived.map(function (x) {
      return "<tr><td>" + (x.kind === "folder" ? "📁 " : "") + E(x.name) + "</td><td>" + E(x.where) + "</td><td>" + E(x.by || "") + " · " + E(dcDate(x.at)) + "</td>" +
        '<td class="dc-acts"><button type="button" class="text-button" data-dc-restore="' + E(x.kind + ":" + x.id) + '">Restore</button></td></tr>';
    }).join("") + "</tbody></table>" : '<div class="empty">Nothing archived.</div>';
  return '<p class="small-note">A grant covers the folder and everything in it, and lets that person add files and folders, upload new versions, rename, move within the department and archive. It ends on the date you pick (' + a.grantDays + " days unless you change it). Granting or declining resolves the IT ticket. Full-access logins can always edit.</p>" +
    '<div class="card-label dc-group">Open requests</div><div class="card dc-pad">' + reqs + "</div>" +
    '<div class="card-label dc-group">Edit access</div><div class="card dc-pad">' + grants + "</div>" +
    '<div class="card-label dc-group">Archived</div><div class="card dc-pad">' + arch + "</div>";
}

// ---- Viewer ----
// Kept outside #view so the page's own refreshes don't reload the document.
// A faint name-and-date watermark is drawn over it.
var dcViewing = null; // { url } while open
function dcCloseViewer() {
  var el = document.getElementById("dcViewer");
  if (el) el.remove();
  if (dcViewing && dcViewing.url) URL.revokeObjectURL(dcViewing.url);
  dcViewing = null;
}
// opts.url shows a document kept somewhere else (a Business Development
// project's copy) with the same view-only rules; no versions or Add to….
function dcViewer(file, versionId, opts) {
  opts = opts || {};
  dcCloseViewer();
  dcViewing = { file: file, v: versionId || "" };
  var wrap = document.createElement("div");
  wrap.id = "dcViewer";
  wrap.className = "rs-modal dc-viewer";
  var stamp = E(me.username + " · " + new Date().toLocaleString());
  var mark = "";
  for (var i = 0; i < 18; i++) mark += "<span>" + stamp + "</span>";
  wrap.innerHTML = '<div class="rs-card dc-view-card" role="dialog" aria-modal="true" aria-labelledby="dcViewT">' +
    '<div class="dc-view-head"><h3 id="dcViewT">' + E(file.name) + '</h3><span class="small-note" id="dcViewInfo">' + E(dcKind(file.type)) + "</span>" +
    (opts.url ? "" : '<button type="button" data-dc-addto-open>Add to…</button>') + '<button type="button" data-dc-close aria-label="Close">Close</button></div>' +
    '<div class="dc-view-body" id="dcViewBody"><div class="empty">Loading…</div></div><div class="dc-mark" aria-hidden="true">' + mark + "</div>" +
    '<p class="small-note dc-view-foot">View only. Downloading, printing and large copies are blocked here, but a screenshot is still possible — don\'t share what you see outside SOI.</p></div>';
  document.body.appendChild(wrap);
  var body = document.getElementById("dcViewBody");
  if (!file.preview && !versionId) { body.innerHTML = '<div class="empty">' + E(dcKind(file.type)) + " files can't be shown in the browser without downloading them, so there's no preview. Ask the folder's owner, or use Request edit if you need to work on it.</div>"; }
  else {
    var url = opts.url || "/api/documents/view?space=" + encodeURIComponent(dcs.space) + "&folder=" + encodeURIComponent(dcs.folder) + "&file=" + encodeURIComponent(file.id) + (versionId ? "&v=" + encodeURIComponent(versionId) : "");
    fetch(url, { headers: { Authorization: "Bearer " + token() } }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (x) { throw new Error(x.error || "Couldn't open that document"); });
      return r.blob();
    }).then(function (b) {
      if (!dcViewing || dcViewing.file !== file) return;
      if (/^text\//.test(b.type)) return b.text().then(function (t) { body.innerHTML = '<pre class="dc-text">' + E(t) + "</pre>"; });
      dcViewing.url = URL.createObjectURL(b);
      body.innerHTML = /^image\//.test(b.type)
        ? '<img class="dc-img" alt="' + E(file.name) + '" draggable="false" src="' + dcViewing.url + '">'
        : '<iframe class="dc-pdf" title="' + E(file.name) + '" src="' + dcViewing.url + '#toolbar=0&navpanes=0"></iframe>';
    }).catch(function (err) { body.innerHTML = '<div class="banner">' + E(err.message) + "</div>"; });
  }
  // Earlier versions (department folders only).
  if (!opts.url && dcSpace(dcs.space).kind === "dept" && file.versions > 1) {
    api("/api/documents/files/" + encodeURIComponent(file.id) + "/versions").then(function (d) {
      var info = document.getElementById("dcViewInfo");
      if (!info || !dcViewing || dcViewing.file !== file) return;
      info.innerHTML = 'Version <select data-dc-ver aria-label="Version">' + d.versions.map(function (v, i) {
        return '<option value="' + E(v.id) + '"' + ((versionId ? v.id === versionId : i === 0) ? " selected" : "") + ">" + (d.versions.length - i) + " · " + E(dcDate(v.at)) + " · " + E(v.by) + (v.preview ? "" : " (no preview)") + "</option>";
      }).join("") + "</select>";
    }, function () {});
  }
}
function dcFile(id) { return dcs.list && dcs.list.files.filter(function (f) { return f.id === id; })[0]; }

// ---- Add to… ----
// Copies a document onto a board file's case file (e.g. a quote) or, for
// Leadership, a person's employment file. The server checks both sides.
var dcAdd = null; // { file, v, space, folder, tab, q, lists: { ops, usgov, person }, errors, busy }
function dcAddTabs() {
  var t = (dcs.meta.spaces || []).filter(function (s) { return s.kind === "board"; }).map(function (s) { return { id: s.board, label: s.board === "usgov" ? "US Gov board file" : "Operations board file" }; });
  if (me.fullAccess || me.departments.indexOf("Business Development") !== -1) t.push({ id: "project", label: "Business Development project" });
  if (me.leadership) t.push({ id: "person", label: "Person's file" });
  return t;
}
function dcAddOpen(file, v) {
  var tabs = dcAddTabs();
  if (!tabs.length) { toast("There's nowhere you can add documents to.", true); return; }
  dcAdd = { file: file, v: v || "", space: dcs.space, folder: dcs.folder, tab: tabs[0].id, q: "", lists: {}, errors: {}, busy: false };
  var wrap = document.createElement("div");
  wrap.className = "rs-modal dc-add";
  wrap.id = "dcAdd";
  document.body.appendChild(wrap);
  dcAddDraw();
  dcAddLoad();
}
function dcAddClose() { var el = document.getElementById("dcAdd"); if (el) el.remove(); dcAdd = null; }
function dcAddLoad() {
  var tab = dcAdd.tab, a = dcAdd;
  if (a.lists[tab] || a.errors[tab] === "loading") return;
  a.errors[tab] = "loading";
  var done = function (list) { a.lists[tab] = list; delete a.errors[tab]; if (dcAdd === a) dcAddDraw(); };
  var fail = function (err) { a.errors[tab] = err.message; if (dcAdd === a) dcAddDraw(); };
  if (tab === "project") api("/api/documents/projects").then(function (d) {
    done(d.projects.map(function (p) { return { id: p.id, label: p.title || "Untitled project", sub: [p.done ? "Done" : "Open", p.owner, p.dueDate && "due " + p.dueDate, activeCompany === ALL ? shortCo(p.company) : "", p.files ? p.files + " document" + (p.files === 1 ? "" : "s") : ""].filter(Boolean).join(" · "), find: [p.title, p.owner].join(" ") }; })
      .sort(function (a, b) { return a.label.localeCompare(b.label); }));
  }, fail);
  else if (tab === "person") api("/api/people").then(function (d) { done(d.people.map(function (p) { return { id: p.username, label: p.username, sub: [p.jobTitle, p.department].filter(Boolean).join(" · "), find: [p.username, p.email, p.jobTitle, p.department].join(" ") }; })); }, fail);
  else api("/api/board" + (tab === "usgov" ? "?board=usgov" : "")).then(function (d) {
    var st = {}; (d.stages || []).forEach(function (x) { st[x.id] = x.label; });
    done((d.cards || []).map(function (c) {
      var nos = [c.fileNo, c.rfqNo && "RFQ " + c.rfqNo, c.quoteNo && "Quote " + c.quoteNo, c.orderNo && "SO " + c.orderNo, c.poNo && "PO " + c.poNo].filter(Boolean);
      return { id: c.id, label: (nos.join(" · ") || "File") + (c.customer || c.vendor ? " — " + (c.customer || c.vendor) : ""), sub: [st[c.stage] || c.stage, c.platforms, c.assignee].filter(Boolean).join(" · "),
        find: [c.fileNo, c.rfqNo, c.quoteNo, c.orderNo, c.poNo, c.customer, c.vendor, c.platforms, c.assignee].join(" ") };
    }));
  }, fail);
}
function dcAddDraw() {
  var el = document.getElementById("dcAdd");
  if (!el || !dcAdd) return;
  var a = dcAdd, list = a.lists[a.tab], err = a.errors[a.tab], q = a.q.trim().toLowerCase();
  var rows = list ? list.filter(function (x) { return !q || x.find.toLowerCase().indexOf(q) !== -1; }) : [];
  var focus = document.activeElement && document.activeElement.id === "dcAddQ", pos = focus ? document.activeElement.selectionStart : null;
  el.innerHTML = '<div class="rs-card rs-wide dc-add-card" role="dialog" aria-modal="true" aria-labelledby="dcAddT"><h3 id="dcAddT">Add to…</h3>' +
    '<p class="small-note">Adds a copy of <b>' + E(a.file.name) + "</b>. Later versions here don't follow it; both histories record where it came from.</p>" +
    '<div class="seg" role="tablist">' + dcAddTabs().map(function (t) { return '<button type="button" role="tab" class="' + (t.id === a.tab ? "active" : "") + '" aria-selected="' + (t.id === a.tab) + '" data-dc-add-tab="' + E(t.id) + '">' + E(t.label) + "</button>"; }).join("") + "</div>" +
    '<input type="search" id="dcAddQ" placeholder="' + (a.tab === "person" ? "Search by name, department or job title" : a.tab === "project" ? "Search by project name or person responsible" : "Search by file, RFQ, quote, SO or PO number, or customer") + '" value="' + E(a.q) + '" aria-label="Search">' +
    '<div class="dc-add-list">' + (err && err !== "loading" ? '<div class="banner">' + E(err) + "</div>" : !list ? '<div class="empty">Loading…</div>' : !rows.length ? '<div class="empty">Nothing matches.</div>' :
      rows.slice(0, 60).map(function (x) { return '<button type="button" class="dc-add-row" data-dc-add-pick="' + E(x.id) + '"' + (a.busy ? " disabled" : "") + "><b>" + E(x.label) + "</b><small>" + E(x.sub) + "</small></button>"; }).join("") +
      (rows.length > 60 ? '<p class="small-note">' + (rows.length - 60) + " more — search to narrow it down.</p>" : "")) + "</div>" +
    '<div style="display:flex;justify-content:flex-end;margin-top:12px;"><button type="button" data-dc-add-cancel>Cancel</button></div></div>';
  if (focus) { var i = document.getElementById("dcAddQ"); i.focus(); try { i.setSelectionRange(pos, pos); } catch (x) {} }
}
function dcAddPick(id) {
  var a = dcAdd, row = (a.lists[a.tab] || []).filter(function (x) { return x.id === id; })[0];
  if (!row || a.busy) return;
  var where = a.tab === "person" ? row.label + "'s employment file" : a.tab === "project" ? "the project " + row.label : row.label;
  if (!confirm("Add a copy of " + a.file.name + " to " + where + "?")) return;
  a.busy = true; dcAddDraw();
  // A Pentagon document not on the board yet is stored first, as the board does.
  var real = (a.tab === "ops" || a.tab === "usgov") && String(id).indexOf("pg:") === 0
    ? api("/api/board/adopt" + (a.tab === "usgov" ? "?board=usgov" : ""), { method: "POST", body: JSON.stringify({ id: id }) }).then(function (c) { return c.id; })
    : Promise.resolve(id);
  real.then(function (rid) {
    var body = { space: a.space, folder: a.folder, file: a.file.id, v: a.v, target: a.tab === "person" || a.tab === "project" ? a.tab : "board" };
    if (a.tab === "person") body.username = rid; else if (a.tab === "project") body.project = rid; else { body.board = a.tab; body.card = rid; }
    return api("/api/documents/add-to", { method: "POST", body: JSON.stringify(body) });
  }).then(function (x) { var proj = a.tab === "project"; dcAddClose(); toast("Added to " + x.to + "."); if (proj && typeof refresh === "function") refresh(); }, function (err) { a.busy = false; dcAddDraw(); toast(err.message, true); });
}
document.addEventListener("input", function (e) {
  if (e.target.id === "dcAddQ" && dcAdd) { dcAdd.q = e.target.value; dcAddDraw(); }
});

// Every stored document in the tracker (board case and customer files,
// People, Performance, IT requests, staff forms, SOPs) opens here, view-only;
// the server never sends one as a download. Word, Excel and email files get
// the server's "can't be shown" message.
function viewDocument(url, name, type) {
  dcViewer({ id: url, name: name || "Document", type: type || "", preview: true, versions: 1 }, "", { url: url });
}

// A Business Development project's documents (shown on its row).
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-proj-doc],[data-proj-doc-del]");
  if (!t) return;
  var ids = (t.dataset.projDoc || t.dataset.projDocDel).split("|");
  var p = tasks.filter(function (x) { return x.id === ids[0]; })[0];
  var f = p && (p.files || []).filter(function (x) { return x.id === ids[1]; })[0];
  if (!f) return;
  if (t.dataset.projDoc) {
    dcViewer({ id: f.id, name: f.name, type: f.type, preview: DC_PREVIEW.indexOf(f.type) !== -1, versions: 1 }, "",
      { url: "/api/tasks/" + encodeURIComponent(p.id) + "/files/" + encodeURIComponent(f.id) + "/view" });
    return;
  }
  if (!confirm("Remove " + f.name + " from this project? The original stays in Documents.")) return;
  api("/api/tasks/" + encodeURIComponent(p.id) + "/files/" + encodeURIComponent(f.id), { method: "DELETE" })
    .then(function () { p.files = p.files.filter(function (x) { return x !== f; }); toast("Removed."); render(); }, function (err) { toast(err.message, true); });
});

// ---- Changes ----
function dcUpload(files, url) {
  brdUpload(files, url, function () { dcRefresh(); });
}
function dcAsk(title, label, value, done) {
  var v = prompt(title + "\n\n" + label, value || "");
  if (v !== null && v.trim()) done(v.trim());
}
function dcMove(kind, id, to) {
  var path = kind === "folder" ? "/api/documents/folders/" : "/api/documents/files/";
  api(path + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(kind === "folder" ? { parent: to } : { folder: to }) })
    .then(function () { toast("Moved."); dcRefresh(); }, function (err) { toast(err.message, true); });
}
function dcRequestEdit() {
  var sp = dcSpace(dcs.space), where = [sp.label].concat((dcs.list.path || []).map(function (p) { return p.name; })).join(" › ");
  var wrap = document.createElement("div");
  wrap.className = "rs-modal";
  wrap.id = "dcReq";
  wrap.innerHTML = '<div class="rs-card rs-wide" role="dialog" aria-modal="true" aria-labelledby="dcReqT"><h3 id="dcReqT">Request edit</h3>' +
    '<p class="small-note">This raises an IT ticket for edit access to <b>' + E(where) + "</b> and everything in it. IT usually grants it for " + "30 days. You'll see the ticket under Administration → IT → What you've sent.</p>" +
    '<label class="card-label" for="dcReqWhy">What do you need to change?</label><textarea id="dcReqWhy" rows="4" maxlength="500" style="width:100%;margin:6px 0 12px;"></textarea>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;"><button type="button" data-dc-req-cancel>Cancel</button><button type="button" class="primary" data-dc-req-send>Send to IT</button></div></div>';
  document.body.appendChild(wrap);
  document.getElementById("dcReqWhy").focus();
}

document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-dc-addto],[data-dc-addto-open],[data-dc-add-tab],[data-dc-add-pick],[data-dc-add-cancel],[data-dc-tab],[data-dc-space],[data-dc-home],[data-dc-crumb],[data-dc-folder-open],[data-dc-view],[data-dc-close],[data-dc-upload],[data-dc-newfolder],[data-dc-rename],[data-dc-rename-folder],[data-dc-archive],[data-dc-archive-folder],[data-dc-version],[data-dc-edit],[data-dc-request],[data-dc-req-cancel],[data-dc-req-send],[data-dc-grant],[data-dc-decline],[data-dc-revoke],[data-dc-restore]");
  if (!t) { if (e.target.id === "dcViewer") dcCloseViewer(); if (e.target.id === "dcReq") e.target.remove(); if (e.target.id === "dcAdd") dcAddClose(); return; }
  var ds = t.dataset;
  if ("dcAddtoOpen" in ds && dcViewing) { dcAddOpen(dcViewing.file, dcViewing.v); return; }
  if (ds.dcAddTab && dcAdd) { dcAdd.tab = ds.dcAddTab; dcAdd.q = ""; dcAddDraw(); dcAddLoad(); return; }
  if (ds.dcAddPick && dcAdd) { dcAddPick(ds.dcAddPick); return; }
  if ("dcAddCancel" in ds) { dcAddClose(); return; }
  if ("dcClose" in ds) { dcCloseViewer(); return; }
  if ("dcReqCancel" in ds) { var q = document.getElementById("dcReq"); if (q) q.remove(); return; }
  if ("dcReqSend" in ds) {
    var why = (document.getElementById("dcReqWhy") || {}).value || "";
    if (!why.trim()) { toast("Say briefly what you need to change.", true); return; }
    t.disabled = true;
    api("/api/documents/request-edit", { method: "POST", body: JSON.stringify({ space: dcs.space, folder: dcs.folder, reason: why }) }).then(function (x) {
      var q2 = document.getElementById("dcReq"); if (q2) q2.remove();
      toast((x.already ? "You already asked — ticket " : "Sent to IT — ticket ") + x.ref + ".");
      dcRefresh();
    }, function (err) { t.disabled = false; toast(err.message, true); });
    return;
  }
  if (!$("#view").contains(t)) return;
  if (ds.dcTab) { dcs.tab = ds.dcTab; render(); return; }
  if (ds.dcSpace) { dcOpen(ds.dcSpace, ""); return; }
  if ("dcHome" in ds) { dcs.space = ""; dcs.folder = ""; render(); return; }
  if ("dcCrumb" in ds) { dcOpen(dcs.space, ds.dcCrumb); return; }
  if (ds.dcFolderOpen) { dcOpen(dcs.space, ds.dcFolderOpen); return; }
  if (ds.dcView) { var f = dcFile(ds.dcView); if (f) dcViewer(f); return; }
  if (ds.dcAddto) { var fa = dcFile(ds.dcAddto); if (fa) dcAddOpen(fa); return; }
  if ("dcUpload" in ds) { $("#dcFile").click(); return; }
  if ("dcRequest" in ds) { dcRequestEdit(); return; }
  if ("dcNewfolder" in ds) {
    dcAsk("New folder", "Folder name:", "", function (name) {
      api("/api/documents/folders", { method: "POST", body: JSON.stringify({ space: dcs.space, parent: dcs.folder, name: name }) })
        .then(function () { dcRefresh(); }, function (err) { toast(err.message, true); });
    });
    return;
  }
  if (ds.dcVersion) { var vi = $("#dcVersion"); vi.dataset.file = ds.dcVersion; vi.click(); return; }
  if (ds.dcEdit) {
    var ef = dcFile(ds.dcEdit);
    if (!ef) return;
    fetch("/api/documents/download?space=" + encodeURIComponent(dcs.space) + "&folder=" + encodeURIComponent(dcs.folder || "") + "&file=" + encodeURIComponent(ef.id), { headers: { Authorization: "Bearer " + token() } })
      .then(function (r) { if (!r.ok) return r.json().then(function (x) { throw new Error(x.error || "Couldn't download it"); }); return r.blob(); })
      .then(function (b) {
        var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = ef.name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        toast("Downloaded " + ef.name + ". Edit and save it in Word, then click New version on this row to upload it — it becomes v" + ((ef.versions || 1) + 1) + ".");
      }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.dcRename || ds.dcRenameFolder) {
    var isF = !!ds.dcRenameFolder, id = ds.dcRename || ds.dcRenameFolder;
    var cur = isF ? (dcs.list.folders.filter(function (x) { return x.id === id; })[0] || {}).name : (dcFile(id) || {}).name;
    dcAsk("Rename", "New name:", cur, function (name) {
      api((isF ? "/api/documents/folders/" : "/api/documents/files/") + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ name: name }) })
        .then(function () { dcRefresh(); }, function (err) { toast(err.message, true); });
    });
    return;
  }
  if (ds.dcArchive || ds.dcArchiveFolder) {
    var fol = !!ds.dcArchiveFolder;
    if (!confirm(fol ? "Archive this folder and everything in it? It's hidden, not deleted; IT can restore it." : "Archive this document? It's hidden, not deleted; IT can restore it.")) return;
    api((fol ? "/api/documents/folders/" : "/api/documents/files/") + encodeURIComponent(ds.dcArchive || ds.dcArchiveFolder) + "/archive", { method: "POST", body: "{}" })
      .then(function () { toast("Archived."); dcRefresh(); }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.dcGrant || ds.dcDecline) {
    var rid = ds.dcGrant || ds.dcDecline, body = { decision: ds.dcGrant ? "grant" : "decline" };
    if (ds.dcGrant) body.until = dcs.noExpiry[rid] ? "" : dcs.until[rid] || dcInDays(dcs.access.grantDays);
    else { var why2 = prompt("Why is it declined? (The requester sees this on their ticket.)"); if (!why2 || !why2.trim()) return; body.reason = why2.trim(); }
    t.disabled = true;
    api("/api/documents/requests/" + encodeURIComponent(rid) + "/decide", { method: "POST", body: JSON.stringify(body) })
      .then(function () { toast(ds.dcGrant ? "Granted — the ticket is resolved." : "Declined — the ticket is resolved."); dcRefresh(); }, function (err) { t.disabled = false; toast(err.message, true); });
    return;
  }
  if (ds.dcRevoke) {
    if (!confirm("Revoke this edit access now?")) return;
    api("/api/documents/grants/" + encodeURIComponent(ds.dcRevoke) + "/revoke", { method: "POST", body: "{}" })
      .then(function () { toast("Revoked."); dcRefresh(); }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.dcRestore) {
    var parts = ds.dcRestore.split(":");
    api("/api/documents/restore", { method: "POST", body: JSON.stringify({ kind: parts[0], id: parts[1] }) })
      .then(function () { toast("Restored."); dcRefresh(); }, function (err) { toast(err.message, true); });
  }
});
document.addEventListener("change", function (e) {
  var t = e.target;
  if (t.id === "dcFile") {
    dcUpload(t.files, function (f) { return "/api/documents/files?space=" + encodeURIComponent(dcs.space) + "&folder=" + encodeURIComponent(dcs.folder) + "&name=" + encodeURIComponent(f.name); });
    t.value = "";
    return;
  }
  if (t.id === "dcVersion") {
    var fid = t.dataset.file;
    dcUpload(t.files, function (f) { return "/api/documents/files/" + encodeURIComponent(fid) + "/versions?name=" + encodeURIComponent(f.name); });
    t.value = "";
    return;
  }
  if (t.dataset && t.dataset.dcUntil) { dcs.until[t.dataset.dcUntil] = t.value; return; }
  if (t.dataset && t.dataset.dcNoexp) { dcs.noExpiry[t.dataset.dcNoexp] = t.checked; render(); return; }
  if (t.dataset && "dcVer" in t.dataset && dcViewing) { var fl = dcViewing.file; dcViewer(fl, t.value); }
});

// Drag and drop: files from your computer upload into the folder shown;
// a row dragged onto a folder (or a name in the path) moves there.
function dcCanDrop() { return page === "documents" && dcs.tab === "browse" && dcs.list && dcs.list.canEdit && dcs.listKey === dcKey(); }
document.addEventListener("dragstart", function (e) {
  var r = e.target.closest && e.target.closest("[data-dc-drag]");
  if (r && dcCanDrop()) { e.dataTransfer.setData("application/x-soi-doc", r.dataset.dcDrag); e.dataTransfer.effectAllowed = "move"; return; }
  // Nothing else on the page can be dragged out (pictures, links, text).
  if (page === "documents" || (e.target.closest && e.target.closest("#dcViewer"))) e.preventDefault();
});
document.addEventListener("dragover", function (e) {
  if (!dcCanDrop()) return;
  var types = Array.prototype.slice.call(e.dataTransfer.types || []);
  var target = e.target.closest && e.target.closest("[data-dc-drop]");
  if (types.indexOf("application/x-soi-doc") !== -1 ? target : types.indexOf("Files") !== -1 && e.target.closest && e.target.closest("#dcDrop")) {
    e.preventDefault();
    var box = $("#dcDrop");
    if (box && !box.classList.contains("dc-over")) box.classList.add("dc-over");
  }
});
document.addEventListener("dragleave", function (e) {
  var box = $("#dcDrop");
  if (box && e.target === box) box.classList.remove("dc-over");
});
document.addEventListener("drop", function (e) {
  if (!dcCanDrop()) return;
  var box = $("#dcDrop");
  if (box) box.classList.remove("dc-over");
  var moving = e.dataTransfer.getData("application/x-soi-doc");
  if (moving) {
    var target = e.target.closest && e.target.closest("[data-dc-drop]");
    if (!target) return;
    e.preventDefault();
    var p = moving.split(":"), to = target.dataset.dcDrop;
    if (to === dcs.folder || (p[0] === "folder" && p[1] === to)) return;
    dcMove(p[0], p[1], to);
    return;
  }
  if (e.dataTransfer.files && e.dataTransfer.files.length && e.target.closest && e.target.closest("#dcDrop")) {
    e.preventDefault();
    var space = dcs.space, folder = dcs.folder;
    dcUpload(e.dataTransfer.files, function (f) { return "/api/documents/files?space=" + encodeURIComponent(space) + "&folder=" + encodeURIComponent(folder) + "&name=" + encodeURIComponent(f.name); });
  }
});

// Discourage copying: big copies, the right-click menu, saving and printing
// are blocked on this page and in the viewer. None of this stops a screenshot.
function dcGuarded(el) { return page === "documents" || !!(el && el.closest && el.closest("#dcViewer")); }
document.addEventListener("copy", function (e) {
  if (!dcGuarded(e.target)) return;
  var sel = String(window.getSelection ? window.getSelection() : "");
  if (sel.length > DC_COPY_MAX || (e.target.closest && e.target.closest("#dcViewer"))) {
    e.preventDefault();
    toast("Copying from documents is blocked. Ask the folder's owner if you need the text.", true);
  }
});
document.addEventListener("contextmenu", function (e) {
  if (e.target.closest && e.target.closest("#dcViewer")) e.preventDefault();
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && dcAdd) { dcAddClose(); return; }
  if (!document.getElementById("dcViewer")) return;
  if (e.key === "Escape") { dcCloseViewer(); return; }
  if ((e.ctrlKey || e.metaKey) && /^[sp]$/i.test(e.key)) { e.preventDefault(); toast("Saving and printing are blocked for documents.", true); }
});

// ---- Mentions of You: requests to edit documents ----
// For the document editors (and IT / full access): open "Request to edit"
// tickets waiting for a decision.
var dcMine = { items: null, at: 0, loading: false };
function loadDocRequestsMine() {
  if (!me || !me.docAdmin) return Promise.resolve([]);
  if (dcMine.loading || (dcMine.items && Date.now() - dcMine.at < 60000)) return Promise.resolve(dcMine.items || []);
  dcMine.loading = true;
  return api("/api/documents/access").then(function (x) {
    var items = (x.requests || []).filter(function (r) { return !r.gone; });
    var changed = JSON.stringify(items) !== JSON.stringify(dcMine.items);
    dcMine.items = items; dcMine.at = Date.now();
    if (changed && page === "mentions") requestRender();
    return items;
  }, function () { dcMine.items = dcMine.items || []; return dcMine.items; }).then(function (v) { dcMine.loading = false; return v; });
}
function docEditNotices() {
  loadDocRequestsMine();
  var list = dcMine.items || [];
  if (!list.length) return "";
  return '<div class="card" style="padding:16px 18px;margin-bottom:16px;"><div class="card-label">Requests to edit documents</div><ul class="lg-due-list">' +
    list.map(function (r) {
      return '<li><button type="button" class="text-button" data-dc-req-goto>' + E(r.by) + " — " + E(r.where) + "</button> " +
        '<span class="small-note">' + E(String(r.issue || "").replace(/^Edit access to Documents › [^:]*:\s*/, "")) + " · " + E(new Date(r.at).toLocaleDateString()) + "</span></li>";
    }).join("") + "</ul></div>";
}
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-dc-req-goto]");
  if (!t) return;
  dcs.tab = "access"; dcs.access = null; go("documents");
});

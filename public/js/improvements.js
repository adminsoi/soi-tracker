"use strict";
// Improvements: ask for a change to the tracker, and follow what happens to
// it. Leadership and the tracker's owners see everyone's requests and set
// the status (the server checks every write; improvements.js on the server).
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

var imp = { data: null, error: "", at: 0, loading: false, form: { title: "", description: "", area: "", priority: "" }, replies: {}, filter: "open", sending: false, marking: false };
var impWaiting = 0; // new requests (owners) + replies to yours, for the sidebar badge
var IMP_STATUS_PILL = { "new": "lg-soon", planned: "", in_progress: "", done: "sop-ok", wont_do: "" };

function loadImprovements() {
  if (imp.loading) return Promise.resolve(imp.data);
  imp.loading = true;
  var before = JSON.stringify([imp.data, imp.error]);
  return api("/api/improvements").then(function (d) { imp.data = d; imp.error = ""; }, function (err) { imp.error = err.message; })
    .then(function () {
      imp.loading = false; imp.at = Date.now();
      var n = imp.data ? imp.data.waiting + imp.data.updates : 0;
      if (n !== impWaiting) { impWaiting = n; renderNav(); }
      // Redraw only when something changed: Mentions of You reloads this
      // every time it draws, so an unconditional redraw would loop.
      if (JSON.stringify([imp.data, imp.error]) !== before) requestRender();
      return imp.data;
    });
}
function impFresh() { if (!imp.loading && (!imp.data || Date.now() - imp.at > 60000)) loadImprovements(); }
function impLabel(list, id) { var x = (list || []).filter(function (y) { return y.id === id; })[0]; return x ? x.label : id; }
function impStatusPill(x) {
  return '<span class="lg-pill ' + (IMP_STATUS_PILL[x.status] || "") + '">' + E(impLabel(imp.data.statuses, x.status)) + "</span>";
}

function renderImprovements() {
  setBreadcrumb(["Company", "Improvements"]);
  impFresh();
  // Opening the page counts as seeing replies to your requests.
  if (imp.data && imp.data.updates && !imp.marking) {
    imp.marking = true;
    api("/api/improvements/seen", { method: "POST", body: "{}" }).then(function () { imp.at = 0; return loadImprovements(); }).catch(function () {})
      .then(function () { imp.marking = false; });
  }
  var head = '<div class="intro"><div><div class="eyebrow">Company</div><h1>Improvements</h1>' +
    "<p>Ask for a change to the tracker: something that's missing, awkward or broken. " +
    (imp.data && imp.data.canManage ? "You see everyone's requests and can set their status and reply." : "You'll see your requests below, and their status changes on Mentions of You.") +
    "</p></div></div>";
  if (imp.error && !imp.data) return head + '<div class="banner">' + E(imp.error) + "</div>";
  if (!imp.data) return head + '<div class="empty">Loading…</div>';
  return head + impForm() + impList();
}

function impForm() {
  var f = imp.form, d = imp.data;
  // The sections in your own sidebar, plus Other.
  var mine = navItems().map(function (n) { return n.label; });
  var areas = d.areas.filter(function (a) { return a === "Other" || mine.indexOf(a) !== -1; });
  return '<div class="card" style="margin:0 0 16px;padding:18px 20px;"><div class="card-label">Ask for an improvement</div>' +
    '<div class="nb-field"><label for="impTitle">Title</label><input id="impTitle" data-imp-f="title" maxlength="160" value="' + E(f.title) + '" placeholder="e.g. Filter Emails by customer" autocomplete="off"></div>' +
    '<div class="nb-field"><label for="impDesc">Description</label><textarea id="impDesc" rows="4" data-imp-f="description" placeholder="What you\'d like, and what it would save you or fix.">' + E(f.description) + "</textarea></div>" +
    '<div class="grid-2" style="gap:0 16px;"><div class="nb-field"><label for="impArea">Part of the tracker</label><select id="impArea" data-imp-f="area"><option value="">Pick one…</option>' +
    areas.map(function (a) { return '<option value="' + E(a) + '"' + (a === f.area ? " selected" : "") + ">" + E(a) + "</option>"; }).join("") + "</select></div>" +
    '<div class="nb-field"><label for="impPri">Priority</label><select id="impPri" data-imp-f="priority"><option value="">Pick one…</option>' +
    d.priorities.map(function (p) { return '<option value="' + E(p.id) + '"' + (p.id === f.priority ? " selected" : "") + ">" + E(p.label) + "</option>"; }).join("") + "</select></div></div>" +
    '<div class="nb-field"><label for="impShot">Screenshot (optional)</label><input type="file" id="impShot" accept="image/png,image/jpeg,image/gif,image/webp"></div>' +
    '<div class="nb-foot"><button type="button" class="primary" data-imp-send' + (imp.sending ? " disabled" : "") + ">" + (imp.sending ? "Sending…" : "Send request") + "</button></div>" +
    '<p class="small-note">Don\'t include government client details, contract details or supplier pricing in the request or the screenshot.</p></div>';
}

function impList() {
  var d = imp.data, open = function (x) { return x.status !== "done" && x.status !== "wont_do"; };
  var list = d.items.filter(function (x) { return imp.filter === "all" || (imp.filter === "open" ? open(x) : !open(x)); });
  var seg = function (id, label) { return '<button type="button" data-imp-filter="' + id + '" class="' + (imp.filter === id ? "active" : "") + '">' + label + "</button>"; };
  return '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:18px 0 8px;"><div class="card-label" style="margin:0;">' +
    (d.canManage ? "All requests" : "Your requests") + " (" + list.length + ")</div>" +
    '<div class="seg">' + seg("open", "Open") + seg("closed", "Done / won't do") + seg("all", "All") + "</div></div>" +
    (list.length ? list.map(impCard).join("") : '<div class="empty">' + (d.items.length ? "Nothing here." : d.canManage ? "No requests yet." : "You haven't asked for anything yet.") + "</div>");
}

function impCard(x) {
  var d = imp.data;
  var log = (x.log || []).map(function (e) {
    return '<li><span class="small-note">' + E(new Date(e.at).toLocaleDateString()) + " · " + E(e.by) + "</span> " +
      (e.status ? "set it to <b>" + E(impLabel(d.statuses, e.status)) + "</b>" : "") +
      (e.text ? (e.status ? ": " : "") + '<div class="nb-read" style="margin-top:4px;">' + nbFormat(e.text) + "</div>" : "") + "</li>";
  }).join("");
  var manage = d.canManage ? '<div class="grid-2" style="gap:0 16px;margin-top:10px;">' +
      '<div class="nb-field"><label for="impSt' + E(x.id) + '">Status</label><select id="impSt' + E(x.id) + '">' +
      d.statuses.map(function (s) { return '<option value="' + E(s.id) + '"' + (s.id === x.status ? " selected" : "") + ">" + E(s.label) + "</option>"; }).join("") + "</select></div>" +
      '<div class="nb-field"><label for="impRe' + E(x.id) + '">Reply (optional)</label><textarea id="impRe' + E(x.id) + '" rows="2" data-imp-reply="' + E(x.id) + '">' + E(imp.replies[x.id] || "") + "</textarea></div></div>" +
      '<div class="nb-foot"><button type="button" class="primary" data-imp-update="' + E(x.id) + '">Save</button></div>' : "";
  return '<div class="card" style="padding:14px 16px;margin-bottom:10px;" id="imp-' + E(x.id) + '">' +
    '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;"><b>' + E(x.title) + "</b>" +
    '<span class="small-note">' + E(x.area) + " · " + (d.canManage ? E(x.by) + " · " : "") + E(new Date(x.at).toLocaleDateString()) + "</span>" +
    impStatusPill(x) + '<span class="pill' + (x.priority === "blocking" ? " rose" : "") + '">' + E(impLabel(d.priorities, x.priority)) + "</span>" +
    (x.unseen ? '<span class="badge">Updated</span>' : "") + "</div>" +
    '<div class="nb-read" style="margin-top:8px;">' + nbFormat(x.description) + "</div>" +
    (x.screenshot ? '<p style="margin:6px 0 0;"><button type="button" class="text-button" data-imp-shot="' + E(x.id) + '">🖼 ' + E(x.screenshot.name) + "</button></p>" : "") +
    (log ? '<ul class="lg-due-list" style="margin-top:8px;">' + log + "</ul>" : "") +
    manage + "</div>";
}

function impSend() {
  var f = imp.form, input = $("#impShot"), file = input && input.files && input.files[0];
  if (file && !/\.(png|jpe?g|gif|webp)$/i.test(file.name)) { toast("Attach the screenshot as a PNG, JPG, GIF or WebP image.", true); return; }
  if (file && file.size > 10 * 1024 * 1024) { toast("The screenshot is over 10 MB.", true); return; }
  imp.sending = true; render();
  api("/api/improvements", { method: "POST", body: JSON.stringify(f) }).then(function (x) {
    if (!file) return x;
    return fetch("/api/improvements/" + encodeURIComponent(x.id) + "/screenshot?name=" + encodeURIComponent(file.name), { method: "POST", headers: { Authorization: "Bearer " + token(), "Content-Type": file.type || "application/octet-stream" }, body: file })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error("The request was sent, but the screenshot wasn't: " + (d.error || "upload failed")); return d; }); });
  }).then(function () {
    imp.form = { title: "", description: "", area: "", priority: "" };
    toast("Sent. You'll see its status here and on Mentions of You.");
  }, function (err) { toast(err.message, true); })
    .then(function () { imp.sending = false; imp.at = 0; loadImprovements(); render(); });
}

function impUpdate(id) {
  var st = $("#impSt" + id), body = { status: st ? st.value : "", reply: imp.replies[id] || "" };
  api("/api/improvements/" + encodeURIComponent(id) + "/update", { method: "POST", body: JSON.stringify(body) }).then(function () {
    delete imp.replies[id]; toast("Saved."); imp.at = 0; loadMineCount().catch(function () {});
  }, function (err) { toast(err.message, true); });
}

// Mentions of You (mentions.js): new requests for everyone who manages
// them (owners and Leadership), and replies to your own requests.
function impNotices() {
  impFresh();
  if (!imp.data) return "";
  var list = imp.data.items.filter(function (x) { return (imp.data.canManage && x.status === "new") || x.unseen; });
  if (!list.length) return "";
  return '<div class="card" style="padding:16px 18px;margin-bottom:16px;"><div class="card-label">Improvements</div><ul class="lg-due-list">' +
    list.map(function (x) {
      return '<li><button type="button" class="text-button" data-imp-goto="' + E(x.id) + '">' + E(x.title) + "</button> " +
        '<span class="small-note">' + (x.unseen ? "Your request is now " + E(impLabel(imp.data.statuses, x.status)) : "New request from " + E(x.by)) +
        " · " + E(x.area) + " · " + E(impLabel(imp.data.priorities, x.priority)) + "</span></li>";
    }).join("") + "</ul></div>";
}

document.addEventListener("input", function (e) {
  var el = e.target;
  if (!el.dataset || !$("#view").contains(el)) return;
  if (el.dataset.impF) imp.form[el.dataset.impF] = el.value;
  else if (el.dataset.impReply) imp.replies[el.dataset.impReply] = el.value;
});
document.addEventListener("change", function (e) {
  var el = e.target;
  if (el.dataset && el.dataset.impF && $("#view").contains(el)) imp.form[el.dataset.impF] = el.value;
});
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-imp-send],[data-imp-update],[data-imp-shot],[data-imp-filter],[data-imp-goto]");
  if (!t || !$("#view").contains(t)) return;
  var ds = t.dataset;
  if ("impSend" in ds) { if (!imp.sending) impSend(); return; }
  if (ds.impUpdate) { impUpdate(ds.impUpdate); return; }
  if (ds.impFilter) { imp.filter = ds.impFilter; render(); return; }
  if (ds.impShot) {
    var x = imp.data.items.filter(function (y) { return y.id === ds.impShot; })[0];
    if (x && x.screenshot) viewDocument("/api/improvements/" + encodeURIComponent(x.id) + "/screenshot", x.screenshot.name, x.screenshot.type);
    return;
  }
  if (ds.impGoto) {
    imp.filter = "all"; go("improvements");
    setTimeout(function () { var c = document.getElementById("imp-" + ds.impGoto); if (c) c.scrollIntoView({ block: "center" }); }, 50);
  }
});

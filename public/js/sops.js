"use strict";
// Department SOPs and quick answers.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- Department SOPs ----
// Quick answers ("our manager is out — how do we…?") and the department's
// SOP PDFs. Everyone in the department reads; managers add and change.
var sopData = {}, sopUi = { view: {}, q: "", adding: false, editing: "", pasting: false, form: {} };
// The SOP page picks its own department; a department's SOPs tab uses the open one.
var sopPageDept = "";
function sopDeptNow() { return page === "sop" ? sopPageDept : activeDept; }
function loadSops(dept) {
  var st = sopData[dept] = sopData[dept] || {};
  if (st.loading) return;
  st.loading = true;
  api("/api/sops?dept=" + encodeURIComponent(dept)).then(function (d) { st.data = d; st.error = ""; }, function (err) { st.error = err.message; })
    .then(function () { st.loading = false; st.at = Date.now(); requestRender(); });
}
// "SOP-IT-005_Ticketing.pdf" -> { code: "IT-005", title: "Ticketing", version: "" }
function sopFromName(name, folder) {
  var base = String(name || "").replace(/\.pdf$/i, "");
  var vm = base.match(/[\s_-]v(\d+(?:\.\d+)?)(\s*final)?\b/i);
  var version = vm ? "v" + vm[1] + (vm[2] ? " final" : "") : "";
  if (vm) base = base.replace(vm[0], " ");
  base = base.replace(/^\s*sop[\s_-]*/i, "");
  var cm = base.match(/(?:^|[^A-Za-z0-9])([A-Za-z]{2,8})[\s_-]?(\d{3})(?![0-9])/);
  var code = cm ? cm[1].toUpperCase() + "-" + cm[2] : "";
  var title = (cm ? base.replace(cm[0].replace(/^[^A-Za-z]/, ""), " ") : base).replace(/[_]+/g, " ").replace(/^[\s\-–:]+|[\s\-–:]+$/g, "").replace(/\s{2,}/g, " ");
  // A folder named like "FIN-001 AP-AR" gives a better title.
  var fm = String(folder || "").match(/^\s*([A-Za-z]{2,8})[\s_-]?(\d{3})\s+(.+)$/);
  if (fm && (!code || code === fm[1].toUpperCase() + "-" + fm[2])) { code = fm[1].toUpperCase() + "-" + fm[2]; if (!title || title.length < 4) title = fm[3].trim(); }
  return { code: code, title: title || code || "SOP", version: version };
}
// Pasted Q&A: "Q: … / A: …" pairs, or a question line ending in "?" with
// the lines under it as the answer.
function parseQa(text) {
  var out = [], cur = null;
  String(text || "").replace(/\r/g, "").split("\n").forEach(function (raw) {
    var line = raw.trim();
    var qm = line.match(/^(?:q(?:uestion)?\s*[:.)-]|\d+[.)]\s+(?=.*\?\s*$))\s*(.*)$/i);
    var am = line.match(/^a(?:nswer)?\s*[:.)-]\s*(.*)$/i);
    if (qm || (/\?\s*$/.test(line) && !am && (!cur || cur.a))) { cur = { q: (qm ? qm[1] : line).trim(), a: "" }; out.push(cur); return; }
    if (!cur) return;
    var t = am ? am[1] : raw.replace(/\s+$/, "");
    cur.a = cur.a ? cur.a + "\n" + t : t.trim();
  });
  return out.filter(function (x) { return x.q; }).map(function (x) { return { q: x.q, a: x.a.trim() }; });
}
// Opens view-only in the Documents viewer (documents.js), not a new tab
// where the browser's PDF viewer would offer a download.
function openSop(id, name) {
  viewDocument("/api/sops/" + encodeURIComponent(id) + "/file", name || "SOP", "application/pdf");
}
function renderSops(dept) {
  var st = sopData[dept];
  if (!st || (!st.data && !st.loading && !st.error) || Date.now() - (st.at || 0) > 120000) loadSops(dept);
  st = sopData[dept];
  if (st.error) return '<div class="banner">' + E(st.error) + "</div>";
  if (!st.data) return '<div class="empty">Loading SOPs…</div>';
  var d = st.data, can = d.canEdit, view = sopUi.view[dept] || "qa";
  var bar = '<div class="table-toolbar" style="margin-top:16px;"><div class="seg">' +
    '<button type="button" data-sop-view="qa" class="' + (view === "qa" ? "active" : "") + '">Quick answers (' + d.qa.length + ")</button>" +
    '<button type="button" data-sop-view="docs" class="' + (view === "docs" ? "active" : "") + '">SOP documents (' + d.sops.length + ")</button></div>" +
    (view === "qa" ? '<input type="search" id="sopFind" placeholder="Find a question" value="' + E(sopUi.q) + '" aria-label="Find a question" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--card);min-width:200px;">' : "") +
    '<span class="grow" style="flex:1"></span><button type="button" data-sop-propose>Propose a change</button>' +
    (can && view === "qa" ? '<button type="button" data-sop-paste>Paste a list</button><button type="button" class="primary" data-sop-addq>+ Add question</button>' : "") +
    (can && view === "docs" ? '<input type="file" id="sopFile" accept="application/pdf,.pdf" multiple hidden><button type="button" class="primary" data-sop-upload>+ Upload SOPs</button>' : "") + "</div>";
  return bar + (sopReq.form ? sopProposeForm(dept, d) : "") + (view === "docs" ? renderSopDocs(dept, d, can) : renderSopQa(dept, d, can));
}
function sopOptions(d, sel) {
  return '<option value="">No linked SOP</option>' + d.sops.map(function (x) {
    return '<option value="' + E(x.id) + '"' + (x.id === sel ? " selected" : "") + ">" + E((x.code ? x.code + " · " : "") + x.title) + "</option>";
  }).join("");
}
function sopQaForm(dept, d, item) {
  var f = sopUi.form;
  return '<div class="card" style="margin-bottom:12px;padding:18px 20px;"><div class="card-label">' + (item ? "Edit answer" : "New question") + "</div>" +
    '<div class="nb-field"><label for="sopq">Question</label><input id="sopq" data-sop-f="q" value="' + E(f.q || "") + '" placeholder="e.g. Who approves a payment when Mark is out?" autocomplete="off"></div>' +
    '<div class="nb-field"><label for="sopa">Answer</label><textarea id="sopa" rows="5" data-sop-f="a" placeholder="Steps, who to ask, where things are. Start a line with - for a bullet.">' + E(f.a || "") + "</textarea></div>" +
    '<div class="grid-2" style="gap:0 16px;"><div class="nb-field"><label for="sops">Related SOP</label><select id="sops" data-sop-f="sopId">' + sopOptions(d, f.sopId) + "</select></div>" +
    (item ? "" : '<div class="nb-field"><label for="sopall">Show in</label><select id="sopall" data-sop-f="dept"><option value="">This department</option><option value="*"' + (f.dept === "*" ? " selected" : "") + ">Every department</option></select></div>") + "</div>" +
    '<div class="nb-foot"><button type="button" class="primary" data-sop-save="' + E(item ? item.id : "") + '">' + (item ? "Save" : "Add question") + '</button><button type="button" class="text-button" data-sop-cancel>Cancel</button>' +
    (item ? '<span class="grow"></span><button type="button" class="text-button" data-sop-delq="' + E(item.id) + '">Delete</button>' : "") + "</div></div>";
}
function renderSopQa(dept, d, can) {
  var q = sopUi.q.trim().toLowerCase();
  var list = d.qa.filter(function (x) { return !q || (x.q + " " + x.a).toLowerCase().indexOf(q) !== -1; });
  var byId = {}; d.sops.forEach(function (x) { byId[x.id] = x; });
  var html = "";
  if (sopUi.pasting) {
    html += '<div class="card" style="margin-bottom:12px;padding:18px 20px;"><div class="card-label">Paste a list of questions and answers</div>' +
      '<p class="small-note" style="margin:0 0 10px;">Write each as <b>Q:</b> … then <b>A:</b> …, or put each question on its own line ending in “?” with the answer underneath.</p>' +
      '<div class="nb-field"><textarea id="sopPasteBox" rows="10" placeholder="Q: Who approves payments when Mark is out?&#10;A: Ramin or Greg, through Teams only (FIN-002).&#10;&#10;How do we close the month?&#10;Follow FIN-003. Reconcile the bank accounts first."></textarea></div>' +
      '<div class="nb-foot"><button type="button" class="primary" data-sop-pastesave>Add these</button><button type="button" class="text-button" data-sop-cancel>Cancel</button><span class="small-note" id="sopPasteCount"></span></div></div>';
  }
  if (sopUi.adding) html += sopQaForm(dept, d, null);
  html += list.length ? list.map(function (x) {
    if (sopUi.editing === x.id) return sopQaForm(dept, d, x);
    var sop = x.sopId && byId[x.sopId];
    return '<details class="qa"' + (q ? " open" : "") + "><summary>" + E(x.q) + (x.dept === "*" ? ' <span class="qa-all">ALL DEPARTMENTS</span>' : "") + "</summary>" +
      '<div class="qa-body"><div class="nb-read">' + (x.a ? nbFormat(x.a) : '<p class="dim">No answer yet.</p>') + "</div>" +
      '<div class="qa-foot">' + (sop ? '<button type="button" class="text-button" data-sop-open="' + E(sop.id) + '">Open ' + E(sop.code || sop.title) + "</button>" : "") +
      (can ? '<button type="button" class="text-button" data-sop-editq="' + E(x.id) + '">Edit</button>' : "") +
      "<span>Updated " + E(new Date(x.updatedAt || x.createdAt).toLocaleDateString()) + (x.by ? " · " + E(x.by) : "") + "</span></div></div></details>";
  }).join("") : '<div class="empty">' + (d.qa.length ? "No questions match." : can ? "No quick answers yet. Add the questions people ask when the manager is out — or paste a whole list." : "No quick answers yet.") + "</div>";
  return html;
}
function renderSopDocs(dept, d, can) {
  var cell = function (x, key, ph) { return can ? '<input class="sop-edit" data-sop-meta="' + key + '" data-id="' + E(x.id) + '" value="' + E(x[key] || "") + '" placeholder="' + E(ph) + '">' : E(x[key] || "—"); };
  return '<div class="table-wrap"><table class="plain"><thead><tr><th>SOP</th><th>Title</th><th>Version</th><th>Shown in</th><th>Added</th><th></th></tr></thead><tbody>' +
    (d.sops.length ? d.sops.map(function (x) {
      var older = (x.versions || []).length;
      return '<tr><td class="sop-code">' + (can ? cell(x, "code", "Code") : E(x.code || "—")) + "</td><td>" + cell(x, "title", "Title") + "</td><td>" + cell(x, "version", "—") +
        (older ? ' <button type="button" class="text-button" data-sop-vtoggle="' + E(x.id) + '">' + older + " older</button>" : "") + "</td>" +
        "<td>" + (can ? '<select class="sop-edit" data-sop-dept="' + E(x.id) + '"><option value="' + E(dept) + '"' + (x.dept !== "*" ? " selected" : "") + ">" + E(shortDept(dept)) + '</option><option value="*"' + (x.dept === "*" ? " selected" : "") + ">Every department</option></select>"
          : (x.dept === "*" ? "Every department" : E(shortDept(dept)))) + "</td>" +
        '<td class="small-note">' + E(new Date(x.uploadedAt).toLocaleDateString()) + "</td>" +
        '<td style="white-space:nowrap;"><button type="button" data-sop-open="' + E(x.id) + '">Open</button> <button type="button" class="text-button" data-sop-propose="' + E(x.id) + '">Propose change</button>' +
        (can ? ' <input type="file" accept="application/pdf,.pdf" hidden data-sop-newver-in="' + E(x.id) + '"><button type="button" class="text-button" data-sop-newver="' + E(x.id) + '">New version</button>' +
          ' <button type="button" class="text-button" data-sop-del="' + E(x.id) + '">Remove</button>' : "") + "</td></tr>" +
        (sopReq.versions[x.id] && older ? sopVersionsRow(x) : "");
    }).join("") : '<tr><td colspan="6" class="empty">' + (can ? "No SOPs yet. Upload the department's PDFs — the number, title and version are read from the file name, and you can fix them here." : "No SOPs yet.") + "</td></tr>") +
    "</tbody></table></div>";
}
function sopReload(dept) { if (sopData[dept]) sopData[dept].at = 0; render(); }
document.addEventListener("input", function (e) {
  var t = e.target;
  if (t.id === "sopFind") { sopUi.q = t.value; var pos = t.selectionStart; render(); var f = $("#sopFind"); if (f) { f.focus(); try { f.setSelectionRange(pos, pos); } catch (x) {} } return; }
  if (t.dataset && t.dataset.sopF) sopUi.form[t.dataset.sopF] = t.value;
  if (t.id === "sopPasteBox") { var n = parseQa(t.value).length; var c = $("#sopPasteCount"); if (c) c.textContent = n ? n + " question" + (n === 1 ? "" : "s") + " found" : ""; }
});
document.addEventListener("change", function (e) {
  var t = e.target, dept = sopDeptNow();
  if (t.dataset && t.dataset.sopF) { sopUi.form[t.dataset.sopF] = t.value; return; }
  if (t.dataset && t.dataset.sopMeta) {
    var ch = {}; ch[t.dataset.sopMeta] = t.value;
    api("/api/sops/" + encodeURIComponent(t.dataset.id), { method: "PATCH", body: JSON.stringify(ch) }).then(function () { toast("Saved."); sopReload(dept); }, function (err) { toast(err.message, true); });
    return;
  }
  if (t.dataset && t.dataset.sopDept) {
    api("/api/sops/" + encodeURIComponent(t.dataset.sopDept), { method: "PATCH", body: JSON.stringify({ dept: t.value }) }).then(function () { toast("Saved."); sopReload(dept); }, function (err) { toast(err.message, true); });
    return;
  }
  if (t.id === "sopFile" && t.files && t.files.length) {
    var files = Array.prototype.slice.call(t.files); t.value = "";
    toast("Uploading " + files.length + " SOP" + (files.length === 1 ? "" : "s") + "…");
    files.reduce(function (p, f) {
      return p.then(function (n) {
        var folder = (f.webkitRelativePath || "").split("/").slice(-2, -1)[0] || "";
        var meta = sopFromName(f.name, folder);
        var qs = "dept=" + encodeURIComponent(dept) + "&code=" + encodeURIComponent(meta.code) + "&title=" + encodeURIComponent(meta.title) + "&version=" + encodeURIComponent(meta.version) + "&fileName=" + encodeURIComponent(f.name);
        return fetch("/api/sops?" + qs, { method: "POST", headers: { Authorization: "Bearer " + token(), "Content-Type": "application/pdf" }, body: f })
          .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(f.name + ": " + (d.error || "upload failed")); return n + 1; }); });
      });
    }, Promise.resolve(0)).then(function (n) { toast(n + " SOP" + (n === 1 ? "" : "s") + " added. Check the titles below."); sopReload(dept); },
      function (err) { toast(err.message, true); sopReload(dept); });
  }
});
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-sop-view],[data-sop-addq],[data-sop-paste],[data-sop-cancel],[data-sop-save],[data-sop-editq],[data-sop-delq],[data-sop-pastesave],[data-sop-open],[data-sop-upload],[data-sop-del]");
  if (!t) return;
  var ds = t.dataset, dept = sopDeptNow(), st = sopData[dept], d = st && st.data;
  if (ds.sopView) { sopUi.view[dept] = ds.sopView; render(); return; }
  if (ds.sopOpen) { var so = d && (d.sops || []).filter(function (x) { return x.id === ds.sopOpen; })[0]; openSop(ds.sopOpen, so && [so.code, so.title].filter(Boolean).join(" ")); return; }
  if ("sopUpload" in ds) { $("#sopFile").click(); return; }
  if ("sopAddq" in ds) { sopUi.adding = true; sopUi.editing = ""; sopUi.pasting = false; sopUi.form = {}; render(); var q = $("#sopq"); if (q) q.focus(); return; }
  if ("sopPaste" in ds) { sopUi.pasting = true; sopUi.adding = false; sopUi.editing = ""; render(); var pb = $("#sopPasteBox"); if (pb) pb.focus(); return; }
  if ("sopCancel" in ds) { sopUi.adding = sopUi.pasting = false; sopUi.editing = ""; sopUi.form = {}; render(); return; }
  if (ds.sopEditq) { var it = d.qa.filter(function (x) { return x.id === ds.sopEditq; })[0]; sopUi.editing = ds.sopEditq; sopUi.adding = sopUi.pasting = false; sopUi.form = { q: it.q, a: it.a, sopId: it.sopId }; render(); return; }
  if ("sopSave" in ds) {
    var f = sopUi.form;
    if (!String(f.q || "").trim()) { toast("Write the question first.", true); return; }
    var req = ds.sopSave
      ? api("/api/sops/qa/" + encodeURIComponent(ds.sopSave), { method: "PATCH", body: JSON.stringify({ q: f.q, a: f.a, sopId: f.sopId || "" }) })
      : api("/api/sops/qa", { method: "POST", body: JSON.stringify({ dept: f.dept === "*" ? "*" : dept, q: f.q, a: f.a, sopId: f.sopId || "" }) });
    req.then(function () { sopUi.adding = false; sopUi.editing = ""; sopUi.form = {}; toast("Saved."); sopReload(dept); }, function (err) { toast(err.message, true); });
    return;
  }
  if ("sopPastesave" in ds) {
    var items = parseQa(($("#sopPasteBox") || {}).value);
    if (!items.length) { toast("No questions found — start each with Q: or end it with ?", true); return; }
    api("/api/sops/qa", { method: "POST", body: JSON.stringify({ dept: dept, items: items }) })
      .then(function (r) { sopUi.pasting = false; toast(r.added.length + " question" + (r.added.length === 1 ? "" : "s") + " added."); sopReload(dept); }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.sopDelq) {
    if (!confirm("Delete this question and answer?")) return;
    api("/api/sops/qa/" + encodeURIComponent(ds.sopDelq), { method: "DELETE" }).then(function () { sopUi.editing = ""; toast("Deleted."); sopReload(dept); }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.sopDel) {
    var sop = d.sops.filter(function (x) { return x.id === ds.sopDel; })[0];
    if (!sop || !confirm("Remove " + (sop.code || sop.title) + "? The PDF and its older versions are deleted too.")) return;
    api("/api/sops/" + encodeURIComponent(sop.id), { method: "DELETE" }).then(function () { toast("Removed."); sopReload(dept); }, function (err) { toast(err.message, true); });
  }
});

// ---- SOP change requests ----
// Anyone proposes a change to one of their departments' SOPs (or a new
// SOP): what, why, and optionally the new PDF. Leadership approves or
// declines on SOP → Change requests and Mentions of You (never their own;
// the server checks). An approved PDF becomes the SOP's new version; the
// old ones stay viewable from the SOP's row.
var sopReq = { data: null, at: 0, loading: false, error: "", form: null, notes: {}, versions: {} };
var sopWaiting = 0; // requests waiting for this login's decision (sidebar badge)
var SOP_REQ_TAB = "__requests";
function loadSopRequests() {
  if (sopReq.loading) return Promise.resolve(sopReq.data);
  sopReq.loading = true;
  var before = JSON.stringify([sopReq.data, sopReq.error]);
  return api("/api/sop-requests").then(function (d) { sopReq.data = d; sopReq.error = ""; }, function (err) { sopReq.error = err.message; })
    .then(function () {
      sopReq.loading = false; sopReq.at = Date.now();
      var n = sopReq.data ? sopReq.data.requests.filter(function (r) { return r.canDecide; }).length : 0;
      if (n !== sopWaiting) { sopWaiting = n; renderNav(); }
      // Redraw only when something changed: Mentions of You reloads this
      // every time it draws, so an unconditional redraw would loop (flicker).
      if (JSON.stringify([sopReq.data, sopReq.error]) !== before) requestRender();
      return sopReq.data;
    });
}
function sopReqFresh() { if (!sopReq.loading && (!sopReq.data || Date.now() - sopReq.at > 60000)) loadSopRequests(); }
var SOP_REQ_STATUS = { pending: ["Waiting for Leadership", "lg-soon"], approving: ["Being approved", "lg-soon"], approved: ["Approved", "sop-ok"], declined: ["Declined", "lg-expired"], withdrawn: ["Withdrawn", ""] };
function sopReqPill(r) { var s = SOP_REQ_STATUS[r.status] || [r.status, ""]; return '<span class="lg-pill ' + s[1] + '">' + E(s[0]) + "</span>"; }

// The form, opened from a department's SOPs ("Propose a change" or a row's button).
function sopProposeForm(dept, d) {
  var f = sopReq.form;
  return '<div class="card" style="margin:12px 0;padding:18px 20px;"><div class="card-label">Propose an SOP change</div>' +
    '<div class="seg" style="margin-bottom:10px;"><button type="button" data-sop-rkind="change" class="' + (f.kind === "change" ? "active" : "") + '">Change an SOP</button>' +
    '<button type="button" data-sop-rkind="new" class="' + (f.kind === "new" ? "active" : "") + '">New SOP</button></div>' +
    (f.kind === "change"
      ? '<div class="nb-field"><label for="sopRsop">SOP</label><select id="sopRsop" data-sop-r="sopId"><option value="">Pick an SOP…</option>' + d.sops.map(function (x) {
          return '<option value="' + E(x.id) + '"' + (x.id === f.sopId ? " selected" : "") + ">" + E((x.code ? x.code + " · " : "") + x.title) + "</option>";
        }).join("") + "</select></div>"
      : '<div class="grid-2" style="gap:0 16px;"><div class="nb-field"><label for="sopRtitle">Title</label><input id="sopRtitle" data-sop-r="title" value="' + E(f.title || "") + '" autocomplete="off"></div>' +
        '<div class="nb-field"><label for="sopRcode">Code (if known)</label><input id="sopRcode" data-sop-r="code" value="' + E(f.code || "") + '" placeholder="e.g. FIN-004" autocomplete="off"></div></div>' +
        '<p class="small-note" style="margin:0 0 8px;">For ' + E(shortDept(dept)) + ".</p>") +
    '<div class="nb-field"><label for="sopRwhat">What should change</label><textarea id="sopRwhat" rows="4" data-sop-r="what" placeholder="Which steps, and what they should say instead.">' + E(f.what || "") + "</textarea></div>" +
    '<div class="nb-field"><label for="sopRwhy">Why</label><textarea id="sopRwhy" rows="3" data-sop-r="why" placeholder="What went wrong, or what changed.">' + E(f.why || "") + "</textarea></div>" +
    '<div class="nb-field"><label for="sopRfile">New version as a PDF (optional)</label><input type="file" id="sopRfile" accept="application/pdf,.pdf"></div>' +
    '<div class="nb-foot"><button type="button" class="primary" data-sop-rsend>Send to Leadership</button><button type="button" class="text-button" data-sop-rcancel>Cancel</button></div>' +
    '<p class="small-note">Leadership approves or declines it. An approved PDF becomes the SOP\'s new version (older ones are kept); without a PDF the department\'s manager adds it afterwards.</p></div>';
}
function sopReqSend(dept) {
  var f = sopReq.form, file = ($("#sopRfile") || {}).files;
  file = file && file[0];
  if (file && !/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { toast("Attach the new version as a PDF.", true); return; }
  var body = f.kind === "change" ? { kind: "change", sopId: f.sopId, what: f.what, why: f.why } : { kind: "new", dept: dept, title: f.title, code: f.code, what: f.what, why: f.why };
  api("/api/sop-requests", { method: "POST", body: JSON.stringify(body) }).then(function (r) {
    return file ? sopReqUpload(r.id, file) : r;
  }).then(function () {
    sopReq.form = null; sopReq.at = 0; toast("Sent to Leadership. Follow it on SOP → Change requests."); loadSopRequests(); render();
  }, function (err) { toast(err.message, true); sopReq.at = 0; });
}
function sopReqUpload(id, file) {
  return fetch("/api/sop-requests/" + encodeURIComponent(id) + "/file?fileName=" + encodeURIComponent(file.name), { method: "POST", headers: { Authorization: "Bearer " + token(), "Content-Type": "application/pdf" }, body: file })
    .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "Upload failed"); return d; }); });
}

// SOP → Change requests: yours, and for Leadership everyone's.
function renderSopRequests() {
  sopReqFresh();
  if (sopReq.error && !sopReq.data) return '<div class="banner">' + E(sopReq.error) + "</div>";
  if (!sopReq.data) return '<div class="empty">Loading change requests…</div>';
  var all = sopReq.data.requests, lead = sopReq.data.leadership;
  var waiting = all.filter(function (r) { return r.canDecide; });
  var mine = all.filter(function (r) { return r.mine; });
  var others = lead ? all.filter(function (r) { return !r.canDecide && !r.mine; }) : [];
  var sec = function (title, list, empty) {
    return '<div class="card-label" style="margin:18px 0 8px;">' + E(title) + " (" + list.length + ")</div>" +
      (list.length ? list.map(sopReqCard).join("") : '<div class="empty">' + E(empty) + "</div>");
  };
  return (lead ? sec("Waiting for your decision", waiting, "Nothing to decide.") : "") +
    sec("Your requests", mine, "You haven't proposed any changes. Use Propose a change on a department's SOPs.") +
    (lead ? sec("Everyone else's", others, "None yet.") : "");
}
function sopReqCard(r) {
  var dec = r.canDecide ? '<div class="grid-2" style="gap:0 16px;margin-top:10px;">' +
      (r.file ? '<div class="nb-field"><label for="sopRv' + E(r.id) + '">Version label for the new PDF</label><input id="sopRv' + E(r.id) + '" placeholder="e.g. v3" autocomplete="off"></div>' : "") +
      '<div class="nb-field"><label for="sopRn' + E(r.id) + '">Note (needed to decline)</label><textarea id="sopRn' + E(r.id) + '" rows="2">' + E(sopReq.notes[r.id] || "") + "</textarea></div></div>" +
      '<div class="nb-foot"><button type="button" class="primary" data-sop-rapprove="' + E(r.id) + '">Approve' + (r.file ? (r.kind === "new" ? " and add the SOP" : " and make it the new version") : "") + '</button><button type="button" data-sop-rdecline="' + E(r.id) + '">Decline</button></div>' : "";
  var own = r.mine && r.status === "pending" ? '<div class="nb-foot"><input type="file" accept="application/pdf,.pdf" hidden data-sop-rattach-in="' + E(r.id) + '">' +
      '<button type="button" data-sop-rattach="' + E(r.id) + '">' + (r.file ? "Replace PDF" : "Attach PDF") + '</button><button type="button" class="text-button" data-sop-rwithdraw="' + E(r.id) + '">Withdraw</button></div>' : "";
  return '<div class="card" style="padding:14px 16px;margin-bottom:10px;">' +
    '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;"><b>' + E(r.kind === "new" ? "New SOP: " + (r.sopLabel || r.title) : r.sopLabel || "SOP") + "</b>" +
    '<span class="small-note">' + E(r.dept === "*" ? "Every department" : shortDept(r.dept)) + " · " + E(r.by) + " · " + E(new Date(r.at).toLocaleDateString()) + "</span>" + sopReqPill(r) + "</div>" +
    '<div class="nb-read" style="margin-top:8px;"><p class="small-note" style="margin:0;">What should change</p>' + nbFormat(r.what) + (r.why ? '<p class="small-note" style="margin:6px 0 0;">Why</p>' + nbFormat(r.why) : "") + "</div>" +
    (r.file ? '<p style="margin:6px 0 0;"><button type="button" class="text-button" data-sop-rview="' + E(r.id) + '">📄 ' + E(r.file.name) + "</button></p>" : '<p class="small-note" style="margin:6px 0 0;">No PDF attached.</p>') +
    (r.decidedBy && r.status !== "pending" ? '<p class="small-note" style="margin:6px 0 0;">' + E(SOP_REQ_STATUS[r.status][0]) + " by " + E(r.decidedBy) + " · " + E(new Date(r.decidedAt).toLocaleDateString()) +
      (r.status === "approved" ? (r.applied ? " · the PDF is now the SOP's current version" : " · a department manager adds the new PDF with New version") : "") + "</p>" +
      (r.note ? '<div class="nb-read">' + nbFormat(r.note) + "</div>" : "") : "") +
    dec + own + "</div>";
}
// Mentions of You (mentions.js): Leadership's waiting requests.
function sopApprovals() {
  sopReqFresh();
  var list = sopReq.data ? sopReq.data.requests.filter(function (r) { return r.canDecide; }) : [];
  if (!list.length) return "";
  return '<div class="card" style="padding:16px 18px;margin-bottom:16px;"><div class="card-label">SOP changes waiting for your decision</div><ul class="lg-due-list">' +
    list.map(function (r) {
      return '<li><button type="button" class="text-button" data-sop-rgoto>' + E(r.kind === "new" ? "New SOP: " + (r.sopLabel || r.title) : r.sopLabel) + "</button> " +
        '<span class="small-note">' + E(r.dept === "*" ? "Every department" : shortDept(r.dept)) + " · from " + E(r.by) + " · " + E(new Date(r.at).toLocaleDateString()) + "</span></li>";
    }).join("") + "</ul></div>";
}
function sopVersionsRow(x) {
  var v = x.versions || [];
  return '<tr class="sop-versions"><td></td><td colspan="5"><ul class="lg-due-list">' + v.map(function (o) {
    return '<li><button type="button" class="text-button" data-sop-vopen="' + E(x.id + "|" + o.id) + '">📄 ' + E(o.version || "Earlier version") + "</button> " +
      '<span class="small-note">' + E(o.fileName || "") + " · added " + E(new Date(o.at).toLocaleDateString()) + (o.by ? " by " + E(o.by) : "") + "</span></li>";
  }).join("") + "</ul></td></tr>";
}
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-sop-propose],[data-sop-rkind],[data-sop-rsend],[data-sop-rcancel],[data-sop-rview],[data-sop-rapprove],[data-sop-rdecline],[data-sop-rwithdraw],[data-sop-rattach],[data-sop-rgoto],[data-sop-vtoggle],[data-sop-vopen],[data-sop-newver]");
  if (!t || !$("#view").contains(t)) return;
  var ds = t.dataset, dept = sopDeptNow();
  if ("sopPropose" in ds) { sopReq.form = { kind: "change", sopId: ds.sopPropose || "" }; render(); var w = $("#sopRwhat"); if (w && ds.sopPropose) w.focus(); return; }
  if (ds.sopRkind) { sopReq.form.kind = ds.sopRkind; render(); return; }
  if ("sopRcancel" in ds) { sopReq.form = null; render(); return; }
  if ("sopRsend" in ds) { sopReqSend(dept); return; }
  if ("sopRgoto" in ds) { sopPageDept = SOP_REQ_TAB; go("sop"); return; }
  var r = sopReq.data && sopReq.data.requests.filter(function (x) { return x.id === (ds.sopRview || ds.sopRapprove || ds.sopRdecline || ds.sopRwithdraw || ds.sopRattach); })[0];
  if (ds.sopRview && r) { viewDocument("/api/sop-requests/" + encodeURIComponent(r.id) + "/file", r.file.name, "application/pdf"); return; }
  if ((ds.sopRapprove || ds.sopRdecline) && r) {
    var approve = !!ds.sopRapprove, note = ($("#sopRn" + r.id) || {}).value || "", version = ($("#sopRv" + r.id) || {}).value || "";
    if (!approve && !note.trim()) { toast("Write a note saying why it's declined.", true); return; }
    if (approve && !confirm(r.file ? "Approve? The attached PDF becomes " + (r.kind === "new" ? "a new SOP" : "the SOP's current version (the old one is kept)") + "." : "Approve? No PDF is attached, so a department manager will add the new version.")) return;
    api("/api/sop-requests/" + encodeURIComponent(r.id) + "/decide", { method: "POST", body: JSON.stringify({ approve: approve, note: note, version: version }) }).then(function () {
      delete sopReq.notes[r.id]; toast(approve ? "Approved." : "Declined."); Object.keys(sopData).forEach(function (k) { sopData[k].at = 0; }); loadSopRequests(); loadMineCount();
    }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.sopRwithdraw && r) {
    if (!confirm("Withdraw this request?")) return;
    api("/api/sop-requests/" + encodeURIComponent(r.id) + "/withdraw", { method: "POST", body: "{}" }).then(function () { toast("Withdrawn."); loadSopRequests(); }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.sopRattach) { var inp = document.querySelector('[data-sop-rattach-in="' + ds.sopRattach + '"]'); if (inp) inp.click(); return; }
  if (ds.sopVtoggle) { sopReq.versions[ds.sopVtoggle] = !sopReq.versions[ds.sopVtoggle]; render(); return; }
  if (ds.sopVopen) { var p = ds.sopVopen.split("|"); viewDocument("/api/sops/" + encodeURIComponent(p[0]) + "/versions/" + encodeURIComponent(p[1]) + "/file", "Earlier version", "application/pdf"); return; }
  if (ds.sopNewver) { var vi = document.querySelector('[data-sop-newver-in="' + ds.sopNewver + '"]'); if (vi) vi.click(); }
});
document.addEventListener("input", function (e) {
  var t = e.target;
  if (t.dataset && t.dataset.sopR && sopReq.form) sopReq.form[t.dataset.sopR] = t.value;
  if (t.id && t.id.indexOf("sopRn") === 0) sopReq.notes[t.id.slice(5)] = t.value;
});
document.addEventListener("change", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (ds.sopR && sopReq.form) { sopReq.form[ds.sopR] = t.value; return; }
  if (ds.sopRattachIn && t.files && t.files[0]) {
    var f = t.files[0]; t.value = "";
    sopReqUpload(ds.sopRattachIn, f).then(function () { toast("PDF attached."); loadSopRequests(); }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.sopNewverIn && t.files && t.files[0]) {
    var nf = t.files[0], dept = sopDeptNow(); t.value = "";
    var ver = prompt("Version label for " + nf.name + " (e.g. v3)", sopFromName(nf.name).version || "");
    if (ver === null) return;
    fetch("/api/sops/" + encodeURIComponent(ds.sopNewverIn) + "/version?fileName=" + encodeURIComponent(nf.name) + "&version=" + encodeURIComponent(ver), { method: "POST", headers: { Authorization: "Bearer " + token(), "Content-Type": "application/pdf" }, body: nf })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "Upload failed"); }); })
      .then(function () { toast("New version added; the old one is kept."); sopReload(dept); }, function (err) { toast(err.message, true); });
  }
});

"use strict";
// Department SOPs and quick answers.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- Department SOPs ----
// Quick answers ("our manager is out — how do we…?") and the department's
// SOP PDFs. Everyone in the department reads; managers add and change.
var sopData = {}, sopUi = { view: {}, q: "", adding: false, editing: "", pasting: false, form: {} };
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
function openSop(id) {
  var w = window.open("", "_blank");
  fetch("/api/sops/" + encodeURIComponent(id) + "/file", { headers: { Authorization: "Bearer " + token() } })
    .then(function (r) { if (!r.ok) throw new Error("Couldn't open that SOP"); return r.blob(); })
    .then(function (b) { var u = URL.createObjectURL(b); if (w) w.location = u; else window.location = u; },
          function (err) { if (w) w.close(); toast(err.message, true); });
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
    '<span class="grow" style="flex:1"></span>' +
    (can && view === "qa" ? '<button type="button" data-sop-paste>Paste a list</button><button type="button" class="primary" data-sop-addq>+ Add question</button>' : "") +
    (can && view === "docs" ? '<input type="file" id="sopFile" accept="application/pdf,.pdf" multiple hidden><button type="button" class="primary" data-sop-upload>+ Upload SOPs</button>' : "") + "</div>";
  return bar + (view === "docs" ? renderSopDocs(dept, d, can) : renderSopQa(dept, d, can));
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
      '<div class="qa-foot">' + (sop ? '<button type="button" class="text-button" data-sop-open="' + E(sop.id) + '">Open ' + E(sop.code || sop.title) + " ↗</button>" : "") +
      (can ? '<button type="button" class="text-button" data-sop-editq="' + E(x.id) + '">Edit</button>' : "") +
      "<span>Updated " + E(new Date(x.updatedAt || x.createdAt).toLocaleDateString()) + (x.by ? " · " + E(x.by) : "") + "</span></div></div></details>";
  }).join("") : '<div class="empty">' + (d.qa.length ? "No questions match." : can ? "No quick answers yet. Add the questions people ask when the manager is out — or paste a whole list." : "No quick answers yet.") + "</div>";
  return html;
}
function renderSopDocs(dept, d, can) {
  var cell = function (x, key, ph) { return can ? '<input class="sop-edit" data-sop-meta="' + key + '" data-id="' + E(x.id) + '" value="' + E(x[key] || "") + '" placeholder="' + E(ph) + '">' : E(x[key] || "—"); };
  return '<div class="table-wrap"><table class="plain"><thead><tr><th>SOP</th><th>Title</th><th>Version</th><th>Shown in</th><th>Added</th><th></th></tr></thead><tbody>' +
    (d.sops.length ? d.sops.map(function (x) {
      return '<tr><td class="sop-code">' + (can ? cell(x, "code", "Code") : E(x.code || "—")) + "</td><td>" + cell(x, "title", "Title") + "</td><td>" + cell(x, "version", "—") + "</td>" +
        "<td>" + (can ? '<select class="sop-edit" data-sop-dept="' + E(x.id) + '"><option value="' + E(dept) + '"' + (x.dept !== "*" ? " selected" : "") + ">" + E(shortDept(dept)) + '</option><option value="*"' + (x.dept === "*" ? " selected" : "") + ">Every department</option></select>"
          : (x.dept === "*" ? "Every department" : E(shortDept(dept)))) + "</td>" +
        '<td class="small-note">' + E(new Date(x.uploadedAt).toLocaleDateString()) + "</td>" +
        '<td style="white-space:nowrap;"><button type="button" data-sop-open="' + E(x.id) + '">Open</button>' + (can ? ' <button type="button" class="text-button" data-sop-del="' + E(x.id) + '">Remove</button>' : "") + "</td></tr>";
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
  var t = e.target, dept = activeDept;
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
  var ds = t.dataset, dept = activeDept, st = sopData[dept], d = st && st.data;
  if (ds.sopView) { sopUi.view[dept] = ds.sopView; render(); return; }
  if (ds.sopOpen) { openSop(ds.sopOpen); return; }
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
    if (!sop || !confirm("Remove " + (sop.code || sop.title) + "? The PDF is deleted too.")) return;
    api("/api/sops/" + encodeURIComponent(sop.id), { method: "DELETE" }).then(function () { toast("Removed."); sopReload(dept); }, function (err) { toast(err.message, true); });
  }
});

"use strict";
// Company pages: SOP (Strategy Meeting is in strategy.js, People in
// people.js, Documents in documents.js, Improvements in improvements.js,
// Chat with AOG in chat.js).
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---------- Placeholders ----------
// Pages from ROADMAP.md that later phases build. They load no data yet.
function placeholderPage(title, eyebrow, lines) {
  setBreadcrumb(["Company", title]);
  return '<div class="intro"><div><div class="eyebrow">' + E(eyebrow) + "</div><h1>" + E(title) + "</h1>" +
    lines.map(function (l) { return "<p>" + l + "</p>"; }).join("") + "</div></div>" +
    '<div class="empty">Nothing here yet.</div>';
}

// ---------- SOP ----------
// Every department's SOPs in one place, with a tab per department you're in,
// and a Change requests tab (the SOP update form's requests, sops.js).
function renderSopPage() {
  setBreadcrumb(["Company", "SOP"]);
  var depts = visibleDepartments();
  if (sopPageDept !== SOP_REQ_TAB && depts.indexOf(sopPageDept) === -1) sopPageDept = depts.indexOf(activeDept) !== -1 ? activeDept : depts[0] || (me.leadership ? SOP_REQ_TAB : "");
  var head = '<div class="intro"><div><div class="eyebrow">Company</div><h1>SOP</h1>' +
    "<p>Quick answers and SOP documents for each of your departments. Anyone can propose a change to an SOP; Leadership approves it, and an approved PDF becomes the new version.</p></div></div>";
  if (!sopPageDept) return head + '<div class="empty">Your login has no departments yet. Ask an admin to add one.</div>';
  var tab = function (id, label) {
    return '<button type="button" role="tab" class="tab ' + (id === sopPageDept ? "active" : "") + '" aria-selected="' + (id === sopPageDept) + '" data-sop-page-dept="' + E(id) + '">' + label + "</button>";
  };
  return head + '<div class="tabs" role="tablist">' + depts.map(function (d) { return tab(d, E(shortDept(d))); }).join("") +
    tab(SOP_REQ_TAB, "Change requests" + (sopWaiting ? ' <span class="badge">' + sopWaiting + "</span>" : "")) + "</div>" +
    (sopPageDept === SOP_REQ_TAB ? renderSopRequests() : renderSops(sopPageDept));
}
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-sop-page-dept]");
  if (!t || !$("#view").contains(t)) return;
  sopPageDept = t.dataset.sopPageDept;
  sopUi.adding = sopUi.pasting = false; sopUi.editing = ""; sopUi.form = {}; sopReq.form = null;
  render();
});

"use strict";
// Company pages: Strategy Meeting, SOP, People, Documents and Department Chat.
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
function renderStrategy() {
  return placeholderPage("Strategy Meeting", "Company", ["The strategy meeting agenda will live here (Phase 7)."]);
}
function renderPeople() {
  return placeholderPage("People", "Company · Leadership only", [
    "Each person's employment file and the one-click spot bonus ($100 on their next payroll) will live here (Phase 5).",
    "Only leadership logins see this page. When it starts loading data, the server will check leadership on every request."
  ]);
}
function renderDocuments() {
  return placeholderPage("Documents", "Company", [
    "A drag-and-drop file manager for the S3 folders, including each Kanban file's attachments, will live here (Phase 6). It will be read-only; <b>Request edit</b> will raise an IT ticket."
  ]);
}

// ---------- SOP ----------
// Every department's SOPs in one place, with a tab per department you're in.
// The SOP update form comes in Phase 7.
function renderSopPage() {
  setBreadcrumb(["Company", "SOP"]);
  var depts = visibleDepartments();
  if (depts.indexOf(sopPageDept) === -1) sopPageDept = depts.indexOf(activeDept) !== -1 ? activeDept : depts[0] || "";
  var head = '<div class="intro"><div><div class="eyebrow">Company</div><h1>SOP</h1>' +
    "<p>Quick answers and SOP documents for each of your departments. The SOP update form comes later (Phase 7).</p></div></div>";
  if (!sopPageDept) return head + '<div class="empty">Your login has no departments yet. Ask an admin to add one.</div>';
  return head + '<div class="tabs" role="tablist">' + depts.map(function (d) {
    return '<button type="button" role="tab" class="tab ' + (d === sopPageDept ? "active" : "") + '" aria-selected="' + (d === sopPageDept) + '" data-sop-page-dept="' + E(d) + '">' + E(shortDept(d)) + "</button>";
  }).join("") + "</div>" + renderSops(sopPageDept);
}
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-sop-page-dept]");
  if (!t || !$("#view").contains(t)) return;
  sopPageDept = t.dataset.sopPageDept;
  sopUi.adding = sopUi.pasting = false; sopUi.editing = ""; sopUi.form = {};
  render();
});

// ---------- Department Chat ----------
// One Claude chat for the whole company that can read the tracker and the
// S3 document folders, and make changes when asked. It needs Claude running
// inside SOI's compliant AWS environment (Bedrock), which compliance still
// has to approve, so for now this says what it will do and opens Claude.
function renderDeptChat() {
  setBreadcrumb(["Company", "Department Chat"]);
  var row = function (a, b) { return "<tr><td><b>" + a + "</b></td><td>" + b + "</td></tr>"; };
  return '<div class="intro"><div><div class="eyebrow">Company</div><h1>Department Chat</h1>' +
    "<p>One Claude chat for the whole company (not one per department), reading the tracker and the S3 document folders. It isn't switched on yet: it has to run inside SOI's compliant AWS environment (for example Claude on Amazon Bedrock in GovCloud), and the compliance lead has to approve what it can read.</p></div></div>" +
    '<div class="card" style="padding:18px 20px;"><div class="card-label">What it will do</div>' +
    '<table class="plain"><tbody>' +
    row("When asked", "Add notes; create and assign tasks; add tags and flags; search and summarise a quote, order or customer; attach emails and files to a case file; draft emails and quotes (as drafts only).") +
    row("Shows a preview, you confirm", "Move a card to another column; send any email to a client or supplier; change prices or mark-ups; edit or delete existing records; bulk changes.") +
    row("Never", "Give its own ✓ / ✗ approval; clear quality or export holds; enter or generate certificate numbers, NSNs, CAGE codes or export classifications.") +
    "</tbody></table>" +
    '<p class="small-note" style="margin-top:10px;">It will act with your permissions, never more, and every change will be logged as "by assistant for (you)" and be undoable.</p></div>' +
    '<p style="margin-top:16px;"><a class="links-a" href="https://claude.ai/new" target="_blank" rel="noopener noreferrer">Open Claude ↗</a> <span class="small-note">Until then, the header\'s Claude button opens claude.ai. Don\'t paste government client data, contract details or supplier pricing into it.</span></p>';
}

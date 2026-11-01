"use strict";
// Administration → Staff-Facing: the forms for everyone (IT ticket, admin
// request, HR issue / leave / performance comment, reimbursement), what
// you've sent and leave waiting for your approval. Also the ongoing
// "Admin requests", "HR issues" and "Performance comments" projects on
// Department-Facing → Projects. The rules live in staffforms.js on the server.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- What each form asks (the server checks the same) ----
var SF_LEAVE = [["annual", "Annual / vacation"], ["sick", "Sick"], ["unpaid", "Unpaid"], ["parental", "Parental"], ["bereavement", "Bereavement"], ["jury", "Jury duty"], ["other", "Other"]];
var SF_LEAVE_LABEL = {}; SF_LEAVE.forEach(function (x) { SF_LEAVE_LABEL[x[0]] = x[1]; });
var SF_CURRENCIES = ["USD", "NZD", "SGD", "GBP", "EUR", "AUD"];
var SF_FORMS = {
  admin: { title: "Admin request", dept: "Administrative", send: "Send to Admin",
    intro: "Snacks, coffee and tea, or office supplies. It goes to Admin's Projects, and you can follow it below.",
    fields: [
      { k: "category", label: "What's it for", type: "select", opts: ["Snacks, coffee & tea", "Office & supplies"] },
      { k: "details", label: "What do you need", type: "textarea", ph: "e.g. Green tea and oat milk for the office kitchen" },
      { k: "neededBy", label: 'Needed by <span class="opt">optional</span>', type: "date" }] },
  hr_issue: { title: "HR issue", dept: "HR", send: "Send to HR",
    intro: "Only HR, Leadership and full-access logins can read it. HR picks it up on their Projects.",
    fields: [
      { k: "topic", label: "Topic", type: "select", opts: ["Workplace concern", "Pay or benefits", "Policy question", "Something else"] },
      { k: "subject", label: "Subject", type: "text", ph: "A few words" },
      { k: "details", label: "What's happening", type: "textarea", ph: "Facts: what happened, when, and who was involved." },
      { k: "urgent", label: "This is urgent", type: "check" }] },
  leave: { title: "Leave request", dept: "HR", send: "Request leave",
    intro: "A manager in your department approves it first, then HR. Approved leave goes to Payroll.",
    fields: [
      { k: "type", label: "Type of leave", type: "select", opts: SF_LEAVE },
      { k: "otherType", label: "What kind of leave", type: "text", ph: "e.g. Study leave", when: function (f) { return f.type === "other"; } },
      { k: "from", label: "First day off", type: "date" },
      { k: "to", label: "Last day off", type: "date" },
      { k: "days", label: "Working days", type: "number", step: "0.5", hint: "Filled in as the weekdays between the two dates. Change it for half days or public holidays." },
      { k: "notes", label: 'Notes <span class="opt">optional</span>', type: "textarea", ph: "Anything your manager should know. Don't include medical details." }] },
  perf_comment: { title: "Performance comment", dept: "HR", send: "Send to HR",
    intro: "Recognition, a concern or a suggestion about someone's work. HR reads it; it doesn't go on anyone's record by itself.",
    fields: [
      { k: "about", label: "Who is it about", type: "text", ph: "Name" },
      { k: "type", label: "Kind of comment", type: "select", opts: ["Recognition", "Concern", "Suggestion"] },
      { k: "details", label: "Comment", type: "textarea", ph: "What happened and when. Stick to facts." }] },
  reimburse: { title: "Reimbursement", dept: "Accounting & Finance", send: "Send to Finance",
    intro: "Something you paid for yourself for work. Attach the receipt; Finance checks it and approves it to pay. Don't enter bank account or card numbers.",
    fields: [
      { k: "spentOn", label: "Date paid", type: "date" },
      { k: "description", label: "What was it", type: "text", ph: "e.g. Taxi to the customer meeting" },
      { k: "amount", label: "Amount", type: "number", step: "0.01" },
      { k: "currency", label: "Currency", type: "select", opts: SF_CURRENCIES },
      { k: "notes", label: 'Notes <span class="opt">optional</span>', type: "textarea", ph: "Anything Finance should know." }] }
};
var SF_STATUSES = {
  admin: ["new", "progress", "done", "declined", "cancelled"],
  hr_issue: ["new", "progress", "done", "cancelled"],
  perf_comment: ["new", "progress", "done", "cancelled"],
  leave: ["manager", "hr", "approved", "declined", "cancelled"],
  reimburse: ["draft", "submitted", "checked", "approved", "paid", "rejected", "cancelled"]
};
var SF_STATUS_LABEL = { new: "New", progress: "In progress", done: "Done", declined: "Declined", manager: "Waiting for manager", hr: "Waiting for HR",
  approved: "Approved", cancelled: "Cancelled", draft: "Needs a receipt", submitted: "Submitted", checked: "Finance checked", paid: "Paid", rejected: "Rejected" };
function sfStatusLabel(kind, st) { return kind === "reimburse" && st === "approved" ? "Approved to pay" : SF_STATUS_LABEL[st] || st; }
function sfChip(kind, st) {
  var cls = ["progress", "checked"].indexOf(st) !== -1 ? "st-progress" : ["done", "approved", "paid"].indexOf(st) !== -1 ? "st-done" : ["declined", "rejected", "cancelled"].indexOf(st) !== -1 ? "st-off" : "st-new";
  return '<span class="st ' + cls + '">' + E(sfStatusLabel(kind, st)) + "</span>";
}
function sfCanWithdraw(i) {
  return ({ admin: ["new"], hr_issue: ["new"], perf_comment: ["new"], leave: ["manager", "hr"], reimburse: ["draft", "submitted", "checked"] }[i.kind] || []).indexOf(i.status) !== -1;
}
function sfAmount(n, cur) {
  n = Number(n);
  if (isNaN(n)) return "—";
  try { return n.toLocaleString("en-US", { style: "currency", currency: cur || "USD" }); } catch (e) { return (cur || "") + " " + n.toFixed(2); }
}
// One line saying what a submission is.
function sfWhat(i) {
  var f = i.fields || {};
  if (i.kind === "admin") return f.category + " — " + f.details;
  if (i.kind === "hr_issue") return (f.urgent ? "Urgent · " : "") + f.topic + " — " + f.subject;
  if (i.kind === "perf_comment") return f.type + " about " + f.about;
  if (i.kind === "leave") return (f.type === "other" ? f.otherType : SF_LEAVE_LABEL[f.type]) + " · " + fmtDate(f.from) + (f.to !== f.from ? " to " + fmtDate(f.to) : "") + " · " + f.days + " day" + (f.days === 1 ? "" : "s");
  if (i.kind === "reimburse") return f.description + " · " + sfAmount(f.amount, f.currency);
  return "";
}
function sfWeekdays(from, to) {
  if (!from || !to || to < from) return 0;
  var n = 0, d = new Date(from + "T12:00:00Z"), end = new Date(to + "T12:00:00Z");
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) { var w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
function sfFiles(i) {
  return (i.files || []).map(function (x) { return '<button type="button" class="text-button" data-sf-dl="' + E(i.id) + ":" + E(x.id) + '">📎 ' + E(x.name) + "</button>"; }).join(" ");
}

// ---- Your submissions (GET /api/staff-forms/mine) ----
var sf = { data: null, at: 0, loading: false, error: "", hrForm: "hr_issue", form: {}, files: {}, saving: "" };
function loadStaffForms() {
  if (sf.loading) return;
  sf.loading = true;
  api("/api/staff-forms/mine").then(function (d) { sf.data = d; sf.error = ""; }, function (err) { sf.error = err.message; })
    .then(function () { sf.loading = false; sf.at = Date.now(); requestRender(); });
}

function renderStaffFacing(dept) {
  // Refresh every minute; after an error, wait 15 s before asking again.
  if (!sf.loading && (sf.error ? Date.now() - sf.at > 15000 : !sf.data || Date.now() - sf.at > 60000)) loadStaffForms();
  var forms;
  if (dept === "IT") forms = sfItForm();
  else if (dept === "Administrative") forms = sfForm("admin");
  else if (dept === "HR") {
    forms = '<div class="seg" style="margin:16px 0 0;" aria-label="Which form">' + [["hr_issue", "HR issue"], ["leave", "Leave request"], ["perf_comment", "Performance comment"]].map(function (x) {
      return '<button type="button" data-sf-hr="' + x[0] + '" class="' + (sf.hrForm === x[0] ? "active" : "") + '">' + x[1] + "</button>";
    }).join("") + "</div>" + sfForm(sf.hrForm);
  } else if (dept === "Accounting & Finance") forms = sfForm("reimburse");
  else return '<div class="empty">This department has no staff forms.</div>';
  var mine = dept === "IT" ? sfMyTickets() : sfMine(Object.keys(SF_FORMS).filter(function (k) { return SF_FORMS[k].dept === dept; }));
  return (dept === "HR" ? sfApprovals() : "") + forms + mine;
}

function sfField(kind, d) {
  var f = sf.form[kind] || (sf.form[kind] = {});
  if (d.when && !d.when(f)) return "";
  var id = "sf-" + kind + "-" + d.k, attr = ' id="' + id + '" data-sf-f="' + kind + ":" + d.k + '"';
  var v = f[d.k] == null ? "" : f[d.k], html;
  if (d.type === "select") {
    html = "<select" + attr + '><option value="">Pick…</option>' + d.opts.map(function (o) {
      var val = typeof o === "string" ? o : o[0], label = typeof o === "string" ? o : o[1];
      return '<option value="' + E(val) + '"' + (val === v ? " selected" : "") + ">" + E(label) + "</option>";
    }).join("") + "</select>";
  } else if (d.type === "textarea") html = '<textarea rows="3"' + attr + ' placeholder="' + E(d.ph || "") + '">' + E(v) + "</textarea>";
  else if (d.type === "check") return '<div class="nb-field"><label class="sf-check"><input type="checkbox" class="check"' + attr + (v ? " checked" : "") + "> " + E(d.label) + "</label></div>";
  else html = '<input type="' + d.type + '"' + (d.step ? ' step="' + d.step + '" min="0"' : "") + attr + ' value="' + E(v) + '" placeholder="' + E(d.ph || "") + '" autocomplete="off">';
  return '<div class="nb-field"><label for="' + id + '">' + d.label + "</label>" + html + (d.hint ? '<span class="small-note">' + E(d.hint) + "</span>" : "") + "</div>";
}
// Which company it's for, when you work for more than one.
function sfCompanyField(kind, short) {
  var cos = myCompanies(), f = sf.form[kind] || (sf.form[kind] = {});
  if (!f.company) f.company = short ? COMPANY_SHORT[activeCompany !== ALL ? activeCompany : cos[0]] || "SOI" : activeCompany !== ALL ? activeCompany : cos[0];
  if (!short && cos.length < 2) return "";
  var opts = short ? ["SOI", "CAS", "RedSun", "NanoTech"].map(function (c) { return [c, c]; }) : cos.map(function (c) { return [c, shortCo(c)]; });
  return '<div class="nb-field"><label for="sf-' + kind + '-company">Company</label><select id="sf-' + kind + '-company" data-sf-f="' + kind + ':company">' + opts.map(function (o) {
    return '<option value="' + E(o[0]) + '"' + (o[0] === f.company ? " selected" : "") + ">" + E(o[1]) + "</option>";
  }).join("") + "</select></div>";
}
function sfForm(kind) {
  var spec = SF_FORMS[kind], files = sf.files[kind] || [];
  var receipt = kind === "reimburse" ? '<div class="nb-field"><label for="sf-receipt">Receipt</label><input type="file" id="sf-receipt" data-sf-receipt="' + kind + '" multiple accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.xlsx,.txt,.msg,.eml">' +
    (files.length ? '<div class="filter-row">' + files.map(function (x, n) { return '<span class="fchip">📎 ' + E(x.name) + '<button type="button" data-sf-unfile="' + n + '" aria-label="Remove">✕</button></span>'; }).join("") + "</div>" : "") +
    '<span class="small-note">A PDF or photo of the receipt. Required.</span></div>' : "";
  var fields = spec.fields.map(function (d) { return sfField(kind, d); });
  return '<div class="card sf-card"><div class="card-label">' + E(spec.title) + "</div>" +
    '<p class="small-note" style="margin:6px 0 14px;">' + E(spec.intro) + "</p>" +
    '<div class="grid-2" style="gap:0 16px;">' + fields.filter(function (h, n) { return spec.fields[n].type !== "textarea"; }).join("") + sfCompanyField(kind) + "</div>" +
    fields.filter(function (h, n) { return spec.fields[n].type === "textarea"; }).join("") + receipt +
    '<div class="nb-foot"><button type="button" class="primary" data-sf-send="' + kind + '"' + (sf.saving === kind ? " disabled" : "") + ">" + (sf.saving === kind ? "Sending…" : E(spec.send)) + "</button></div></div>";
}

// The IT ticket form makes an IT request (IT → Requests), with your login's email.
function sfItForm() {
  var f = sf.form.it || (sf.form.it = { urgency: "Normal" });
  return '<div class="card sf-card"><div class="card-label">IT ticket</div>' +
    '<p class="small-note" style="margin:6px 0 14px;">Something not working, or something you need set up. It goes straight to IT\'s Requests, and IT\'s replies come to your email.</p>' +
    '<div class="grid-2" style="gap:0 16px;">' +
      '<div class="nb-field"><label for="sf-it-urgency">How urgent</label><select id="sf-it-urgency" data-sf-f="it:urgency">' + [["Low", "Low — when there's time"], ["Normal", "Normal — this week"], ["High", "High — today"], ["Immediate", "Immediate — I can't work"]].map(function (o) {
        return '<option value="' + o[0] + '"' + (f.urgency === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") + "</select></div>" +
      sfCompanyField("it", true) +
      '<div class="nb-field"><label for="sf-it-phone">Phone <span class="opt">optional</span></label><input id="sf-it-phone" type="tel" data-sf-f="it:phone" value="' + E(f.phone || "") + '" autocomplete="off"></div>' +
    "</div>" +
    '<div class="nb-field"><label for="sf-it-issue">What\'s the issue</label><textarea id="sf-it-issue" rows="3" data-sf-f="it:issue" placeholder="e.g. Outlook keeps asking for my password">' + E(f.issue || "") + "</textarea></div>" +
    '<div class="nb-foot"><button type="button" class="primary" data-sf-send="it"' + (sf.saving === "it" ? " disabled" : "") + ">" + (sf.saving === "it" ? "Sending…" : "Send to IT") + "</button></div></div>";
}
var SF_IT_STATUS = { new: "New", progress: "In progress", done: "Resolved" };
function sfMyTickets() {
  if (sf.error) return '<div class="banner">' + E(sf.error) + "</div>";
  if (!sf.data) return '<div class="empty">Loading what you\'ve sent…</div>';
  var list = sf.data.tickets.slice().sort(function (a, b) { return String(b.submittedAt).localeCompare(String(a.submittedAt)); });
  return '<div class="section-title"><div><h2>Your IT tickets</h2><span class="small-note">Tickets you sent from this form.</span></div></div>' +
    '<div class="table-wrap"><table class="narrow"><thead><tr><th>Ticket</th><th>Sent</th><th>Issue</th><th>Urgency</th><th>Status</th><th></th></tr></thead><tbody>' +
    (list.length ? list.map(function (t) {
      // Same as the other forms: Withdraw while it's still New.
      var st = t.withdrawn ? '<span class="st st-off">Withdrawn</span>' : '<span class="st st-' + E(t.status) + '">' + E(SF_IT_STATUS[t.status] || t.status) + "</span>";
      return '<tr class="' + (t.withdrawn ? "done" : "") + '"><td>' + E(t.ref) + "</td><td>" + E(fmtDate(t.submittedAt)) + '</td><td class="sf-what">' + E(t.issue) + "</td><td>" + E(t.urgency || "—") + "</td><td>" + st + "</td>" +
        '<td class="row-tools">' + (!t.archived && t.status === "new" ? '<button type="button" class="text-button" data-sf-cancel-it="' + E(t.id) + '">Withdraw</button>' : "") + "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="empty">Nothing sent yet.</td></tr>') + "</tbody></table></div>";
}
function sfMine(kinds) {
  if (sf.error) return '<div class="banner">' + E(sf.error) + "</div>";
  if (!sf.data) return '<div class="empty">Loading what you\'ve sent…</div>';
  var list = sf.data.items.filter(function (i) { return kinds.indexOf(i.kind) !== -1; }).sort(function (a, b) { return b.at - a.at; });
  var row = function (i) {
    var last = (i.history || []).slice(-1)[0];
    var tools = "";
    if (i.kind === "reimburse" && i.status === "draft") {
      tools += '<label class="text-button sf-attach">Attach receipt<input type="file" data-sf-attach="' + E(i.id) + '" multiple hidden></label>' +
        ((i.files || []).length ? ' <button type="button" class="text-button" data-sf-submit="' + E(i.id) + '">Send to Finance</button>' : "");
    }
    if (sfCanWithdraw(i)) tools += ' <button type="button" class="text-button" data-sf-cancel="' + E(i.id) + '">Withdraw</button>';
    return '<tr class="' + (["cancelled", "declined", "rejected"].indexOf(i.status) !== -1 ? "done" : "") + '"><td>' + E(sfAge(i)) + "</td><td>" + E(SF_FORMS[i.kind].title) +
      (i.company && myCompanies().length > 1 ? '<span class="co-note">' + E(shortCo(i.company)) + "</span>" : "") + '</td><td class="sf-what">' + E(sfWhat(i)) + (sfFiles(i) ? '<span class="co-note">' + sfFiles(i) + "</span>" : "") + "</td>" +
      "<td>" + sfChip(i.kind, i.status) + (i.reason ? '<span class="co-note">' + E(i.reason) + "</span>" : last && last.what !== "Sent" ? '<span class="co-note">' + E(last.what) + " · " + E(last.by) + "</span>" : "") + "</td>" +
      '<td class="row-tools">' + tools + "</td></tr>";
  };
  return '<div class="section-title"><div><h2>What you\'ve sent</h2><span class="small-note">Only you and the department can see these.</span></div></div>' +
    '<div class="table-wrap"><table class="narrow"><thead><tr><th>Sent</th><th>Form</th><th>What</th><th>Status</th><th></th></tr></thead><tbody>' +
    (list.length ? list.map(row).join("") : '<tr><td colspan="5" class="empty">Nothing sent yet.</td></tr>') + "</tbody></table></div>";
}
// Leave waiting for you: as a manager in the person's department, or as HR.
function sfApprovals() {
  var list = (sf.data && sf.data.approvals) || [];
  if (!list.length) return "";
  return '<div class="section-title"><div><h2>Leave waiting for your approval</h2><span class="small-note">A manager in their department approves first, then HR. An HR manager\'s approval approves it outright.</span></div></div>' +
    '<div class="table-wrap"><table class="narrow"><thead><tr><th>Person</th><th>Leave</th><th>Notes</th><th>Waiting for</th><th></th></tr></thead><tbody>' +
    list.map(function (i) {
      return "<tr><td>" + E(i.by) + '</td><td class="sf-what">' + E(sfWhat(i)) + '</td><td class="sf-what">' + E((i.fields || {}).notes || "—") + "</td><td>" + (i.step === "hr" ? "HR (you)" : "Manager (you)") +
        (i.managerOk ? '<span class="co-note">Manager: ' + E(i.managerOk.by) + "</span>" : "") + '</td><td class="row-tools"><button type="button" class="primary" data-sf-leave="approve" data-id="' + E(i.id) + '">Approve</button> <button type="button" class="text-button" data-sf-leave="decline" data-id="' + E(i.id) + '">Decline</button></td></tr>';
    }).join("") + "</tbody></table></div>";
}

// A small dialog asking for a reason (declining, rejecting, cancelling).
function sfAsk(title, label, done) {
  var box = document.createElement("div");
  box.className = "rs-modal";
  box.innerHTML = '<div class="rs-card" role="dialog" aria-modal="true" aria-labelledby="sfAskT"><h3 id="sfAskT">' + E(title) + "</h3>" +
    '<div class="nb-field"><label for="sfAskText">' + E(label) + '</label><textarea id="sfAskText" rows="3"></textarea></div>' +
    '<div class="nb-foot"><span class="grow"></span><button type="button" class="text-button" data-sfa="no">Cancel</button><button type="button" class="primary" data-sfa="ok">OK</button></div></div>';
  document.body.appendChild(box);
  var ta = box.querySelector("textarea");
  ta.focus();
  box.addEventListener("click", function (e) {
    var b = e.target.closest("[data-sfa]");
    if (!b && e.target !== box) return;
    if (b && b.dataset.sfa === "ok") {
      var v = ta.value.trim();
      if (!v) { toast("Give a reason first.", true); ta.focus(); return; }
      box.remove(); done(v); return;
    }
    box.remove();
  });
}

function sfUpload(id, files) {
  return files.reduce(function (p, f) {
    return p.then(function () {
      return fetch("/api/staff-forms/" + encodeURIComponent(id) + "/files?name=" + encodeURIComponent(f.name), { method: "POST", headers: { Authorization: "Bearer " + token(), "Content-Type": "application/octet-stream" }, body: f })
        .then(function (res) { return res.json().then(function (x) { if (!res.ok) throw new Error(f.name + ": " + (x.error || "upload failed")); return x; }); });
    });
  }, Promise.resolve());
}
function sfSend(kind) {
  var f = sf.form[kind] || {};
  var done = function (msg) { sf.saving = ""; sf.form[kind] = kind === "it" ? { urgency: "Normal" } : {}; sf.files[kind] = []; toast(msg); sf.at = 0; loadStaffForms(); };
  var fail = function (err) { sf.saving = ""; toast(err.message, true); sf.at = 0; loadStaffForms(); };
  if (kind === "it") {
    if (!String(f.issue || "").trim()) { toast("Describe the issue first.", true); return; }
    sf.saving = kind; render();
    api("/api/staff-forms/it-ticket", { method: "POST", body: JSON.stringify(f) }).then(function (t) { done("Sent to IT as " + t.ref + "."); }, fail);
    return;
  }
  var files = sf.files[kind] || [];
  if (kind === "reimburse" && !files.length) { toast("Attach the receipt first.", true); return; }
  var fields = {};
  SF_FORMS[kind].fields.forEach(function (d) { if (f[d.k] != null) fields[d.k] = f[d.k]; });
  sf.saving = kind; render();
  api("/api/staff-forms", { method: "POST", body: JSON.stringify({ kind: kind, company: f.company, fields: fields }) }).then(function (item) {
    if (kind !== "reimburse") return done("Sent to " + shortDept(SF_FORMS[kind].dept) + ".");
    // Receipts, then it goes to Finance. If an upload fails it stays under
    // "What you've sent" as Needs a receipt.
    return sfUpload(item.id, files).then(function () { return api("/api/staff-forms/" + encodeURIComponent(item.id) + "/submit", { method: "POST" }); })
      .then(function () { done("Sent to Finance."); });
  }).catch(fail);
}

document.addEventListener("input", function (e) {
  var k = e.target.dataset && e.target.dataset.sfF;
  if (!k) return;
  var p = k.split(":"), f = sf.form[p[0]] || (sf.form[p[0]] = {});
  f[p[1]] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  // Working days follow the dates until you change them yourself.
  if (p[0] === "leave" && p[1] === "days") f.daysTouched = true;
  if (p[0] === "leave" && (p[1] === "from" || p[1] === "to") && !f.daysTouched) {
    if (p[1] === "from" && (!f.to || f.to < f.from)) { f.to = f.from; var t = $("#sf-leave-to"); if (t) t.value = f.to; }
    var n = sfWeekdays(f.from, f.to);
    f.days = n ? String(n) : "";
    var dEl = $("#sf-leave-days"); if (dEl) dEl.value = f.days;
  }
});
document.addEventListener("change", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (ds.sfF) {
    var p = ds.sfF.split(":"), f = sf.form[p[0]] || (sf.form[p[0]] = {});
    f[p[1]] = t.type === "checkbox" ? t.checked : t.value;
    if (p[0] === "leave" && p[1] === "type") render();
    return;
  }
  if (ds.sfReceipt) { sf.files[ds.sfReceipt] = (sf.files[ds.sfReceipt] || []).concat(Array.prototype.slice.call(t.files || [])); render(); return; }
  if (ds.sfAttach) {
    var id = ds.sfAttach;
    sfUpload(id, Array.prototype.slice.call(t.files || [])).then(function () { toast("Receipt attached."); }, function (err) { toast(err.message, true); })
      .then(function () { sf.at = 0; loadStaffForms(); });
  }
});
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-sf-hr],[data-sf-send],[data-sf-unfile],[data-sf-cancel],[data-sf-cancel-it],[data-sf-submit],[data-sf-leave],[data-sf-dl]");
  if (!t) return;
  var ds = t.dataset;
  if (ds.sfHr) { sf.hrForm = ds.sfHr; render(); return; }
  if (ds.sfSend) { sfSend(ds.sfSend); return; }
  if (ds.sfUnfile != null) { (sf.files.reimburse || []).splice(+ds.sfUnfile, 1); render(); return; }
  if (ds.sfCancel) {
    if (!confirm("Withdraw this? The department will see it was withdrawn.")) return;
    api("/api/staff-forms/" + encodeURIComponent(ds.sfCancel) + "/cancel", { method: "POST" }).then(function () { toast("Withdrawn."); }, function (err) { toast(err.message, true); })
      .then(function () { sf.at = 0; loadStaffForms(); });
    return;
  }
  if (ds.sfCancelIt) {
    if (!confirm("Withdraw this? The department will see it was withdrawn.")) return;
    api("/api/staff-forms/it-ticket/" + encodeURIComponent(ds.sfCancelIt) + "/cancel", { method: "POST" }).then(function () { toast("Withdrawn."); }, function (err) { toast(err.message, true); })
      .then(function () { sf.at = 0; loadStaffForms(); });
    return;
  }
  if (ds.sfSubmit) {
    api("/api/staff-forms/" + encodeURIComponent(ds.sfSubmit) + "/submit", { method: "POST" }).then(function () { toast("Sent to Finance."); }, function (err) { toast(err.message, true); })
      .then(function () { sf.at = 0; loadStaffForms(); });
    return;
  }
  if (ds.sfLeave) {
    var id = ds.id, send = function (note) {
      api("/api/staff-forms/" + encodeURIComponent(id) + "/leave", { method: "POST", body: JSON.stringify({ decision: ds.sfLeave, note: note || "" }) })
        .then(function () { toast(ds.sfLeave === "approve" ? "Approved." : "Declined."); }, function (err) { toast(err.message, true); })
        .then(function () { sf.at = 0; loadStaffForms(); sfDeptReload("HR"); });
    };
    if (ds.sfLeave === "decline") sfAsk("Decline this leave", "Why? They'll see this.", send); else send("");
    return;
  }
  if (ds.sfDl) {
    var p = ds.sfDl.split(":");
    fetch("/api/staff-forms/" + encodeURIComponent(p[0]) + "/files/" + encodeURIComponent(p[1]), { headers: { Authorization: "Bearer " + token() } })
      .then(function (res) { if (!res.ok) throw new Error("Couldn't download that file"); return res.blob(); })
      .then(function (b) { var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = t.textContent.replace(/^📎\s*/, "") || "file"; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }, function (err) { toast(err.message, true); });
  }
});

// ---- The department's side (GET /api/staff-forms/dept) ----
// Cached per department (and company, for Finance).
var sfd = {};
function sfDeptKey(dept) { return dept === "Accounting & Finance" ? dept + "|" + activeCompany : dept; }
function sfDept(dept) {
  var key = sfDeptKey(dept), c = sfd[key] || (sfd[key] = { data: null, at: 0, loading: false, error: "" });
  if (!c.loading && (c.error ? Date.now() - c.at > 15000 : !c.data || Date.now() - c.at > 60000)) {
    c.loading = true;
    api("/api/staff-forms/dept?dept=" + encodeURIComponent(dept) + (dept === "Accounting & Finance" ? "&company=" + encodeURIComponent(activeCompany) : ""))
      .then(function (d) { c.data = d; c.error = ""; }, function (err) { c.error = err.message; })
      .then(function () { c.loading = false; c.at = Date.now(); requestRender(); });
  }
  return c;
}
function sfDeptReload(dept) { var c = sfd[sfDeptKey(dept)]; if (c) c.at = 0; }
function sfUpdate(dept, id, body) {
  setSync("busy", "Saving…");
  return api("/api/staff-forms/" + encodeURIComponent(id) + "/update", { method: "POST", body: JSON.stringify(body) }).then(function (item) {
    setSync("on", "Live");
    var c = sfd[sfDeptKey(dept)];
    if (c && c.data) c.data.items = c.data.items.map(function (x) { return x.id === item.id ? item : x; });
    requestRender();
  }, function (err) { setSync("on", "Live"); toast(err.message, true); sfDeptReload(dept); requestRender(); });
}
// Status picker, person responsible and internal notes for one submission.
// (data-sf-dept, not data-dept: a click on [data-dept] opens that
// department's tab in app.js, which redrew the page and shut the dropdown.)
function sfStatusPick(dept, i, can, only) {
  var opts = (only || SF_STATUSES[i.kind]).filter(function (s) { return s !== "cancelled" && s !== "draft" || s === i.status; });
  if (!can || i.status === "cancelled") return sfChip(i.kind, i.status);
  return '<select class="fb-in" data-sfd-st="' + E(i.id) + '" data-sf-dept="' + E(dept) + '" aria-label="Status">' + opts.map(function (s) {
    return '<option value="' + s + '"' + (s === i.status ? " selected" : "") + ">" + E(sfStatusLabel(i.kind, s)) + "</option>";
  }).join("") + "</select>";
}
function sfAssignPick(dept, i, can, people) {
  if (!can) return staticCell(i.assignee);
  var list = people.slice();
  if (i.assignee && list.indexOf(i.assignee) === -1) list.unshift(i.assignee);
  return '<select class="fb-in" data-sfd-as="' + E(i.id) + '" data-sf-dept="' + E(dept) + '" aria-label="Responsible"><option value="">Unassigned</option>' + list.map(function (u) {
    return '<option value="' + E(u) + '"' + (sameUser(u, i.assignee) ? " selected" : "") + ">" + E(u) + "</option>";
  }).join("") + "</select>";
}
function sfNotes(dept, i, can) {
  return '<textarea class="fb-in fb-notes" rows="1" data-sfd-notes="' + E(i.id) + '" data-sf-dept="' + E(dept) + '"' + (can ? "" : " disabled") + ' placeholder="' + (can ? "Notes (department only)…" : "") + '">' + E(i.notes || "") + "</textarea>";
}
function sfDetails(i) {
  var f = i.fields || {}, body = f.details || f.notes || "";
  return (body ? '<details class="sf-more"><summary>Details</summary><div class="sf-body">' + E(body) + "</div></details>" : "") + (sfFiles(i) ? '<span class="co-note">' + sfFiles(i) + "</span>" : "");
}
function sfAge(i) { return fmtDate(ymdLocal(new Date(i.at))); }
var SF_OPEN = { new: 0, progress: 1, manager: 0, hr: 0, submitted: 0, checked: 1 };

// The ongoing projects on Admin's and HR's Projects tab: every submission
// of that form is a task under it.
var SF_ONGOING = {
  "Administrative": [{ kind: "admin", title: "Admin requests", note: "Every admin request staff send from Staff-Facing comes in here as a task." }],
  "HR": [{ kind: "hr_issue", title: "HR issues", note: "Every HR issue staff send comes in here as a task. HR, Leadership and full access only." },
    { kind: "perf_comment", title: "Performance comments", note: "Every performance comment comes in here. Add anything that needs to go on the record in Performance (and PerformYard) yourself." }]
};
function renderFormProjects(dept) {
  var groups = SF_ONGOING[dept];
  if (!groups) return "";
  var c = sfDept(dept);
  if (c.error) return '<div class="banner">' + E(c.error) + "</div>";
  if (!c.data) return '<div class="empty">Loading staff requests…</div>';
  var d = c.data;
  return groups.map(function (g) {
    var all = d.items.filter(function (i) { return i.kind === g.kind; });
    var fields = [
      { key: "status", label: "Status", get: function (i) { return sfStatusLabel(i.kind, i.status); } },
      { key: "owner", label: "Responsible", get: function (i) { return i.assignee || "Unassigned"; } },
      { key: "by", label: "From", get: function (i) { return i.by; } },
      { key: "what", label: g.kind === "admin" ? "Category" : g.kind === "hr_issue" ? "Topic" : "Kind", get: function (i) { var f = i.fields || {}; return f.category || f.topic || f.type; } },
      { key: "month", label: "Sent", get: function (i) { return new Date(i.at).toLocaleString([], { month: "short", year: "numeric" }); } }
    ];
    if (g.kind === "perf_comment") fields.push({ key: "about", label: "About", get: function (i) { return (i.fields || {}).about; } });
    if (myCompanies().length > 1) fields.push({ key: "co", label: "Company", get: function (i) { return shortCo(i.company); } });
    var scope = "sfp:" + g.kind;
    var list = applyColFilters(scope, fields, all).sort(function (a, b) {
      return (SF_OPEN[a.status] != null ? 0 : 1) - (SF_OPEN[b.status] != null ? 0 : 1) || b.at - a.at;
    });
    var open = all.filter(function (i) { return SF_OPEN[i.status] != null; }).length;
    var can = d.canWork;
    var title = function (i) {
      var f = i.fields || {};
      if (i.kind === "admin") return f.category + (f.neededBy ? " · needed by " + fmtDate(f.neededBy) : "");
      if (i.kind === "hr_issue") return (f.urgent ? "URGENT · " : "") + f.subject;
      return f.type + " about " + f.about;
    };
    return '<div class="section-title"><div><h2>' + E(g.title) + ' <span class="pill">Ongoing</span></h2><span class="small-note">' + E(g.note) + " " + open + " open of " + all.length + ".</span></div></div>" +
      filterUi(scope, fields, all, list.length) +
      '<div class="table-wrap"><table class="wide"><thead><tr><th>Task</th><th>From</th><th>Sent</th><th>Person responsible</th><th>Status</th><th>Notes</th></tr></thead><tbody>' +
      (list.length ? list.map(function (i) {
        return '<tr class="' + (SF_OPEN[i.status] == null ? "done" : "") + '"><td class="sf-what"><div class="name-cell"><span class="indent">↳</span><b>' + E(title(i)) + "</b></div>" + sfDetails(i) + (i.reason ? '<span class="co-note">Reason given: ' + E(i.reason) + "</span>" : "") + "</td>" +
          "<td>" + E(i.by) + (myCompanies().length > 1 ? '<span class="co-note">' + E(shortCo(i.company)) + "</span>" : "") + "</td><td>" + E(sfAge(i)) + "</td>" +
          "<td>" + sfAssignPick(dept, i, can, d.people) + "</td><td>" + sfStatusPick(dept, i, can) + '</td><td class="notes-cell">' + sfNotes(dept, i, can) + "</td></tr>";
      }).join("") : '<tr><td colspan="6" class="empty">' + (all.length ? "Nothing matches these filters." : "Nothing sent yet.") + "</td></tr>") +
      "</tbody></table></div>";
  }).join("") + '<div class="section-title" style="margin-top:26px;"><div><h2>Projects</h2><span class="small-note">' + E(shortDept(dept)) + "'s own longer-term work, with sub-tasks.</span></div></div>";
}
// Changing a status to Declined or Rejected asks for a reason, which the
// person who sent it sees.
document.addEventListener("change", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (ds.sfdSt) {
    var dept = ds.sfDept, to = t.value;
    if (to === "declined" || to === "rejected") {
      sfAsk(to === "declined" ? "Decline this request" : "Reject this reimbursement", "Why? The person who sent it will see this.", function (reason) { sfUpdate(dept, ds.sfdSt, { status: to, reason: reason }); });
      setTimeout(render, 0);
      return;
    }
    sfUpdate(dept, ds.sfdSt, { status: to });
  } else if (ds.sfdAs) sfUpdate(ds.sfDept, ds.sfdAs, { assignee: t.value });
  else if (ds.sfdNotes) sfUpdate(ds.sfDept, ds.sfdNotes, { notes: t.value });
});

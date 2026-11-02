"use strict";
// People: every login with its employment file and the one-click spot bonus.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- People ----
// Leadership only (the server checks every request). Weekly base pay, pay
// currency and entity are the same record HR → Payroll edits. History is
// read-only, from approved leave, payroll adjustments and performance
// comments. Nothing here works out pay: a qualified person checks every
// figure before any real payroll is sent.
var ppl = { list: null, at: 0, loading: false, error: "", sel: "", person: null, personAt: 0, personLoading: "", personError: "", editing: "", draft: null, saving: false, bonusing: false };
// The file's sections, each read-only until its own Edit. Save sends only
// that section's fields. Pay (and entity) can't be edited on your own file.
var PP_SECTIONS = {
  employment: { label: "Employment", keys: ["jobTitle", "department", "manager", "startDate", "birthday", "employmentType", "entity", "notes"] },
  pay: { label: "Pay", keys: ["basePay", "currency", "exempt"] },
  emergency: { label: "Emergency contact", keys: ["emergency"] },
  other: { label: "Other notes", keys: ["otherNotes"] }
};
var PP_EMERGENCY = [["name", "Name"], ["relationship", "Relationship"], ["phone", "Phone"], ["email", "Email"]];
function loadPeople() {
  if (ppl.loading) return;
  ppl.loading = true;
  api("/api/people").then(function (d) { ppl.list = d; ppl.error = ""; }, function (err) { ppl.error = err.message; })
    .then(function () { ppl.loading = false; ppl.at = Date.now(); requestRender(); });
}
function loadPerson(username) {
  if (ppl.personLoading === username) return;
  ppl.personLoading = username;
  api("/api/people/" + encodeURIComponent(username)).then(function (d) {
    if (ppl.sel !== username) return;
    ppl.person = d; ppl.personError = "";
  }, function (err) { ppl.personError = err.message; })
    .then(function () { ppl.personLoading = ""; ppl.personAt = Date.now(); requestRender(); });
}
function ppDraftOf(d) {
  var x = { emergency: Object.assign({ name: "", relationship: "", phone: "", email: "" }, d.emergency || {}),
    basePay: d.pay.basePay == null ? "" : String(d.pay.basePay), currency: d.pay.currency || "", entity: d.pay.entity || "", exempt: d.pay.exempt === true };
  ["jobTitle", "department", "manager", "startDate", "birthday", "employmentType", "notes", "otherNotes"].forEach(function (k) { x[k] = d[k] || ""; });
  return x;
}
function ppSelf(d) { return !!(d && sameUser(d.username, me.username)); }
function ppSourceLabel(s) { return s === "spot-bonus" ? "Spot bonus" : s === "manual" ? "HR" : s || "—"; }

function renderPeople() {
  if (!me.leadership) { setBreadcrumb(["Company", "People"]); return '<div class="empty">People is for Leadership only.</div>'; }
  return ppl.sel ? renderPersonFile() : renderPeopleList();
}

function renderPeopleList() {
  setBreadcrumb(["Company", "People"]);
  if (!ppl.loading && (ppl.error ? Date.now() - ppl.at > 15000 : !ppl.list || Date.now() - ppl.at > 60000)) loadPeople();
  var head = '<div class="intro"><div><div class="eyebrow">Company · Leadership only</div><h1>People</h1>' +
    "<p>Every login with its employment file. Open a person to edit their file, add supporting documents or give a spot bonus ($100 on their next pay week).</p></div></div>";
  if (ppl.error) return head + '<div class="banner">' + E(ppl.error) + "</div>";
  if (!ppl.list) return head + '<div class="empty">Loading people…</div>';
  var labels = ppl.list.entityLabels || {};
  var fields = [
    { key: "entity", label: "Entity", get: function (p) { return p.entity; } },
    { key: "department", label: "Department", get: function (p) { return p.department || "—"; } },
    { key: "role", label: "Role", get: function (p) { return p.role; } },
    { key: "type", label: "Employment type", get: function (p) { return p.employmentType || "Not set"; } }
  ];
  var all = ppl.list.people, list = applyColFilters("people", fields, all);
  return head + filterUi("people", fields, all, list.length) +
    '<div class="table-wrap"><table class="narrow"><thead><tr><th>Name</th><th>Email</th><th>Company / entity</th><th>Department</th><th>Role</th><th>Job title</th></tr></thead><tbody>' +
    (list.length ? list.map(function (p) {
      return '<tr><td><button type="button" class="text-button" style="font-size:13px;" data-pp-open="' + E(p.username) + '">' + E(p.username) + "</button></td>" +
        "<td>" + (p.email ? E(p.email) : '<span class="dim">—</span>') + "</td>" +
        "<td>" + E(p.companies.join(", ")) + '<span class="co-note">' + E(labels[p.entity] || p.entity) + "</span></td>" +
        "<td>" + (p.department ? E(p.department) : '<span class="dim">—</span>') + "</td>" +
        "<td>" + E(p.role) + "</td>" +
        "<td>" + (p.jobTitle ? E(p.jobTitle) : '<span class="dim">Not set</span>') + "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="empty">' + (all.length ? "Nothing matches these filters." : "No logins yet.") + "</td></tr>") +
    "</tbody></table></div>";
}

function renderPersonFile() {
  var sel = ppl.sel;
  setBreadcrumb(["Company", "People", sel]);
  if (ppl.personLoading !== sel && (ppl.personError ? Date.now() - ppl.personAt > 15000 : !ppl.person || ppl.person.username !== sel || Date.now() - ppl.personAt > 60000)) loadPerson(sel);
  var back = '<p><button type="button" class="text-button" data-pp-back>← All people</button></p>';
  if (ppl.personError) return back + '<div class="banner">' + E(ppl.personError) + "</div>";
  var d = ppl.person;
  if (!d || d.username !== sel) return back + '<div class="empty">Loading…</div>';
  var o = d.options, self = ppSelf(d), cur = d.spot.currency, ed = ppl.editing, x = ppl.draft || {};
  var dim = function (t) { return '<span class="dim">' + (t || "—") + "</span>"; };
  var lines = function (v) { return E(v).replace(/\n/g, "<br>"); };
  var input = function (key, type, extra) { return '<input id="pp-' + key + '"' + (type ? ' type="' + type + '"' : "") + ' data-pp-f="' + key + '" value="' + E(x[key]) + '"' + (extra || "") + ">"; };
  var area = function (key, rows) { return '<textarea id="pp-' + key + '" rows="' + rows + '" data-pp-f="' + key + '">' + E(x[key]) + "</textarea>"; };
  var pick = function (key, values, labels, blank) {
    return '<select id="pp-' + key + '" data-pp-f="' + key + '"><option value="">' + E(blank) + "</option>" + values.map(function (v, i) {
      return '<option value="' + E(v) + '"' + (x[key] === v ? " selected" : "") + ">" + E(labels ? labels[i] : v) + "</option>"; }).join("") + "</select>";
  };
  var ents = Object.keys(o.entities);
  var entityText = E(o.entities[d.entity] || d.entity) + (d.pay.entity ? "" : ' <span class="small-note">(from their login\'s company)</span>');
  // One label | value row; `edit` is the input shown while the section is being edited.
  var row = function (id, label, value, edit) {
    return '<tr><td style="width:32%;"><b>' + (edit != null ? '<label for="pp-' + id + '">' + E(label) + "</label>" : E(label)) + "</b></td><td>" +
      (edit != null ? '<div class="nb-field" style="margin:0;">' + edit + "</div>" : value) + "</td></tr>";
  };
  // A section card: read-only table, or inputs with Save / Cancel while it's the one being edited.
  var section = function (key, note, rows, canEdit) {
    var on = ed === key;
    return '<div class="card" style="padding:16px 18px;margin-bottom:14px;"><div style="display:flex;align-items:center;gap:10px;"><div class="card-label" style="margin:0;">' + E(PP_SECTIONS[key].label) + '</div><span style="flex:1"></span>' +
      (canEdit && !on ? '<button type="button" data-pp-edit="' + key + '"' + (ed ? " disabled" : "") + ">Edit</button>" : "") + "</div>" +
      (note ? '<p class="small-note" style="margin:6px 0 0;">' + note + "</p>" : "") +
      '<div class="table-wrap" style="margin-top:10px;"><table class="narrow"><tbody>' + rows(on) + "</tbody></table></div>" +
      (on ? '<div class="nb-foot"><button type="button" class="primary" data-pp-save' + (ppl.saving ? " disabled" : "") + ">" + (ppl.saving ? "Saving…" : "Save") + '</button><button type="button" class="text-button" data-pp-cancel>Cancel</button></div>' : "") + "</div>";
  };

  var head = back + '<div class="intro"><div><div class="eyebrow">People · ' + E(d.role) + "</div><h1>" + E(d.username) + "</h1>" +
    "<p>" + E([d.jobTitle, d.department, d.companies.join(", ")].filter(Boolean).join(" · ")) + (d.email ? ' · <a class="links-a" href="mailto:' + E(d.email) + '">' + E(d.email) + "</a>" : "") + "</p>" +
    (d.updatedBy ? '<p class="small-note">Last changed by ' + E(d.updatedBy) + " · " + E(new Date(d.updatedAt).toLocaleString()) + "</p>" : "") + "</div>" +
    (self ? '<span class="small-note">Your own file: someone else in Leadership (or HR) changes your pay or gives you a spot bonus.</span>'
      : '<button type="button" class="primary" data-pp-bonus' + (ppl.bonusing ? " disabled" : "") + ">★ Spot bonus (" + E(cur) + " " + d.spot.amount + ")</button>") + "</div>";

  var employment = section("employment", "", function (on) {
    var v = function (k) { return d[k] ? E(d[k]) : dim("Not set"); };
    var date = function (k) { return d[k] ? E(fmtDate(d[k])) : dim("Not set"); };
    return row("jobTitle", "Job title", v("jobTitle"), on ? input("jobTitle", "", ' placeholder="e.g. Procurement Specialist"') : null) +
      row("department", "Department", v("department"), on ? pick("department", o.departments, null, "Not set") : null) +
      row("manager", "Manager", v("manager"), on ? pick("manager", o.logins, null, "Not set") : null) +
      row("startDate", "Start date", date("startDate"), on ? input("startDate", "date") : null) +
      row("birthday", "Birthday", date("birthday"), on ? input("birthday", "date") : null) +
      row("employmentType", "Employment type", v("employmentType"), on ? pick("employmentType", o.employmentTypes, null, "Not set") : null) +
      row("entity", "Entity (same as HR → Payroll)", entityText, on && !self ? pick("entity", ents, ents.map(function (k) { return o.entities[k]; }), "From their login's company") : null) +
      row("notes", "Notes (Leadership only)", d.notes ? lines(d.notes) : dim(), on ? area("notes", 3) : null);
  }, true);

  var payCard = section("pay", "The same record as HR → Payroll: changing it here changes it there. <b>Not a payroll calculation — a qualified person checks every figure before any real payroll is sent.</b>", function (on) {
    return row("basePay", "Weekly base pay", d.pay.basePay == null ? dim("Not entered") : E(sfAmount(d.pay.basePay, cur)), on ? input("basePay", "number", ' step="0.01" min="0" placeholder="Not entered"') : null) +
      row("currency", "Pay currency", d.pay.currency ? E(d.pay.currency) : E(cur) + ' <span class="small-note">(not set on them — ' + (d.pay.entityCurrency ? "their entity's" : "USD by default") + ")</span>",
        on ? pick("currency", o.currencies, null, "Entity's currency" + (d.pay.entityCurrency ? " (" + d.pay.entityCurrency + ")" : ", else USD")) : null) +
      // SOI (US) only: a flag, set by HR or Leadership. Nothing works out overtime from it.
      (d.entity === "SOI" ? row("exempt", "Exempt (salaried, no overtime)", (d.pay.exempt === true ? "Yes — exempt" : d.pay.exempt === false ? "No — hourly" : dim("Not set")) + ' <span class="small-note">Set by HR or Leadership</span>',
        on ? '<label class="sf-check"><input type="checkbox" class="check" id="pp-exempt" data-pp-f="exempt"' + (x.exempt ? " checked" : "") + "> Exempt (salaried, no overtime)</label>" : null) : "") +
      row("", "Employee ID (from HR → Payroll)", d.pay.employeeId ? E(d.pay.employeeId) : dim("Not entered")) +
      row("", "Tax and national ID numbers", '<span class="small-note"><i>[Placeholder — not stored in the tracker. Kept in the payroll provider\'s records.]</i></span>');
  }, !self);

  var emergency = section("emergency", "", function (on) {
    var em = d.emergency || {};
    return PP_EMERGENCY.map(function (f) {
      return row("em-" + f[0], f[1], em[f[0]] ? E(em[f[0]]) : dim(),
        on ? '<input id="pp-em-' + f[0] + '"' + (f[0] === "email" ? ' type="email"' : f[0] === "phone" ? ' type="tel"' : "") + ' data-pp-em="' + f[0] + '" value="' + E(x.emergency[f[0]] || "") + '">' : null);
    }).join("");
  }, true);

  var other = section("other", "HR's notes on the person: preferences and anything else worth knowing. Leadership only; the change history records that the notes changed, not what they say.", function (on) {
    return row("otherNotes", "Other notes", d.otherNotes ? lines(d.otherNotes) : dim("Not entered"), on ? area("otherNotes", 5) : null);
  }, true);

  var docs = '<div class="card" style="padding:16px 18px;margin-bottom:14px;"><div class="card-label">Supporting documents</div>' +
    '<div class="perf-files" style="margin-top:8px;">' + d.files.map(function (f) {
      return '<span class="perf-file">📎 <button type="button" data-pp-dl="' + E(f.id) + '" title="View">' + E(f.name) + "</button>" +
        '<span class="small-note">' + Math.max(1, Math.round(f.size / 1024)) + " KB · " + E(f.by) + '</span><button type="button" data-pp-rmfile="' + E(f.id) + '" title="Remove" aria-label="Remove document">✕</button></span>';
    }).join("") + '<input type="file" data-pp-files multiple hidden><button type="button" class="text-button" data-pp-attach>📎 Add a document</button></div>' +
    '<p class="small-note" style="margin-top:8px;">Contract, offer letter, certificates. PDF, image, Word, Excel, text or email, up to 10 MB each.</p></div>';

  // ---- History (read-only) ----
  var table = function (heads, rows, none) {
    return '<div class="table-wrap"><table class="narrow"><thead><tr>' + heads.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead><tbody>" +
      (rows || '<tr><td colspan="' + heads.length + '" class="empty">' + none + "</td></tr>") + "</tbody></table></div>";
  };
  var adjRows = d.adjustments.map(function (a) {
    return "<tr><td>" + E(fmtDate(a.week)) + "</td><td>" + E(a.currency + " " + Number(a.amount).toFixed(2)) + "</td><td>" + E(ppSourceLabel(a.source)) + "</td><td>" + E(a.reason) + '<span class="co-note">' + E(a.by || "") + "</span></td>" +
      '<td class="row-tools">' + (a.source === "spot-bonus" && a.removable ? '<button type="button" class="text-button" data-pp-rmbonus="' + E(a.id) + '">Remove</button>' : "") + "</td></tr>";
  }).join("");
  var leaveRows = d.leave.map(function (i) {
    var f = i.fields;
    return "<tr><td>" + E(f.type === "other" ? f.otherType : SF_LEAVE_LABEL[f.type]) + "</td><td>" + E(fmtDate(f.from)) + (f.to !== f.from ? " – " + E(fmtDate(f.to)) : "") + "</td><td>" + E(f.days) + "</td></tr>";
  }).join("");
  var commentRows = d.perfComments.map(function (i) {
    return "<tr><td>" + E(fmtDate(new Date(i.at).toISOString().slice(0, 10))) + "</td><td>" + E(i.fields.type) + "</td><td>" + E(i.fields.details) + '<span class="co-note">From ' + E(i.by) + "</span></td><td>" + sfChip("perf_comment", i.status) + "</td></tr>";
  }).join("");
  var unmatched = d.perfUnmatched.length ? '<p class="small-note"><b>Unmatched:</b> ' + d.perfUnmatched.map(function (i) {
    return E(i.type) + " about “" + E(i.about) + "” (" + E(fmtDate(new Date(i.at).toISOString().slice(0, 10))) + ") could be " + E(i.could.join(" or "));
  }).join("; ") + ". Not attached to anyone's file; HR → Department-Facing → Projects has the comment.</p>" : "";
  // The Performance tracker is private: a summary and a way in for
  // Leadership with Performance access, a pointer for everyone else.
  var pf = d.performance, perfRows = pf.access ? pf.records.map(function (r) {
    return "<tr><td>" + E(r.name) + (r.key.indexOf("x-") === 0 ? '<span class="co-note">Added without a login</span>' : "") + "</td><td>" + E(r.stageLabel) + (r.stageDate ? '<span class="co-note">Since ' + E(fmtDate(r.stageDate)) + "</span>" : "") + "</td><td>" + r.notes + "</td>" +
      '<td class="row-tools"><button type="button" class="text-button" data-pp-perf="' + E(r.key) + '">Open in Performance</button></td></tr>';
  }).join("") : "";
  var perfPart = pf.access ? table(["Record", "Stage", "Notes", ""], perfRows, "No Performance record for this person.")
    : '<p class="small-note">' + (pf.exists ? "<b>Performance records exist.</b> Open HR → Performance (needs Performance access)." : "No Performance records, or you don't have Performance access to see them.") + "</p>";
  var history = '<div class="section-title" style="margin-top:22px;"><div><h2>History</h2><span class="small-note">Read-only, from what\'s already in the tracker.</span></div></div>' +
    '<div class="card-label">Spot bonuses and payroll adjustments</div>' +
    table(["Pay week", "Amount", "From", "What for", ""], adjRows, "None yet.") +
    '<p class="small-note">A spot bonus can be removed here until HR approves that week and sends it to the accountants (HR → Payroll); after that, HR has to undo the approval first.</p>' +
    '<div class="card-label" style="margin-top:16px;">Approved leave</div>' + table(["Leave", "Dates", "Days"], leaveRows, "No approved leave.") +
    '<div class="card-label" style="margin-top:16px;">Performance comments</div>' + table(["Sent", "Type", "Comment", "Status"], commentRows, "No performance comments about this person.") + unmatched +
    '<div class="card-label" style="margin-top:16px;">Performance tracker (HR → Performance)</div>' + perfPart +
    '<div class="card-label" style="margin-top:16px;">Changes to this file</div>' + (d.history.length ? '<ul class="small-note">' + d.history.slice(0, 30).map(function (h) {
      return "<li>" + E(new Date(h.at).toLocaleString()) + " · " + E(h.by) + " — " + E(h.what) + "</li>"; }).join("") + "</ul>" : '<p class="small-note">No changes saved yet.</p>');

  return head + employment + payCard + emergency + other + docs + history;
}

// A confirm with an optional reason (the spot bonus).
function ppConfirm(title, message, label, done) {
  var box = document.createElement("div");
  box.className = "rs-modal";
  box.innerHTML = '<div class="rs-card" role="dialog" aria-modal="true" aria-labelledby="ppAskT"><h3 id="ppAskT">' + E(title) + "</h3><p>" + message + "</p>" +
    '<div class="nb-field"><label for="ppAskText">' + E(label) + '</label><textarea id="ppAskText" rows="2"></textarea></div>' +
    '<div class="nb-foot"><span class="grow"></span><button type="button" class="text-button" data-ppa="no">Cancel</button><button type="button" class="primary" data-ppa="ok">Confirm</button></div></div>';
  document.body.appendChild(box);
  var ta = box.querySelector("textarea");
  ta.focus();
  box.addEventListener("click", function (e) {
    var b = e.target.closest("[data-ppa]");
    if (!b && e.target !== box) return;
    box.remove();
    if (b && b.dataset.ppa === "ok") done(ta.value.trim());
  });
}
function ppReload() { ppl.personAt = 0; ppl.at = 0; pay.at = 0; if (ppl.sel) loadPerson(ppl.sel); }
function ppBase() { return "/api/people/" + encodeURIComponent(ppl.sel); }
function ppUpload(files) {
  var list = Array.prototype.slice.call(files || []);
  if (!list.length) return;
  toast("Uploading " + list.length + " file" + (list.length === 1 ? "" : "s") + "…");
  list.reduce(function (p, f) {
    return p.then(function () {
      return fetch(ppBase() + "/files?name=" + encodeURIComponent(f.name), { method: "POST", headers: { Authorization: "Bearer " + token(), "Content-Type": "application/octet-stream" }, body: f })
        .then(function (r) { return r.json().then(function (x) { if (!r.ok) throw new Error(f.name + ": " + (x.error || "upload failed")); }); });
    });
  }, Promise.resolve()).then(function () { toast("Added."); }, function (err) { toast(err.message, true); }).then(ppReload);
}

document.addEventListener("input", function (e) {
  var ds = e.target.dataset || {};
  if (!ppl.draft) return;
  if (ds.ppF) ppl.draft[ds.ppF] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  else if (ds.ppEm) ppl.draft.emergency[ds.ppEm] = e.target.value;
});
document.addEventListener("change", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (ds.ppF && ppl.draft) ppl.draft[ds.ppF] = t.type === "checkbox" ? t.checked : t.value;
  else if ("ppFiles" in ds) { ppUpload(t.files); t.value = ""; }
});
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-pp-open],[data-pp-back],[data-pp-edit],[data-pp-save],[data-pp-cancel],[data-pp-bonus],[data-pp-rmbonus],[data-pp-attach],[data-pp-dl],[data-pp-rmfile],[data-pp-perf]");
  if (!t || !$("#view").contains(t)) return;
  var ds = t.dataset, d = ppl.person;
  if (ds.ppOpen) { ppl.sel = ds.ppOpen; ppl.person = null; ppl.editing = ""; ppl.draft = null; ppl.personError = ""; render(); window.scrollTo(0, 0); }
  else if ("ppBack" in ds) { ppl.sel = ""; ppl.person = null; ppl.editing = ""; ppl.draft = null; ppl.at = 0; render(); }
  else if (ds.ppEdit && d) { ppl.editing = ds.ppEdit; ppl.draft = ppDraftOf(d); render(); var first = $("#view").querySelector("[data-pp-f],[data-pp-em]"); if (first) first.focus(); }
  else if ("ppCancel" in ds) { ppl.editing = ""; ppl.draft = null; render(); }
  else if ("ppSave" in ds && d && ppl.editing) {
    var x = ppl.draft, body = {};
    PP_SECTIONS[ppl.editing].keys.forEach(function (k) {
      if (ppSelf(d) && ["entity", "basePay", "currency", "exempt"].indexOf(k) !== -1) return;
      if (k === "exempt" && d.entity !== "SOI") return;
      body[k] = x[k];
    });
    ppl.saving = true; render();
    api(ppBase(), { method: "PUT", body: JSON.stringify(body) })
      .then(function (r) { ppl.editing = ""; ppl.draft = null; toast(r.changed.length ? "Saved: " + r.changed.join(", ") + "." : "No changes to save."); }, function (err) { toast(err.message, true); })
      .then(function () { ppl.saving = false; ppReload(); render(); });
  }
  else if ("ppBonus" in ds && d) {
    var cur = d.spot.currency, who = d.username;
    ppConfirm("Spot bonus for " + who,
      "Add <b>" + E(cur + " " + d.spot.amount.toFixed(2)) + "</b> to " + E(who) + "'s pay for the week of <b>" + E(fmtDate(d.spot.week)) + "</b>? It shows on HR → Payroll for that week, in " + E(cur) + ".",
      "Reason (optional — HR and Leadership see it)", function (reason) {
        ppl.bonusing = true; render();
        api(ppBase() + "/spot-bonus", { method: "POST", body: JSON.stringify({ reason: reason, currency: cur }) })
          .then(function (a) { toast("Spot bonus added: " + a.currency + " " + a.amount + " for the week of " + fmtDate(a.week) + "."); }, function (err) { toast(err.message, true); })
          .then(function () { ppl.bonusing = false; ppReload(); render(); });
      });
  }
  else if (ds.ppRmbonus) {
    if (!confirm("Remove this spot bonus? It comes off HR → Payroll too.")) return;
    api(ppBase() + "/spot-bonus/" + encodeURIComponent(ds.ppRmbonus), { method: "DELETE" })
      .then(function () { toast("Spot bonus removed."); }, function (err) { toast(err.message, true); }).then(ppReload);
  }
  // Opens that record on HR → Performance (or Tools → Performance for
  // logins without HR), the same way the #performance link does.
  else if (ds.ppPerf) {
    perf.sel = ds.ppPerf; perf.person = null; perf.composing = false; perf.editing = ""; perf.stepping = false; perf.form = {}; perf.step = { date: today };
    perf.at = 0; go("performance");
  }
  else if ("ppAttach" in ds) { var inp = $("#view").querySelector("[data-pp-files]"); if (inp) inp.click(); }
  else if (ds.ppDl && d) {
    var meta = d.files.filter(function (f) { return f.id === ds.ppDl; })[0];
    viewDocument(ppBase() + "/files/" + encodeURIComponent(ds.ppDl), meta && meta.name, meta && meta.type);
  }
  else if (ds.ppRmfile) {
    if (!confirm("Remove this document? It's deleted from storage.")) return;
    api(ppBase() + "/files/" + encodeURIComponent(ds.ppRmfile), { method: "DELETE" })
      .then(function () { toast("Removed."); }, function (err) { toast(err.message, true); }).then(ppReload);
  }
});

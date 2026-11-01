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
var ppl = { list: null, at: 0, loading: false, error: "", sel: "", person: null, personAt: 0, personLoading: "", personError: "", draft: null, saving: false, bonusing: false };
var PP_FIELDS = [["jobTitle", "Job title"], ["department", "Department"], ["manager", "Manager"], ["startDate", "Start date"], ["employmentType", "Employment type"]];
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
    // Keep what's being typed; start a fresh draft for a new person.
    if (!ppl.person || ppl.person.username !== d.username || !ppl.draft) ppl.draft = ppDraftOf(d);
    ppl.person = d; ppl.personError = "";
  }, function (err) { ppl.personError = err.message; })
    .then(function () { ppl.personLoading = ""; ppl.personAt = Date.now(); requestRender(); });
}
function ppDraftOf(d) {
  var x = { emergency: Object.assign({ name: "", relationship: "", phone: "", email: "" }, d.emergency || {}), notes: d.notes || "",
    basePay: d.pay.basePay == null ? "" : String(d.pay.basePay), currency: d.pay.currency || "", entity: d.pay.entity || "" };
  PP_FIELDS.forEach(function (f) { x[f[0]] = d[f[0]] || ""; });
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
  if (!d || d.username !== sel || !ppl.draft) return back + '<div class="empty">Loading…</div>';
  var x = ppl.draft, o = d.options, self = ppSelf(d), cur = d.spot.currency;
  var sel1 = function (key, values, labels, blank) {
    return '<select id="pp-' + key + '" data-pp-f="' + key + '"><option value="">' + E(blank) + "</option>" + values.map(function (v, i) {
      return '<option value="' + E(v) + '"' + (x[key] === v ? " selected" : "") + ">" + E(labels ? labels[i] : v) + "</option>"; }).join("") + "</select>";
  };
  var field = function (key, label, input) { return '<div class="nb-field"><label for="pp-' + key + '">' + E(label) + "</label>" + input + "</div>"; };
  var ents = Object.keys(o.entities);

  var head = back + '<div class="intro"><div><div class="eyebrow">People · ' + E(d.role) + "</div><h1>" + E(d.username) + "</h1>" +
    "<p>" + E([d.jobTitle, d.department, d.companies.join(", ")].filter(Boolean).join(" · ")) + (d.email ? ' · <a class="links-a" href="mailto:' + E(d.email) + '">' + E(d.email) + "</a>" : "") + "</p></div>" +
    (self ? '<span class="small-note">Your own file: someone else in Leadership (or HR) changes your pay or gives you a spot bonus.</span>'
      : '<button type="button" class="primary" data-pp-bonus' + (ppl.bonusing ? " disabled" : "") + ">★ Spot bonus (" + E(cur) + " " + d.spot.amount + ")</button>") + "</div>";

  var employment = '<div class="card" style="padding:16px 18px;margin-bottom:14px;"><div class="card-label">Employment</div><div class="grid-2" style="gap:0 16px;margin-top:10px;">' +
    field("jobTitle", "Job title", '<input id="pp-jobTitle" data-pp-f="jobTitle" value="' + E(x.jobTitle) + '" placeholder="e.g. Procurement Specialist">') +
    field("department", "Department", sel1("department", o.departments, null, "Not set")) +
    field("manager", "Manager", sel1("manager", o.logins, null, "Not set")) +
    field("startDate", "Start date", '<input id="pp-startDate" type="date" data-pp-f="startDate" value="' + E(x.startDate) + '">') +
    field("employmentType", "Employment type", sel1("employmentType", o.employmentTypes, null, "Not set")) +
    field("entity", "Entity (same as HR → Payroll)", self ? '<div class="small-note">' + E(o.entities[d.entity] || d.entity) + "</div>" : sel1("entity", ents, ents.map(function (k) { return o.entities[k]; }), "From their login's company")) +
    "</div></div>";

  var payCard = '<div class="card" style="padding:16px 18px;margin-bottom:14px;"><div class="card-label">Pay</div>' +
    '<p class="small-note" style="margin:6px 0 12px;">The same record as HR → Payroll: changing it here changes it there. <b>Not a payroll calculation — a qualified person checks every figure before any real payroll is sent.</b></p>' +
    '<div class="grid-2" style="gap:0 16px;">' +
    field("basePay", "Weekly base pay", self ? '<div class="small-note">' + (d.pay.basePay == null ? "Not entered" : E(sfAmount(d.pay.basePay, cur))) + "</div>"
      : '<input id="pp-basePay" type="number" step="0.01" min="0" data-pp-f="basePay" value="' + E(x.basePay) + '" placeholder="Not entered">') +
    field("currency", "Pay currency", self ? '<div class="small-note">' + E(cur) + "</div>" : sel1("currency", o.currencies, null, "Entity's currency" + (d.pay.entityCurrency ? " (" + d.pay.entityCurrency + ")" : ", else USD"))) +
    '<div class="nb-field"><label>Employee ID (from HR → Payroll)</label><div class="small-note">' + (d.pay.employeeId ? E(d.pay.employeeId) : "<i>Not entered</i>") + "</div></div>" +
    '<div class="nb-field"><label>Tax and national ID numbers</label><div class="small-note"><i>[Placeholder — not stored in the tracker. Kept in the payroll provider\'s records.]</i></div></div>' +
    "</div></div>";

  var em = x.emergency;
  var emergency = '<div class="card" style="padding:16px 18px;margin-bottom:14px;"><div class="card-label">Emergency contact</div><div class="grid-2" style="gap:0 16px;margin-top:10px;">' +
    [["name", "Name"], ["relationship", "Relationship"], ["phone", "Phone"], ["email", "Email"]].map(function (f) {
      return '<div class="nb-field"><label for="pp-em-' + f[0] + '">' + f[1] + '</label><input id="pp-em-' + f[0] + '" data-pp-em="' + f[0] + '" value="' + E(em[f[0]] || "") + '"></div>';
    }).join("") + "</div>" +
    '<div class="nb-field"><label for="pp-notes">Notes (Leadership only)</label><textarea id="pp-notes" rows="3" data-pp-f="notes">' + E(x.notes) + "</textarea></div>" +
    '<div class="nb-foot"><button type="button" class="primary" data-pp-save' + (ppl.saving ? " disabled" : "") + ">" + (ppl.saving ? "Saving…" : "Save file") + "</button>" +
    '<button type="button" class="text-button" data-pp-reset>Undo changes</button>' +
    (d.updatedBy ? '<span class="small-note">Last saved by ' + E(d.updatedBy) + " · " + E(new Date(d.updatedAt).toLocaleString()) + "</span>" : "") + "</div></div>";

  var docs = '<div class="card" style="padding:16px 18px;margin-bottom:14px;"><div class="card-label">Supporting documents</div>' +
    '<div class="perf-files" style="margin-top:8px;">' + d.files.map(function (f) {
      return '<span class="perf-file">📎 <button type="button" data-pp-dl="' + E(f.id) + '" title="Download">' + E(f.name) + "</button>" +
        '<span class="small-note">' + Math.max(1, Math.round(f.size / 1024)) + " KB · " + E(f.by) + '</span><button type="button" data-pp-rmfile="' + E(f.id) + '" title="Remove" aria-label="Remove document">✕</button></span>';
    }).join("") + '<input type="file" data-pp-files multiple hidden><button type="button" class="text-button" data-pp-attach>📎 Add a document</button></div>' +
    '<p class="small-note" style="margin-top:8px;">Contract, offer letter, certificates. PDF, image, Word, Excel, text or email, up to 10 MB each.</p></div>';

  // ---- History (read-only) ----
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
  var table = function (heads, rows, none) {
    return '<div class="table-wrap"><table class="narrow"><thead><tr>' + heads.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead><tbody>" +
      (rows || '<tr><td colspan="' + heads.length + '" class="empty">' + none + "</td></tr>") + "</tbody></table></div>";
  };
  var history = '<div class="section-title" style="margin-top:22px;"><div><h2>History</h2><span class="small-note">Read-only, from what\'s already in the tracker.</span></div></div>' +
    '<div class="card-label">Spot bonuses and payroll adjustments</div>' +
    table(["Pay week", "Amount", "From", "What for", ""], adjRows, "None yet.") +
    '<p class="small-note">A spot bonus can be removed here until its pay week ends; after that, ask HR.</p>' +
    '<div class="card-label" style="margin-top:16px;">Approved leave</div>' + table(["Leave", "Dates", "Days"], leaveRows, "No approved leave.") +
    '<div class="card-label" style="margin-top:16px;">Performance comments</div>' + table(["Sent", "Type", "Comment", "Status"], commentRows, "No performance comments name this login.") +
    (d.performance ? '<p class="small-note">Performance tracker: ' + E(d.performance.stageLabel) + (d.performance.stageDate ? " since " + E(fmtDate(d.performance.stageDate)) : "") + " · " + d.performance.notes + " note(s). Details are on Performance.</p>" : "") +
    (d.history.length ? '<div class="card-label" style="margin-top:16px;">Changes to this file</div><ul class="small-note">' + d.history.slice(0, 30).map(function (h) {
      return "<li>" + E(new Date(h.at).toLocaleString()) + " · " + E(h.by) + " — " + E(h.what) + "</li>"; }).join("") + "</ul>" : "");

  return head + employment + payCard + emergency + docs + history;
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
  if (ds.ppF) ppl.draft[ds.ppF] = e.target.value;
  else if (ds.ppEm) ppl.draft.emergency[ds.ppEm] = e.target.value;
});
document.addEventListener("change", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (ds.ppF && ppl.draft) ppl.draft[ds.ppF] = t.value;
  else if ("ppFiles" in ds) { ppUpload(t.files); t.value = ""; }
});
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-pp-open],[data-pp-back],[data-pp-save],[data-pp-reset],[data-pp-bonus],[data-pp-rmbonus],[data-pp-attach],[data-pp-dl],[data-pp-rmfile]");
  if (!t || !$("#view").contains(t)) return;
  var ds = t.dataset, d = ppl.person;
  if (ds.ppOpen) { ppl.sel = ds.ppOpen; ppl.person = null; ppl.draft = null; ppl.personError = ""; render(); window.scrollTo(0, 0); }
  else if ("ppBack" in ds) { ppl.sel = ""; ppl.person = null; ppl.draft = null; ppl.at = 0; render(); }
  else if ("ppReset" in ds && d) { ppl.draft = ppDraftOf(d); render(); }
  else if ("ppSave" in ds && d) {
    var x = ppl.draft, body = { emergency: x.emergency, notes: x.notes };
    PP_FIELDS.forEach(function (f) { body[f[0]] = x[f[0]]; });
    if (!ppSelf(d)) { body.basePay = x.basePay; body.currency = x.currency; body.entity = x.entity; }
    ppl.saving = true; render();
    api(ppBase(), { method: "PUT", body: JSON.stringify(body) })
      .then(function (r) { ppl.draft = null; toast(r.changed.length ? "Saved: " + r.changed.join(", ") + "." : "No changes to save."); }, function (err) { toast(err.message, true); })
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
  else if ("ppAttach" in ds) { var inp = $("#view").querySelector("[data-pp-files]"); if (inp) inp.click(); }
  else if (ds.ppDl && d) {
    var meta = d.files.filter(function (f) { return f.id === ds.ppDl; })[0];
    fetch(ppBase() + "/files/" + encodeURIComponent(ds.ppDl), { headers: { Authorization: "Bearer " + token() } })
      .then(function (r) { if (!r.ok) throw new Error("Couldn't download that file"); return r.blob(); })
      .then(function (b) { var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = meta ? meta.name : "file"; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }, function (err) { toast(err.message, true); });
  }
  else if (ds.ppRmfile) {
    if (!confirm("Remove this document? It's deleted from storage.")) return;
    api(ppBase() + "/files/" + encodeURIComponent(ds.ppRmfile), { method: "DELETE" })
      .then(function () { toast("Removed."); }, function (err) { toast(err.message, true); }).then(ppReload);
  }
});

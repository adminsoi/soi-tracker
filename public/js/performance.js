"use strict";
// Performance escalation tracker.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- Performance ----
// HR's Global Performance Management Escalation Process as a quick view for
// the CEO and Leadership (PerformYard stays the system of record). Only for
// logins with "Performance access" — the server checks. It never decides
// anything: it counts notes, shows when a review is due, and reminds you of
// each country's process and when HR / legal must review.
var perf = { list: null, at: 0, loading: false, error: "", sel: "", person: null, personAt: 0, personLoading: "",
  composing: false, form: {}, editing: "", stepping: false, step: {}, adding: false, addForm: {}, saving: false };
var perfFlagged = 0, perfPending = [], perfStepPending = [];
var perfInitials = false;
try { perfInitials = localStorage.getItem("soi_perf_initials") === "1"; } catch (e) {}
var PERF_ORDER = ["verbal", "written", "pip", "pip_review"];
var PERF_SHORT = { none: "No step", verbal: "Verbal", written: "Written", pip: "PIP", pip_review: "PIP review" };
var ENTITY_LABEL = { SOI: "SOI Aviation · California, US", CAS: "CAS · New Zealand", RedSun: "Red Sun Aviation · Singapore", NanoTech: "Nanotech Aviation · UK" };
// From HR's process document — reminders, not legal advice.
var JURIS = {
  SOI: [["Legal baseline", "At-will, but discipline must not be discriminatory or retaliatory (FEHA, Labor Code 1102.5, CFRA/FMLA)."],
    ["Process", "Lower legal formality — consistency and documentation are key."],
    ["Representation", "None required (except as per policy)."],
    ["Employee access", "Personnel file and records access (Labor Code 1198.5); notes are discoverable."],
    ["Claim exposure", "Civil claims, DLSE and agency complaints."]],
  CAS: [["Legal baseline", "Employment Relations Act 2000: good-faith duty and the “fair and reasonable employer” test (s103A)."],
    ["Process", "High: tell the employee the concerns, give them a chance to respond, and genuinely consider the response."],
    ["Representation", "Tell them they can seek advice and bring a support person."],
    ["Employee access", "Privacy Act 2020 requests."],
    ["Claim exposure", "Personal grievance (raised within 90 days). Proposed law changes — confirm with local counsel."]],
  RedSun: [["Legal baseline", "Employment Act, contract terms, TAFEP and the Tripartite Guidelines on wrongful dismissal."],
    ["Process", "Moderate to high: warn the employee and give a fair chance to improve."],
    ["Representation", "Not statutory, but good practice."],
    ["Employee access", "PDPA access requests."],
    ["Claim exposure", "TADM / ECT claims. Workplace Fairness legislation may affect this — confirm with local counsel."]],
  NanoTech: [["Legal baseline", "ERA 1996, Equality Act 2010, ACAS Code of Practice."],
    ["Process", "High: capability procedure with a meeting, notice and appeal."],
    ["Representation", "Statutory right to be accompanied at formal meetings."],
    ["Employee access", "UK GDPR subject access requests."],
    ["Claim exposure", "Employment tribunal, possible 25% ACAS uplift for unreasonable non-compliance. Service length matters (2 years today; expected to change around January 2027 — confirm with UK counsel)."]]
};
var PERF_RISK_LABEL = { leave: "Protected leave", medical: "Medical or disability issue", complaint: "Recent complaint or whistleblowing", grievance: "Grievance raised",
  parental: "Pregnancy or parental status", service: "Length of service (check thresholds)", claims: "Pending claim" };
// Words that read as opinion or emotion rather than fact (notes are discoverable).
var EMOTIVE = /\b(lazy|attitude|terrible|awful|horrible|useless|incompetent|stupid|idiot\w*|ridiculous|pathetic|disgusting|careless|sloppy|clueless|hopeless|dramatic|crazy|insane|annoying|rude|arrogant|worst|bad|always|never|constantly|every time|hate|obviously|clearly|i feel|i think|seems|probably|unacceptable|disrespectful|toxic|liar|lying)\b/gi;
function wordingFlags(text) {
  var seen = {}, out = [];
  String(text || "").replace(EMOTIVE, function (m) { var k = m.toLowerCase(); if (!seen[k]) { seen[k] = 1; out.push(m); } return m; });
  return out;
}
function initialsOf(name) {
  var parts = String(name || "").replace(/[._@-]+/g, " ").trim().split(/\s+/);
  if (parts.length === 1 && parts[0].length <= 4) return parts[0].toUpperCase();
  return parts.map(function (w) { return w.charAt(0).toUpperCase(); }).join("");
}
function perfName(p) { return perfInitials ? (p.employeeId || initialsOf(p.name)) : p.name + (p.employeeId ? " · " + p.employeeId : ""); }
function loadPerf() {
  if (perf.loading) return;
  perf.loading = true;
  api("/api/performance").then(function (d) {
    perf.list = d; perf.error = "";
    var n = d.people.filter(function (p) { return p.reviewDue; }).length;
    if (n !== perfFlagged) { perfFlagged = n; renderNav(); }
  }, function (err) { perf.error = err.message; }).then(function () { perf.loading = false; perf.at = Date.now(); if (perfOnScreen()) requestRender(); });
}
function loadPerfPerson(key) {
  if (perf.personLoading === key) return;
  perf.personLoading = key;
  api("/api/performance/" + encodeURIComponent(key)).then(function (d) { if (perf.sel === key) { perf.person = d; perf.personAt = Date.now(); requestRender(); } }, function (err) { toast(err.message, true); })
    .then(function () { perf.personLoading = ""; });
}
function stageBadge(stage) { return '<span class="tier tier-' + Math.min(PERF_ORDER.indexOf(stage) + 1, 3) + '">' + E(PERF_SHORT[stage] || stage) + "</span>"; }
function ladder(stage) {
  var at = PERF_ORDER.indexOf(stage);
  return '<span class="ladder">' + PERF_ORDER.map(function (s, i) { return '<span class="rung' + (i <= at ? " on" : "") + '">' + E(PERF_SHORT[s]) + "</span>"; }).join("") +
    '<span class="rung end" title="Never a step here — always HR and legal review">Termination: HR + legal only</span></span>';
}
function noteState(e, d) {
  if (e.legacyWarning && !e.reviewed) return ["review", "From the old version — check the details"];
  if (e.misconduct) return ["mis", "Serious misconduct — separate process, not counted"];
  if (!e.told) return ["no", "Not discussed with the employee — doesn't count yet"];
  if (e.incidentDate < d.windowStart) return ["old", "Outside the " + d.settings.windowMonths + "-month window"];
  if (d.stageDate && e.incidentDate <= d.stageDate) return ["old", "Before the last step"];
  return ["yes", "Counts toward the next step"];
}
// Shown on its own page, or embedded on HR → Department-Facing.
function perfOnScreen() {
  return page === "performance" || (page === "departments" && activeDept === "HR" && adminFace.HR !== "staff" && subView.HR === "performance");
}
function renderPerformance(embedded) {
  if (!embedded) setBreadcrumb(["Tools", "Performance"]);
  if (!perf.list || Date.now() - perf.at > 60000) loadPerf();
  var head = embedded ? '<p class="small-note" style="margin:16px 0;">Private. HR\'s escalation process at a glance; PerformYard is the system of record. Every step is a person\'s decision, and anything beyond the PIP review needs HR and legal.</p>' : '<div class="intro"><div><div class="eyebrow">Tools · private</div><h1>Performance</h1>' +
    "<p>HR's escalation process at a glance. PerformYard is the system of record. Notes only count once the employee has been told; reaching a count means a <b>review</b> is due — every step is a person's decision, and anything beyond the PIP review needs HR and legal.</p></div></div>";
  if (perf.error) return head + '<div class="banner">' + E(perf.error) + "</div>";
  if (!perf.list) return head + '<div class="empty">Loading…</div>';
  var L = perf.list, people = L.people;
  if (perf.sel && !people.some(function (p) { return p.key === perf.sel; })) perf.sel = "";
  if (perf.sel && (!perf.person || perf.person.key !== perf.sel || Date.now() - perf.personAt > 60000)) loadPerfPerson(perf.sel);
  var due = people.filter(function (p) { return p.reviewDue; });
  var alerts = due.length ? '<div class="perf-alerts"><b>Review due</b>' + due.map(function (p) {
    return '<button type="button" class="perf-alert" data-perf-sel="' + E(p.key) + '">' + stageBadge(p.next || p.stage) + E(perfName(p)) + " · " +
      (p.next === "pip_review" ? "PIP outcome review" : E(p.nextLabel) + " (" + p.countable + " of " + p.threshold + " notes)") + (p.needsHrReview ? " · ⚠ HR/legal" : "") + "</button>";
  }).join("") + "</div>" : "";
  var flags = function (p) {
    var f = [];
    if (p.needsHrReview) f.push('<span class="flag risk" title="' + E(p.risks.map(function (r) { return PERF_RISK_LABEL[r]; }).join(", ")) + '">⚠ Risk factors</span>');
    if (p.notTold) f.push('<span class="flag">' + p.notTold + " not discussed</span>");
    if (p.misconduct) f.push('<span class="flag risk">Misconduct ×' + p.misconduct + "</span>");
    if (p.notInPerformYard) f.push('<span class="flag">' + p.notInPerformYard + " not in PerformYard</span>");
    if (p.legacy) f.push('<span class="flag">' + p.legacy + " to check</span>");
    return f.join(" ") || '<span class="dim">—</span>';
  };
  var cards = people.length ? people.map(function (p) {
    var open = p.key === perf.sel;
    return '<div class="pcard' + (open ? " open" : "") + (p.reviewDue ? " due" : "") + '"><button type="button" class="pcard-head" data-perf-sel="' + E(p.key) + '" aria-expanded="' + open + '">' +
      '<span class="pc-name"><b>' + E(perfName(p)) + "</b>" + (p.login ? "" : ' <span class="small-note">no login</span>') + '<span class="small-note">' + E(p.entity) + "</span></span>" +
      '<span class="pc-stage">' + stageBadge(p.stage) + (p.stageDate ? ' <span class="small-note">' + E(fmtDate(p.stageDate)) + "</span>" : "") + "</span>" +
      '<span class="pc-count">' + (p.threshold != null ? '<b style="' + (p.reviewDue ? "color:#9b2c28" : "") + '">' + p.countable + "</b> of " + p.threshold + " notes" : p.afterLadder ? "" : "") + "</span>" +
      '<span class="pc-next">' + (p.reviewDue ? '<b style="color:#9b2c28">Review: ' + E(p.next === "pip_review" ? "PIP outcome" : p.nextLabel) + "</b>" : p.afterLadder ? "HR + legal" : "Next: " + E(p.nextLabel || "—")) + "</span>" +
      '<span class="pc-flags">' + flags(p) + '</span><span class="pc-chev" aria-hidden="true">' + (open ? "▴" : "▾") + "</span></button>" +
      (open ? '<div class="pcard-body">' + renderPerfPerson() + "</div>" : "") + "</div>";
  }).join("") : '<div class="empty">Nobody yet. Add someone — with or without a tracker login.</div>';
  var add = perf.adding
    ? '<div class="card" style="margin:12px 0;padding:16px 18px;"><div class="card-label">Add a person</div><div class="grid-2" style="gap:0 16px;">' +
        '<div class="nb-field"><label for="pa-login">Someone with a tracker login</label><select id="pa-login" data-pa="username"><option value="">—</option>' + L.others.map(function (u) { return '<option value="' + E(u) + '">' + E(u) + "</option>"; }).join("") + "</select></div>" +
        '<div class="nb-field"><label for="pa-name">…or without one: name, initials or employee ID</label><input id="pa-name" data-pa="name" placeholder="e.g. J.R. or EMP-1042" autocomplete="off"></div>' +
        '<div class="nb-field"><label for="pa-entity">Entity</label><select id="pa-entity" data-pa="entity">' + Object.keys(ENTITY_LABEL).map(function (k) { return '<option value="' + k + '">' + E(ENTITY_LABEL[k]) + "</option>"; }).join("") + "</select></div></div>" +
        '<div class="nb-foot"><button type="button" class="primary" data-perf-addsave>Add</button><button type="button" class="text-button" data-perf-addcancel>Cancel</button></div></div>'
    : "";
  var tools = '<div class="table-toolbar"><label class="small-note" style="display:flex;gap:6px;align-items:center;cursor:pointer;"><input type="checkbox" class="check" id="perfInitials"' + (perfInitials ? " checked" : "") + "> Show initials / IDs only</label>" +
    '<span class="small-note">Notes live for ' + L.settings.windowMonths + " months · " + L.settings.verbal + " → verbal review, +" + L.settings.written + " → written, +" + L.settings.pip + " → PIP (set in /admin.html)</span>" +
    '<span class="grow" style="flex:1"></span><button type="button" class="primary" data-perf-add>+ Add a person</button></div>';
  return head + alerts + tools + add + '<div class="pcards">' + cards + "</div>";
}
function renderPerfPerson() {
  var d = perf.person;
  if (!d || d.key !== perf.sel) return '<div class="nb-empty">Loading…</div>';
  var filesFor = function (id) { return d.files.filter(function (f) { return (f.entryId || "") === id; }); };
  var fileChip = function (f) {
    return '<span class="perf-file">📎 <button type="button" data-perf-dl="' + E(f.id) + '" title="Download">' + E(f.name) + "</button>" +
      '<span class="small-note">' + Math.max(1, Math.round(f.size / 1024)) + ' KB</span><button type="button" data-perf-rmfile="' + E(f.id) + '" title="Remove" aria-label="Remove attachment">✕</button></span>';
  };
  var attachRow = function (id, label) {
    var fs = filesFor(id);
    return '<div class="perf-files">' + fs.map(fileChip).join("") +
      '<input type="file" data-perf-entryfiles="' + E(id) + '" multiple hidden><button type="button" class="text-button" data-perf-attach="' + E(id) + '">📎 ' + E(label || "Attach") + "</button></div>";
  };
  var status = d.afterLadder
    ? "The ladder is complete. Any further action — including termination — needs HR and legal review before anything happens."
    : d.next === "pip_review"
      ? "On a PIP since " + fmtDate(d.stageDate) + ". Next: a documented PIP outcome review."
      : d.countable + " of " + d.threshold + " countable note" + (d.threshold === 1 ? "" : "s") + (d.stageDate ? " since the " + PERF_SHORT[d.stage].toLowerCase() + " on " + fmtDate(d.stageDate) : " in the last " + d.settings.windowMonths + " months") +
        (d.reviewDue ? " — <b>review due for a " + E(d.nextLabel.toLowerCase()) + "</b>." : ".");
  var warn = [];
  if (d.needsHrReview) warn.push("<b>Risk factors are ticked</b> (" + E(d.risks.map(function (r) { return PERF_RISK_LABEL[r]; }).join(", ")) + ") — HR / legal must review before any escalation.");
  if (d.notTold) warn.push(d.notTold + " note" + (d.notTold === 1 ? " hasn't" : "s haven't") + " been discussed with the employee yet, so " + (d.notTold === 1 ? "it doesn't" : "they don't") + " count. Have a brief informal conversation first.");
  if (d.misconduct) warn.push("Serious misconduct is noted — handle it under the separate misconduct and disciplinary process, not by counting notes.");
  if (d.legacy) warn.push(d.legacy + " note" + (d.legacy === 1 ? " is" : "s are") + " from the earlier version — check the dates and whether the employee was told.");
  var jur = '<div class="juris"><div class="card-label">' + E(ENTITY_LABEL[d.entity]) + " — from HR's process (reminders, not legal advice)</div>" +
    (JURIS[d.entity] || []).map(function (r) { return "<div><b>" + E(r[0]) + ":</b> " + E(r[1]) + "</div>"; }).join("") + "</div>";

  // One card per rung of the ladder.
  var live = d.steps.filter(function (s) { return !s.undone; });
  var byStage = {}; live.forEach(function (s) { if (!byStage[s.stage] || String(s.date) > String(byStage[s.stage].date)) byStage[s.stage] = s; });
  var latest = live.slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || (b.at || 0) - (a.at || 0); })[0];
  var STEP_NAME = { verbal: "Verbal warning", written: "Written warning", pip: "Performance Improvement Plan (PIP)", pip_review: "PIP outcome review" };
  var STEP_HINT = { verbal: "Attach the meeting notes or the verbal warning script once it's done.", written: "Attach the signed written warning and the employee's acknowledgment.",
    pip: "Attach the PIP document, goals and review dates.", pip_review: "Attach the documented outcome of the PIP." };
  var stepCards = PERF_ORDER.map(function (stage) {
    var st = byStage[stage];
    if (st) {
      return '<details class="qa step-card done"' + (st === latest ? " open" : "") + '><summary><span class="step-dot on">✓</span>' + E(STEP_NAME[stage]) +
        ' <span class="small-note" style="font-weight:400;">' + E(fmtDate(st.date)) + " · " + E(st.by) + "</span>" +
        (st.hrReviewed ? ' <span class="flag">HR/legal reviewed</span>' : "") + (filesFor(st.id).length ? ' <span class="flag">📎 ' + filesFor(st.id).length + "</span>" : "") + "</summary>" +
        '<div class="qa-body"><div class="nb-field"><label>Description</label><textarea rows="3" data-perf-stepdesc="' + E(st.id) + '">' + E(st.reason) + "</textarea></div>" +
        '<div class="card-label">Attachments</div>' + attachRow(st.id, "Attach " + (stage === "written" ? "the written warning" : "a file")) +
        '<p class="small-note" style="margin:6px 0 0;">' + E(STEP_HINT[stage]) + "</p>" +
        '<div class="nb-foot"><label class="small-note"><input type="checkbox" class="check" data-perf-steppy="' + E(st.id) + '"' + (st.inPerformYard ? " checked" : "") + "> Recorded in PerformYard</label>" +
        '<span class="grow"></span>' + (st === latest ? '<button type="button" class="text-button" data-perf-undo="' + E(st.id) + '">Undo this step</button>' : "") + "</div></div></details>";
    }
    if (stage === d.next) {
      var s = perf.step;
      var pending = perfStepPending.length ? '<span class="small-note">' + E(perfStepPending.map(function (f) { return f.name; }).join(", ")) + "</span>" : "";
      return '<details class="qa step-card next" open><summary><span class="step-dot next">' + (PERF_ORDER.indexOf(stage) + 1) + "</span>Next: " + E(STEP_NAME[stage]) +
        (d.reviewDue ? ' <span class="flag risk">Review due</span>' : stage !== "pip_review" ? ' <span class="small-note" style="font-weight:400;">' + d.countable + " of " + d.threshold + " notes</span>" : "") + "</summary>" +
        '<div class="qa-body">' +
        (d.needsHrReview ? '<div class="banner" style="margin:0 0 10px;">⚠ Risk factors are ticked — confirm HR / legal have reviewed this before recording it.</div>' : "") +
        (!d.reviewDue && stage !== "pip_review" ? '<p class="small-note" style="margin:0 0 10px;">Not due yet. A count is a guide, not a trigger — only record this if the facts support it on their own.</p>' : "") +
        jur +
        '<div class="grid-2" style="gap:0 16px;margin-top:10px;"><div class="nb-field"><label for="ps-date">Date</label><input id="ps-date" type="date" data-ps="date" value="' + E(s.date || perf.list.today) + '"></div></div>' +
        '<div class="nb-field"><label for="ps-reason">Description — which notes it\'s based on, what was discussed, what was agreed</label><textarea id="ps-reason" rows="4" data-ps="reason">' + E(s.reason || "") + "</textarea></div>" +
        '<div class="nb-foot" style="margin-top:0;"><input type="file" id="perfStepFiles" multiple hidden><button type="button" data-perf-stepfiles>📎 Attach ' + (stage === "written" ? "the written warning" : "files") + "</button>" + pending + "</div>" +
        '<div class="risk-grid" style="margin-top:10px;"><label><input type="checkbox" class="check" data-ps-flag="hrReviewed"' + (s.hrReviewed ? " checked" : "") + "> HR / legal have reviewed this" + (d.needsHrReview ? " (required)" : "") + "</label>" +
        '<label><input type="checkbox" class="check" data-ps-flag="inPerformYard"' + (s.inPerformYard ? " checked" : "") + "> Recorded in PerformYard</label></div>" +
        '<div class="nb-foot"><span class="grow"></span><button type="button" class="primary" data-perf-savestep>Record ' + E(STEP_NAME[stage].replace(/ \\(PIP\\)$/, "").toLowerCase()) + "</button></div></div></details>";
    }
    return '<div class="qa step-card later"><div class="step-later"><span class="step-dot">' + (PERF_ORDER.indexOf(stage) + 1) + "</span>" + E(STEP_NAME[stage]) + ' <span class="small-note" style="font-weight:400;">not yet</span></div></div>';
  }).join("") +
    '<div class="qa step-card later"><div class="step-later"><span class="step-dot">⚖</span>Termination <span class="small-note" style="font-weight:400;">never a step here — always HR and legal review first</span></div></div>';
  var undone = d.steps.filter(function (s) { return s.undone; });
  var undoneHtml = undone.length ? '<p class="small-note" style="margin:6px 0 0;">Undone: ' + undone.map(function (s) {
    return E(PERF_SHORT[s.stage]) + " " + E(fmtDate(s.date)) + " (" + E(s.undone.by) + (s.undone.reason ? ": " + E(s.undone.reason) : "") + ")"; }).join(" · ") + "</p>" : "";

  var composer = "";
  if (perf.composing || perf.editing) {
    var f = perf.form, words = wordingFlags(f.text);
    composer = '<div class="card" style="margin:10px 0;padding:16px 18px;"><div class="card-label">' + (perf.editing ? "Edit note" : "New note") + "</div>" +
      '<div class="grid-2" style="gap:0 16px;"><div class="nb-field"><label for="pn-inc">Date of incident</label><input id="pn-inc" type="date" data-pn="incidentDate" value="' + E(f.incidentDate || "") + '" max="' + E(perf.list.today) + '"></div>' +
      '<div class="nb-field"><label for="pn-rec">Date note received</label><input id="pn-rec" type="date" data-pn="receivedDate" value="' + E(f.receivedDate || "") + '"></div></div>' +
      '<div class="nb-field"><label for="pn-from">From (optional)</label><input id="pn-from" data-pn="from" value="' + E(f.from || "") + '" placeholder="e.g. Email from Greg" autocomplete="off"></div>' +
      '<div class="nb-field"><label for="pn-text">What happened — facts only</label><textarea id="pn-text" rows="4" data-pn="text" placeholder="Date, what was observed, the specific impact. No opinions or labels — notes are discoverable.">' + E(f.text || "") + "</textarea>" +
      '<div class="small-note" id="pn-words" style="color:#8a5a14;">' + (words.length ? "Check wording: <b>" + E(words.join(", ")) + "</b> reads as opinion or emotion — describe what was seen or said instead." : "") + "</div></div>" +
      '<div class="risk-grid"><label><input type="checkbox" class="check" data-pn-flag="told"' + (f.told ? " checked" : "") + "> Employee was told about this</label>" +
      (f.told ? '<label>on <input type="date" data-pn="toldDate" value="' + E(f.toldDate || "") + '" class="att-time" style="width:140px;"></label>' : "") +
      '<label><input type="checkbox" class="check" data-pn-flag="inPerformYard"' + (f.inPerformYard ? " checked" : "") + "> Entered in PerformYard</label>" +
      '<label><input type="checkbox" class="check" data-pn-flag="misconduct"' + (f.misconduct ? " checked" : "") + "> Serious misconduct (safety, harassment, theft, threats)</label></div>" +
      (f.misconduct ? '<p class="small-note" style="color:#9b2c28;margin:6px 0 0;">Serious misconduct goes through the separate misconduct and disciplinary process. It\'s recorded here but never counted.</p>' : "") +
      '<div class="nb-foot"><input type="file" id="perfComposeFiles" multiple hidden>' + (perf.editing ? "" : '<button type="button" data-perf-composefiles>📎 Attach files</button><span class="small-note" id="perfComposeNames">' + E(perfPending.map(function (x) { return x.name; }).join(", ")) + "</span>") +
      '<span class="grow"></span><button type="button" class="text-button" data-perf-cancel>Cancel</button><button type="button" class="primary" data-perf-savenote' + (perf.saving ? " disabled" : "") + ">" + (perf.saving ? "Saving…" : perf.editing ? "Save" : "Add note") + "</button></div></div>";
  }
  var notes = d.entries.length ? d.entries.map(function (e) {
    var ns = noteState(e, d);
    return '<div class="perf-entry note-' + ns[0] + '"><div class="meta"><span class="nstate ' + ns[0] + '">' + E(ns[1]) + "</span><span>Incident " + E(fmtDate(e.incidentDate)) + " · received " + E(fmtDate(e.receivedDate)) + (e.from ? " · " + E(e.from) : "") + " · logged by " + E(e.by) + "</span>" +
      (e.editedAt ? "<span>(edited)</span>" : "") + '<span class="grow" style="flex:1"></span>' +
      '<label class="small-note"><input type="checkbox" class="check" data-perf-flag="told" data-id="' + E(e.id) + '"' + (e.told ? " checked" : "") + "> Told" + (e.told && e.toldDate ? " " + E(fmtDate(e.toldDate)) : "") + "</label>" +
      '<label class="small-note"><input type="checkbox" class="check" data-perf-flag="inPerformYard" data-id="' + E(e.id) + '"' + (e.inPerformYard ? " checked" : "") + "> PerformYard</label>" +
      '<button type="button" class="text-button" data-perf-edit="' + E(e.id) + '">Edit</button><button type="button" class="text-button" data-perf-del="' + E(e.id) + '">Delete</button></div>' +
      '<div class="txt">' + E(e.text) + "</div>" + attachRow(e.id) + "</div>";
  }).join("") : '<div class="small-note" style="padding:6px 0;">No notes yet.</div>';
  var risk = '<details class="qa" style="margin:12px 0 0;"' + (d.needsHrReview ? " open" : "") + '><summary>Profile and risk factors' + (d.needsHrReview ? ' <span class="flag risk">⚠ ' + d.risks.length + "</span>" : "") + '</summary><div class="qa-body">' +
    '<div class="grid-2" style="gap:0 16px;">' +
      (d.login ? "" : '<div class="nb-field"><label for="pp-name">Name / initials</label><input id="pp-name" data-pp="name" value="' + E(d.name) + '"></div>') +
      '<div class="nb-field"><label for="pp-entity">Entity</label><select id="pp-entity" data-pp="entity">' + Object.keys(ENTITY_LABEL).map(function (k) { return '<option value="' + k + '"' + (d.entity === k ? " selected" : "") + ">" + E(ENTITY_LABEL[k]) + "</option>"; }).join("") + "</select></div>" +
      '<div class="nb-field"><label for="pp-id">Employee ID or initials</label><input id="pp-id" data-pp="employeeId" value="' + E(d.employeeId) + '" placeholder="Used when “initials only” is on"></div>' +
      '<div class="nb-field"><label for="pp-start">Start date (length of service)</label><input id="pp-start" type="date" data-pp="startDate" value="' + E(d.startDate) + '"></div></div>' +
    '<div class="card-label" style="margin-top:6px;">Check before any escalation</div><div class="risk-grid">' + Object.keys(PERF_RISK_LABEL).map(function (r) {
      return '<label><input type="checkbox" class="check" data-pp-risk="' + r + '"' + (d.risk[r] ? " checked" : "") + "> " + E(PERF_RISK_LABEL[r]) + "</label>";
    }).join("") + "</div>" +
    '<div class="nb-field" style="margin-top:10px;"><label for="pp-rn">Risk notes</label><textarea id="pp-rn" rows="2" data-pp="riskNotes" placeholder="Context for HR / legal">' + E(d.riskNotes) + "</textarea></div></div></details>";

  return '<div class="nb-sub" style="margin-bottom:6px;">' + E(ENTITY_LABEL[d.entity]) + (d.departments.length ? " · " + E(d.departments.join(", ")) : "") + (d.startDate ? " · started " + E(fmtDate(d.startDate)) : "") + (d.login ? "" : " · no tracker login") + "</div>" +
    '<p style="margin:0 0 6px;">' + status + "</p>" +
    warn.map(function (w) { return '<div class="banner" style="margin:6px 0;">' + w + "</div>"; }).join("") +
    '<div class="nb-field" style="margin-top:12px;"><label for="pp-sum">Description</label><textarea id="pp-sum" rows="3" data-pp="summary" placeholder="Overview for Leadership: the situation, what support has been offered, current plan.">' + E(d.summary || "") + "</textarea></div>" +
    '<div class="card-label">Files</div>' + attachRow("", "Attach a file") +
    '<div class="card-label" style="margin-top:16px;">Steps</div>' + stepCards + undoneHtml +
    '<div style="display:flex;align-items:center;gap:10px;margin-top:18px;"><div class="card-label" style="margin:0;">Notes</div><span class="grow" style="flex:1"></span>' +
      '<button type="button" class="primary" data-perf-compose>+ Add note</button><button type="button" data-perf-print title="For a records request, or to share with HR — choose Save as PDF">Download record</button>' +
      (d.auto ? "" : '<button type="button" class="text-button" data-perf-remove>Take off the list</button>') + "</div>" +
    composer + notes + risk;
}
function perfPrint(d) {
  var box = $("#nbPrint");
  if (!box) { box = document.createElement("div"); box.id = "nbPrint"; document.body.appendChild(box); }
  var row = function (cells) { return "<tr>" + cells.map(function (c) { return '<td style="border:1px solid #ccc;padding:4pt 6pt;vertical-align:top;">' + c + "</td>"; }).join("") + "</tr>"; };
  var th = function (cells) { return "<tr>" + cells.map(function (c) { return '<th style="border:1px solid #ccc;padding:4pt 6pt;text-align:left;font:700 8.5pt Arial;">' + c + "</th>"; }).join("") + "</tr>"; };
  box.innerHTML = '<div class="pk">CONFIDENTIAL · PERFORMANCE RECORD</div><h1>' + E(perfName(d)) + '</h1><div class="pm">' + E(ENTITY_LABEL[d.entity]) + " · Current stage: " + E(d.stageLabel) + (d.stageDate ? " (" + E(fmtDate(d.stageDate)) + ")" : "") + " · Printed " + E(new Date().toLocaleDateString()) + "</div>" +
    (d.summary ? "<h4>Description</h4><p>" + E(d.summary) + "</p>" : "") +
    "<h4>Steps</h4>" + (d.steps.length ? '<table style="border-collapse:collapse;width:100%;font:9.5pt Arial;">' + th(["Date", "Step", "Reason", "HR/legal", "By"]) + d.steps.map(function (s) {
      return row([E(fmtDate(s.date)), E((s.undone ? "Undone — " : "") + PERF_SHORT[s.stage]), E(s.reason), s.hrReviewed ? "Yes" : "No", E(s.by)]); }).join("") + "</table>" : "<p>None.</p>") +
    "<h4>Notes</h4>" + (d.entries.length ? '<table style="border-collapse:collapse;width:100%;font:9.5pt Arial;">' + th(["Incident", "Received", "Description", "Told", "PerformYard", "Status"]) + d.entries.map(function (e) {
      return row([E(fmtDate(e.incidentDate)), E(fmtDate(e.receivedDate)), E(e.text), e.told ? "Yes" + (e.toldDate ? " (" + E(fmtDate(e.toldDate)) + ")" : "") : "No", e.inPerformYard ? "Yes" : "No", E(noteState(e, d)[1])]); }).join("") + "</table>" : "<p>None.</p>") +
    '<div class="pf">Quick-view summary from the AOG Tracker. PerformYard is the system of record. Not a compliance determination.</div>';
  var oldTitle = document.title;
  document.title = ("Performance record " + perfName(d)).replace(/[\\/:*?"<>|]+/g, " ");
  document.body.classList.add("nb-printing");
  var done = function () { document.body.classList.remove("nb-printing"); document.title = oldTitle; window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
  setTimeout(done, 1000);
}
function perfUpload(files, entryId) {
  var key = perf.sel, list = Array.prototype.slice.call(files || []);
  if (!list.length) return Promise.resolve();
  toast("Uploading " + list.length + " file" + (list.length === 1 ? "" : "s") + "…");
  return list.reduce(function (p, f) {
    return p.then(function () {
      return fetch("/api/performance/" + encodeURIComponent(key) + "/files?name=" + encodeURIComponent(f.name) + "&entryId=" + encodeURIComponent(entryId || ""),
        { method: "POST", headers: { Authorization: "Bearer " + token(), "Content-Type": "application/octet-stream" }, body: f })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(f.name + ": " + (d.error || "upload failed")); }); });
    });
  }, Promise.resolve()).then(function () { toast("Attached."); }, function (err) { toast(err.message, true); })
    .then(function () { perf.personAt = 0; loadPerfPerson(key); });
}
function perfReload() { perf.at = 0; perf.personAt = 0; loadPerf(); if (perf.sel) loadPerfPerson(perf.sel); render(); }
function perfBase() { return "/api/performance/" + encodeURIComponent(perf.sel || ""); }
document.addEventListener("input", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (ds.pn) { perf.form[ds.pn] = t.value; if (ds.pn === "text") { var w = wordingFlags(t.value), el = $("#pn-words"); if (el) el.innerHTML = w.length ? "Check wording: <b>" + E(w.join(", ")) + "</b> reads as opinion or emotion — describe what was seen or said instead." : ""; } }
  else if (ds.ps) perf.step[ds.ps] = t.value;
  else if (ds.pa) perf.addForm[ds.pa] = t.value;
});
document.addEventListener("change", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (t.id === "perfInitials") { perfInitials = t.checked; try { localStorage.setItem("soi_perf_initials", perfInitials ? "1" : "0"); } catch (x) {} render(); return; }
  if (ds.pa) { perf.addForm[ds.pa] = t.value; return; }
  if (ds.pn) { perf.form[ds.pn] = t.value; return; }
  if (ds.ps) { perf.step[ds.ps] = t.value; return; }
  if (ds.pnFlag) { perf.form[ds.pnFlag] = t.checked; if (ds.pnFlag === "told" && t.checked && !perf.form.toldDate) perf.form.toldDate = perf.list.today; render(); return; }
  if (ds.psFlag) { perf.step[ds.psFlag] = t.checked; return; }
  if (ds.pp || ds.ppRisk) {
    var body = {};
    if (ds.ppRisk) { body.risk = {}; body.risk[ds.ppRisk] = t.checked; } else body[ds.pp] = t.value;
    api(perfBase() + "/profile", { method: "PUT", body: JSON.stringify(body) }).then(function () { toast("Saved."); perfReload(); }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.perfFlag) {
    var ch = {}; ch[ds.perfFlag] = t.checked;
    if (ds.perfFlag === "told" && t.checked) ch.toldDate = perf.list.today;
    api(perfBase() + "/entries/" + encodeURIComponent(ds.id), { method: "PATCH", body: JSON.stringify(ch) }).then(function () { perfReload(); }, function (err) { toast(err.message, true); perfReload(); });
    return;
  }
  if (ds.perfStepdesc || ds.perfSteppy) {
    var sid = ds.perfStepdesc || ds.perfSteppy, chg = ds.perfStepdesc ? { reason: t.value } : { inPerformYard: t.checked };
    api(perfBase() + "/steps/" + encodeURIComponent(sid), { method: "PATCH", body: JSON.stringify(chg) }).then(function () { toast("Saved."); perfReload(); }, function (err) { toast(err.message, true); });
    return;
  }
  if (t.id === "perfStepFiles") { perfStepPending = Array.prototype.slice.call(t.files || []); t.value = ""; render(); return; }
  if (t.id === "perfLooseFiles") { perfUpload(t.files, ""); t.value = ""; }
  else if (ds.perfEntryfiles) { perfUpload(t.files, ds.perfEntryfiles); t.value = ""; }
  else if (t.id === "perfComposeFiles") {
    perfPending = Array.prototype.slice.call(t.files || []);
    var n = $("#perfComposeNames"); if (n) n.textContent = perfPending.map(function (f) { return f.name; }).join(", ");
  }
});
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-perf-stepfiles],[data-perf-sel],[data-perf-add],[data-perf-addsave],[data-perf-addcancel],[data-perf-compose],[data-perf-cancel],[data-perf-savenote],[data-perf-edit],[data-perf-del],[data-perf-step],[data-perf-savestep],[data-perf-undo],[data-perf-attach],[data-perf-loose],[data-perf-composefiles],[data-perf-dl],[data-perf-rmfile],[data-perf-remove],[data-perf-print]");
  if (!t) return;
  var ds = t.dataset, base = perfBase(), d = perf.person;
  var clearForms = function () { perf.composing = false; perf.editing = ""; perf.stepping = false; perf.form = {}; perfPending = []; };
  if (ds.perfSel) {
    var opening = perf.sel !== ds.perfSel;
    perf.sel = opening ? ds.perfSel : ""; perf.person = null; clearForms();
    perf.step = { date: perf.list.today }; perfStepPending = [];
    render();
    if (opening) { var c = document.querySelector('.pcard.open'); if (c) c.scrollIntoView({ block: "nearest" }); }
    return;
  }
  if ("perfAdd" in ds) { perf.adding = true; perf.addForm = { entity: "SOI" }; render(); return; }
  if ("perfAddcancel" in ds) { perf.adding = false; render(); return; }
  if ("perfAddsave" in ds) {
    var a = perf.addForm, body = a.username ? { username: a.username } : { name: a.name, entity: a.entity || "SOI" };
    if (!a.username && !String(a.name || "").trim()) { toast("Pick a login or type a name / initials.", true); return; }
    api("/api/performance/people", { method: "POST", body: JSON.stringify(body) }).then(function (r) { perf.adding = false; perf.sel = r.key; perf.person = null; perfReload(); }, function (err) { toast(err.message, true); });
    return;
  }
  if ("perfCompose" in ds) { clearForms(); perf.composing = true; perf.form = { incidentDate: perf.list.today, receivedDate: perf.list.today }; render(); var tx = $("#pn-text"); if (tx) tx.focus(); return; }
  if (ds.perfEdit) { var en = d.entries.filter(function (x) { return x.id === ds.perfEdit; })[0]; clearForms(); perf.editing = en.id; perf.form = { incidentDate: en.incidentDate, receivedDate: en.receivedDate, from: en.from, text: en.text, told: en.told, toldDate: en.toldDate, inPerformYard: en.inPerformYard, misconduct: en.misconduct }; render(); return; }
  if ("perfCancel" in ds) { clearForms(); render(); return; }
  if ("perfStep" in ds) { clearForms(); perf.stepping = true; perf.step = { date: perf.list.today }; render(); return; }
  if ("perfComposefiles" in ds) { $("#perfComposeFiles").click(); return; }
  if ("perfStepfiles" in ds) { $("#perfStepFiles").click(); return; }
  if ("perfLoose" in ds) { $("#perfLooseFiles").click(); return; }
  if (ds.perfAttach) { var fi = document.querySelector('[data-perf-entryfiles="' + ds.perfAttach + '"]'); if (fi) fi.click(); return; }
  if ("perfPrint" in ds) { if (d) perfPrint(d); return; }
  if ("perfSavenote" in ds) {
    var f = perf.form;
    if (!String(f.text || "").trim()) { toast("Describe what happened.", true); return; }
    var w = wordingFlags(f.text);
    if (w.length && !confirm("These words read as opinion or emotion: " + w.join(", ") + ". Notes are discoverable. Save anyway?")) return;
    var payload = { incidentDate: f.incidentDate, receivedDate: f.receivedDate, from: f.from || "", text: f.text, told: !!f.told, toldDate: f.told ? f.toldDate || "" : "", inPerformYard: !!f.inPerformYard, misconduct: !!f.misconduct };
    perf.saving = true; render();
    var req = perf.editing ? api(base + "/entries/" + encodeURIComponent(perf.editing), { method: "PATCH", body: JSON.stringify(payload) }) : api(base + "/entries", { method: "POST", body: JSON.stringify(payload) });
    req.then(function (entry) {
      var files = perf.editing ? [] : perfPending;
      perf.saving = false; clearForms();
      toast("Saved.");
      return perfUpload(files, entry.id);
    }, function (err) { perf.saving = false; toast(err.message, true); render(); }).then(perfReload);
    return;
  }
  if ("perfSavestep" in ds) {
    var s = perf.step;
    if (!String(s.reason || "").trim()) { toast("Say briefly why — which notes it's based on.", true); return; }
    if (d.needsHrReview && !s.hrReviewed) { toast("Risk factors are ticked — confirm HR / legal have reviewed this first.", true); return; }
    if (!confirm("Record a " + d.nextLabel.toLowerCase() + " for " + perfName(d) + " on " + fmtDate(s.date) + "?")) return;
    api(base + "/steps", { method: "POST", body: JSON.stringify({ stage: d.next, date: s.date, reason: s.reason, hrReviewed: !!s.hrReviewed, inPerformYard: !!s.inPerformYard }) })
      .then(function (step) {
        var files = perfStepPending; perfStepPending = []; clearForms(); perf.step = { date: perf.list.today };
        toast("Recorded." + (step.inPerformYard ? "" : " Remember to record it in PerformYard too."));
        return perfUpload(files, step.id);
      }, function (err) { toast(err.message, true); }).then(perfReload);
    return;
  }
  if (ds.perfUndo) {
    var why = prompt("Why is this step being undone? (kept with the record)");
    if (why === null) return;
    api(base + "/steps/" + encodeURIComponent(ds.perfUndo) + "/undo", { method: "POST", body: JSON.stringify({ reason: why }) }).then(function () { toast("Undone."); perfReload(); }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.perfDel) {
    if (!confirm("Delete this note and its attachments? (PerformYard is the system of record — delete there too if needed.)")) return;
    api(base + "/entries/" + encodeURIComponent(ds.perfDel), { method: "DELETE" }).then(function () { toast("Deleted."); perfReload(); }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.perfDl) {
    var meta = d.files.filter(function (x) { return x.id === ds.perfDl; })[0];
    fetch(base + "/files/" + encodeURIComponent(ds.perfDl), { headers: { Authorization: "Bearer " + token() } })
      .then(function (r) { if (!r.ok) throw new Error("Couldn't download that file"); return r.blob(); })
      .then(function (b) { var a2 = document.createElement("a"); a2.href = URL.createObjectURL(b); a2.download = meta ? meta.name : "file"; document.body.appendChild(a2); a2.click(); setTimeout(function () { URL.revokeObjectURL(a2.href); a2.remove(); }, 1000); },
            function (err) { toast(err.message, true); });
    return;
  }
  if (ds.perfRmfile) {
    if (!confirm("Remove this attachment?")) return;
    api(base + "/files/" + encodeURIComponent(ds.perfRmfile), { method: "DELETE" }).then(function () { toast("Removed."); perfReload(); }, function (err) { toast(err.message, true); });
    return;
  }
  if ("perfRemove" in ds) {
    if (!confirm("Take " + perfName(d) + " off the list? Their notes and steps are kept, and they come back if anything is added.")) return;
    api("/api/performance/people/" + encodeURIComponent(perf.sel), { method: "DELETE" }).then(function () { perf.sel = ""; perf.person = null; perfReload(); }, function (err) { toast(err.message, true); });
  }
});

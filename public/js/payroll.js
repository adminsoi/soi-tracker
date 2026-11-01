"use strict";
// HR → Payroll: approved leave per person per pay week, weekly base pay
// and one-off adjustments, by entity (US, NZ, Singapore, UK).
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- Payroll ----
// HR hasn't given the rules for how each kind of leave changes pay, so this
// never works out pay: it lines up the facts (base pay, approved leave,
// adjustments) and keeps a box per entity for HR's rules. A qualified
// person checks every figure before any real payroll is sent. HR,
// Leadership and full access see it (the server checks); HR managers edit.
var pay = { data: null, at: 0, loading: false, error: "", week: "", rules: "", ruleDraft: {}, acctDraft: {}, adding: false, add: {}, approving: "" };
var PAY_ENTITIES = ["SOI", "CAS", "RedSun", "NanoTech"];
function loadPayroll() {
  if (pay.loading) return;
  pay.loading = true;
  api("/api/payroll").then(function (d) { pay.data = d; pay.error = ""; }, function (err) { pay.error = err.message; })
    .then(function () { pay.loading = false; pay.at = Date.now(); requestRender(); });
}
// Pay weeks run Monday to Sunday.
function payMonday(ymd) { var d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); }
function payAddDays(ymd, n) { var d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// Leave days of one request that fall in the week. Counts weekdays; when
// the person changed the working days by hand (half days, holidays) and
// the leave spans more than this week, it's marked for checking.
function payLeaveDays(i, ws) {
  var f = i.fields || {}, we = payAddDays(ws, 6);
  if (!f.from || !f.to || f.to < ws || f.from > we) return null;
  var inWeek = sfWeekdays(f.from > ws ? f.from : ws, f.to < we ? f.to : we), total = sfWeekdays(f.from, f.to);
  if (f.days === total) return { days: inWeek, check: false };
  if (f.from >= ws && f.to <= we) return { days: f.days, check: false };
  return { days: inWeek, check: true };
}
function payPerson(d, username) { return d.people[username] || {}; }
function payEntityOf(d, login) { var p = payPerson(d, login.username); return PAY_ENTITIES.indexOf(p.entity) !== -1 ? p.entity : login.entity; }
function payApproval(d, ent, ws) { return ((d.approvals || {})[ent] || {})[ws] || null; }
// SOI (US) only: the Exempt flag HR or Leadership set on People.
function payExemptTag(v) {
  return v === true ? ' <span class="pill" title="Exempt (salaried, no overtime) — set by HR or Leadership on People">Exempt</span>'
    : v === false ? ' <span class="pill" title="Not exempt — set by HR or Leadership on People">Hourly</span>' : "";
}
// The figures as they were approved and sent (read-only; later edits don't change them).
function payApprovedTable(ap) {
  var sn = ap.snapshot, sums = function (o) { return Object.keys(o).map(function (c) { return E(sfAmount(o[c], c)); }).join(" + ") || "—"; };
  return '<div class="table-wrap"><table class="narrow"><thead><tr><th>Person</th><th>Weekly base pay</th><th>Approved leave this week (days)</th><th>Adjustments this week</th><th>Pay for the week</th></tr></thead><tbody>' +
    (sn.rows.length ? sn.rows.map(function (r) {
      return "<tr><td>" + E(r.person) + (sn.entity === "SOI" ? payExemptTag(r.exempt) : "") + "</td><td>" + (r.basePay == null ? '<span class="dim">Not entered</span>' : E(sfAmount(r.basePay, r.currency))) + "</td>" +
        "<td>" + (r.leave.length ? r.leave.map(function (x) { return E(x.type) + ": " + x.days + (x.check ? ' <span class="pill rose">check</span>' : ""); }).join("<br>") : '<span class="dim">—</span>') + "</td>" +
        "<td>" + (r.adjustments.length ? r.adjustments.map(function (a) { return E(sfAmount(a.amount, a.currency)) + ' <span class="small-note">' + E(a.reason) + (a.source === "spot-bonus" ? " · Spot bonus from " + E(a.by || "Leadership") : "") + "</span>"; }).join("<br>") : '<span class="dim">—</span>') + "</td>" +
        '<td><span class="small-note">Waiting for HR\'s leave rules</span></td></tr>';
    }).join("") : '<tr><td colspan="5" class="empty">Nobody on this entity had pay, leave or adjustments this week.</td></tr>') +
    '<tr class="pay-total"><td><b>Totals as sent</b></td><td><b>' + sums(sn.totals.basePay) + '</b> <span class="pill rose">needs a qualified check</span></td><td colspan="3" class="small-note">Adjustments: ' + sums(sn.totals.adjustments) + ". Leave and adjustments aren't applied.</td></tr>" +
    "</tbody></table></div>";
}
// Under each entity's table: approve and send to the accountants, or who approved it.
function payApprovalBar(d, ent, ws, ap, can) {
  var to = ((d.entities[ent] || {}).accountants || []);
  var log = (d.approvalLog || []).filter(function (l) { return l.entity === ent && l.week === ws && l.what === "undone"; }).map(function (l) {
    return '<div class="small-note">Approval undone by ' + E(l.by) + " on " + E(new Date(l.at).toLocaleString()) + ": " + E(l.reason) + "</div>";
  }).join("");
  if (ap) {
    var who = "Approved by " + E(ap.by) + " on " + E(new Date(ap.at).toLocaleString());
    var said = ap.mailed ? who + ", sent to " + E(ap.sentTo.join(", ")) + "."
      : ap.mailError ? who + '. <b>The email to ' + E(ap.sentTo.join(", ")) + " failed:</b> " + E(ap.mailError) + " Undo the approval and approve again to resend."
      : who + ", <b>but email isn't set up here, so nothing was sent</b> (it would have gone to " + E(ap.sentTo.join(", ")) + ").";
    return '<div class="banner" style="margin:8px 0 18px;">🔒 ' + said + " The week is locked: these are the figures as approved." +
      (can ? ' <button type="button" class="text-button" data-pay-unapprove="' + ent + '">Undo approval</button>' : "") + "</div>" + log;
  }
  if (!can) return '<p class="small-note" style="margin:8px 0 18px;">Not approved for the accountants yet.</p>' + log;
  return '<div class="nb-foot" style="margin:8px 0 18px;"><button type="button" class="primary" data-pay-approve="' + ent + '"' + (!to.length || pay.approving === ent ? " disabled" : "") + ">" +
    (!to.length ? "Add the accountants' email first" : pay.approving === ent ? "Approving…" : "Approve and send to accountants") + "</button>" +
    '<span class="small-note">' + (to.length ? "To " + E(to.join(", ")) + ". They check the figures before running payroll." : "Set it under Leave rules & accountants.") + "</span></div>" + log;
}
function payCurrency(d, ent, p) { return (p && p.currency) || (d.entities[ent] || {}).currency || { SOI: "USD", CAS: "NZD", RedSun: "SGD", NanoTech: "GBP" }[ent]; }

function renderPayroll() {
  if (!pay.loading && (pay.error ? Date.now() - pay.at > 15000 : !pay.data || Date.now() - pay.at > 60000)) loadPayroll();
  if (pay.error) return '<div class="banner">' + E(pay.error) + "</div>";
  if (!pay.data) return '<div class="empty">Loading payroll…</div>';
  var d = pay.data, can = d.canEdit;
  if (!pay.week) pay.week = payMonday(today);
  var ws = pay.week, we = payAddDays(ws, 6);
  var approved = d.leave.filter(function (i) { return i.status === "approved"; });
  var head = '<div class="banner pay-warn"><b>This is not a payroll calculation.</b> HR hasn\'t set how each kind of leave changes weekly pay for each entity, so nothing here works out pay. ' +
    "It lines up each person's base pay, their approved leave and any adjustments. <b>A qualified person must check every figure before any real payroll is sent.</b></div>" +
    '<div class="table-toolbar"><button type="button" data-pay-week="-7" aria-label="Previous week">←</button><b>Week of ' + E(fmtDate(ws)) + " – " + E(fmtDate(we)) + '</b><button type="button" data-pay-week="7" aria-label="Next week">→</button>' +
    (ws !== payMonday(today) ? '<button type="button" class="text-button" data-pay-week="0">This week</button>' : "") +
    '<span class="small-note">Only fully approved leave counts. ' + d.leave.filter(function (i) { return ["cover", "recover", "manager", "hr"].indexOf(i.status) !== -1; }).length + " request(s) still waiting for approval.</span></div>";

  var sections = PAY_ENTITIES.map(function (ent) {
    var logins = d.logins.filter(function (l) { return payEntityOf(d, l) === ent; });
    var e = d.entities[ent] || {}, rules = e.rules || {};
    var set = d.leaveTypes.filter(function (t) { return rules[t.id]; }).length;
    var rows = logins.map(function (l) {
      var p = payPerson(d, l.username), cur = payCurrency(d, ent, p);
      var lv = [];
      approved.filter(function (i) { return sameUser(i.by, l.username); }).forEach(function (i) {
        var x = payLeaveDays(i, ws);
        if (x && x.days) lv.push(E(i.fields.type === "other" ? i.fields.otherType : SF_LEAVE_LABEL[i.fields.type]) + ": " + x.days + (x.check ? ' <span class="pill rose" title="Working days were changed by hand and the leave runs past this week — check the request.">check</span>' : ""));
      });
      var adj = d.adjustments.filter(function (a) { return a.week === ws && sameUser(a.person, l.username); });
      return { l: l, p: p, cur: cur, lv: lv, adj: adj };
    });
    var shown = rows.filter(function (r) { return r.p.basePay != null || r.lv.length || r.adj.length || can; });
    var base = rows.reduce(function (s, r) { return s + (Number(r.p.basePay) || 0); }, 0);
    var rulesOpen = pay.rules === ent, ap = payApproval(d, ent, ws);
    var draft = pay.ruleDraft[ent] || (pay.ruleDraft[ent] = Object.assign({}, rules));
    return '<div class="section-title"><div><h2>' + E(d.entityLabels[ent]) + "</h2>" +
      '<span class="small-note">' + E((e.frequency || "weekly").replace(/^./, function (c) { return c.toUpperCase(); })) + " · " + E(payCurrency(d, ent)) + " · " +
      (set ? set + " of " + d.leaveTypes.length + " leave rules written" + (e.rulesBy ? " (last by " + E(e.rulesBy) + ")" : "") : "<b>Leave rules not set by HR yet</b>") + "</span></div>" +
      '<button type="button" class="text-button" data-pay-rules="' + ent + '">' + (rulesOpen ? "Hide leave rules & accountants" : "Leave rules & accountants") + "</button></div>" +
      (rulesOpen ? '<div class="card pay-rules" style="padding:16px 18px;margin-bottom:12px;"><div class="card-label">How each kind of leave changes pay — ' + E(d.entityLabels[ent]) + "</div>" +
        '<p class="small-note" style="margin:6px 0 12px;">For HR to fill in. The tracker shows these to whoever runs payroll; it doesn\'t apply them. Leave a box empty until HR has confirmed the rule.</p>' +
        (can ? '<div class="grid-2" style="gap:0 16px;"><div class="nb-field"><label for="pay-fr-' + ent + '">Pay period</label><select id="pay-fr-' + ent + '" data-pay-ent="' + ent + '" data-k="frequency">' + ["weekly", "fortnightly", "monthly"].map(function (f) {
            return '<option value="' + f + '"' + ((e.frequency || "weekly") === f ? " selected" : "") + ">" + f.replace(/^./, function (c) { return c.toUpperCase(); }) + "</option>"; }).join("") + "</select></div>" +
          '<div class="nb-field"><label for="pay-cur-' + ent + '">Currency</label><select id="pay-cur-' + ent + '" data-pay-ent="' + ent + '" data-k="currency">' + d.currencies.map(function (c) {
            return '<option' + (payCurrency(d, ent) === c ? " selected" : "") + ">" + c + "</option>"; }).join("") + "</select></div></div>" : "") +
        d.leaveTypes.map(function (t) {
          return '<div class="nb-field"><label for="pay-r-' + ent + "-" + t.id + '">' + E(t.label) + "</label>" + (can
            ? '<textarea id="pay-r-' + ent + "-" + t.id + '" rows="2" data-pay-rule="' + ent + ":" + t.id + '" placeholder="Not set">' + E(draft[t.id] || "") + "</textarea>"
            : '<div class="small-note">' + (rules[t.id] ? E(rules[t.id]) : "<i>Not set</i>") + "</div>") + "</div>";
        }).join("") +
        (can ? '<div class="nb-foot"><button type="button" class="primary" data-pay-saverules="' + ent + '">Save leave rules</button><span class="small-note">Saved with your name and the time.</span></div>' : "") +
        // The external accountants who check each approved week.
        '<div class="nb-field" style="margin-top:16px;"><label for="pay-acct-' + ent + '">Accountants\' email(s)</label>' + (can
          ? '<textarea id="pay-acct-' + ent + '" rows="2" data-pay-acct="' + ent + '" placeholder="One or more addresses, separated by commas">' + E(pay.acctDraft[ent] != null ? pay.acctDraft[ent] : (e.accountants || []).join(", ")) + "</textarea>"
          : '<div class="small-note">' + ((e.accountants || []).length ? E(e.accountants.join(", ")) : "<i>Not set</i>") + "</div>") + "</div>" +
        (can ? '<div class="nb-foot"><button type="button" class="primary" data-pay-saveacct="' + ent + '">Save accountants\' email</button><span class="small-note">"Approve and send to accountants" emails the week\'s figures here.</span></div>' : "") + "</div>" : "") +
      (ap ? payApprovedTable(ap) : '<div class="table-wrap"><table class="narrow"><thead><tr><th>Person</th><th>Weekly base pay</th><th>Approved leave this week (days)</th><th>Adjustments this week</th><th>Pay for the week</th></tr></thead><tbody>' +
      (shown.length ? shown.map(function (r) {
        return "<tr><td>" + E(r.l.username) + (ent === "SOI" ? payExemptTag(typeof r.p.exempt === "boolean" ? r.p.exempt : null) : "") + (can ? '<span class="co-note"><select class="fb-in" data-pay-person="' + E(r.l.username) + '" data-k="entity" aria-label="Entity">' + PAY_ENTITIES.map(function (x) {
            return '<option value="' + x + '"' + (x === ent ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></span>" : "") + "</td>" +
          "<td>" + (can ? '<input class="fb-in fb-num" type="number" step="0.01" min="0" data-pay-person="' + E(r.l.username) + '" data-k="basePay" value="' + E(r.p.basePay == null ? "" : r.p.basePay) + '" placeholder="Not entered" aria-label="Weekly base pay">' : r.p.basePay == null ? '<span class="dim">Not entered</span>' : E(sfAmount(r.p.basePay, r.cur))) + "</td>" +
          "<td>" + (r.lv.length ? r.lv.join("<br>") : '<span class="dim">—</span>') + "</td>" +
          "<td>" + (r.adj.length ? r.adj.map(function (a) {
            return E(sfAmount(a.amount, a.currency || r.cur)) + ' <span class="small-note">' + E(a.reason) + (a.source && a.source !== "manual" ? " · " + E(a.source === "spot-bonus" ? "Spot bonus from " + (a.by || "Leadership") : a.source) : "") + "</span>" + (can ? ' <button type="button" class="del" data-pay-deladj="' + E(a.id) + '" aria-label="Remove adjustment">×</button>' : "");
          }).join("<br>") : '<span class="dim">—</span>') + "</td>" +
          '<td><span class="small-note">Waiting for HR\'s leave rules</span></td></tr>';
      }).join("") : '<tr><td colspan="5" class="empty">Nobody on this entity yet.</td></tr>') +
      (shown.length ? '<tr class="pay-total"><td><b>Total base pay</b></td><td><b>' + E(sfAmount(base, payCurrency(d, ent))) + '</b> <span class="pill rose">needs a qualified check</span></td><td colspan="3" class="small-note">Base pay only. Leave and adjustments aren\'t applied.</td></tr>' : "") +
      "</tbody></table></div>") + payApprovalBar(d, ent, ws, ap, can);
  }).join("");

  // Add an adjustment (HR managers).
  var addForm = can ? (pay.adding ? '<div class="card" style="padding:16px 18px;margin-top:12px;"><div class="card-label">Adjustment for the week of ' + E(fmtDate(ws)) + "</div>" +
      '<div class="grid-2" style="gap:0 16px;margin-top:10px;"><div class="nb-field"><label for="pay-a-person">Person</label><select id="pay-a-person" data-pay-add="person"><option value="">Pick…</option>' +
        d.logins.map(function (l) { return '<option' + (pay.add.person === l.username ? " selected" : "") + ">" + E(l.username) + "</option>"; }).join("") + "</select></div>" +
      '<div class="nb-field"><label for="pay-a-amount">Amount (negative to deduct)</label><input id="pay-a-amount" type="number" step="0.01" data-pay-add="amount" value="' + E(pay.add.amount || "") + '"></div></div>' +
      '<div class="nb-field"><label for="pay-a-reason">What it\'s for</label><input id="pay-a-reason" data-pay-add="reason" value="' + E(pay.add.reason || "") + '" placeholder="e.g. Overtime agreed with manager"></div>' +
      '<div class="nb-foot"><button type="button" class="primary" data-pay-addsave>Add adjustment</button><button type="button" class="text-button" data-pay-addcancel>Cancel</button><span class="small-note">In the person\'s entity currency.</span></div></div>'
    : '<p style="margin-top:12px;"><button type="button" data-pay-addopen>+ Add adjustment</button></p>') : "";

  // Every leave request, with per-column filters.
  var lfields = [
    { key: "by", label: "Person", get: function (i) { return i.by; } },
    { key: "type", label: "Type", get: function (i) { return SF_LEAVE_LABEL[i.fields.type]; } },
    { key: "status", label: "Status", get: function (i) { return sfStatusLabel("leave", i.status); } },
    { key: "ent", label: "Entity", get: function (i) { var l = d.logins.filter(function (x) { return sameUser(x.username, i.by); })[0]; return l ? payEntityOf(d, l) : "—"; } },
    { key: "month", label: "Month", get: function (i) { return fmtDate(i.fields.from).replace(/^(\w+) \d+, /, "$1 "); } }
  ];
  var all = d.leave.slice().sort(function (a, b) { return String(b.fields.from).localeCompare(String(a.fields.from)); });
  var list = applyColFilters("pay:leave", lfields, all);
  var leaveTable = '<div class="section-title" style="margin-top:26px;"><div><h2>Leave requests</h2><span class="small-note">Everyone\'s leave, newest first. Approvals happen on each approver\'s Mentions of You (and HR → Staff-Facing).</span></div></div>' +
    filterUi("pay:leave", lfields, all, list.length) +
    '<div class="table-wrap"><table class="narrow"><thead><tr><th>Person</th><th>Leave</th><th>Status</th><th>Approvals</th><th></th></tr></thead><tbody>' +
    (list.length ? list.map(function (i) {
      return "<tr><td>" + E(i.by) + '</td><td class="sf-what">' + E(sfWhat(i)) + (i.fields.notes ? '<span class="co-note">' + E(i.fields.notes) + "</span>" : "") + "</td><td>" + sfChip("leave", i.status) + (i.reason ? '<span class="co-note">' + E(i.reason) + "</span>" : "") + "</td>" +
        '<td class="small-note">' + [i.coverOk ? "Cover: " + E(i.coverOk.by) : "", i.managerOk ? "Manager: " + E(i.managerOk.by) : "", i.hrOk ? "HR: " + E(i.hrOk.by) : ""].filter(Boolean).join("<br>") + "</td>" +
        '<td class="row-tools">' + (can && i.status === "approved" ? '<button type="button" class="text-button" data-pay-cancelleave="' + E(i.id) + '">Cancel leave</button>' : "") + "</td></tr>";
    }).join("") : '<tr><td colspan="5" class="empty">' + (all.length ? "Nothing matches these filters." : "No leave requests yet.") + "</td></tr>") + "</tbody></table></div>";

  return head + sections + addForm + leaveTable;
}

function payPut(url, body, okMsg) {
  setSync("busy", "Saving…");
  return api(url, { method: "PUT", body: JSON.stringify(body) }).then(function () { setSync("on", "Live"); if (okMsg) toast(okMsg); }, function (err) { setSync("on", "Live"); toast(err.message, true); })
    .then(function () { pay.at = 0; loadPayroll(); });
}
document.addEventListener("input", function (e) {
  var ds = e.target.dataset || {};
  if (ds.payRule) { var p = ds.payRule.split(":"); (pay.ruleDraft[p[0]] = pay.ruleDraft[p[0]] || {})[p[1]] = e.target.value; }
  else if (ds.payAdd) pay.add[ds.payAdd] = e.target.value;
  else if (ds.payAcct) pay.acctDraft[ds.payAcct] = e.target.value;
});
document.addEventListener("change", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (ds.payAdd) pay.add[ds.payAdd] = t.value;
  else if (ds.payEnt) { var b = {}; b[ds.k] = t.value; payPut("/api/payroll/entity/" + encodeURIComponent(ds.payEnt), b); }
  else if (ds.payPerson) { var o = {}; o[ds.k] = t.value; payPut("/api/payroll/person/" + encodeURIComponent(ds.payPerson), o); }
});
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-pay-week],[data-pay-rules],[data-pay-saverules],[data-pay-deladj],[data-pay-addopen],[data-pay-addcancel],[data-pay-addsave],[data-pay-cancelleave],[data-pay-saveacct],[data-pay-approve],[data-pay-unapprove]");
  if (!t) return;
  var ds = t.dataset;
  if (ds.payWeek != null) { pay.week = +ds.payWeek ? payAddDays(pay.week || payMonday(today), +ds.payWeek) : payMonday(today); render(); }
  else if (ds.payRules) { pay.rules = pay.rules === ds.payRules ? "" : ds.payRules; render(); }
  else if (ds.paySaveacct) {
    var ae = ds.paySaveacct, draft = pay.acctDraft[ae];
    // The typed text stays if the server turns it down (a bad address).
    api("/api/payroll/entity/" + encodeURIComponent(ae), { method: "PUT", body: JSON.stringify({ accountants: draft != null ? draft : ((pay.data.entities[ae] || {}).accountants || []).join(", ") }) })
      .then(function () { delete pay.acctDraft[ae]; toast("Accountants' email saved."); }, function (err) { toast(err.message, true); })
      .then(function () { pay.at = 0; loadPayroll(); });
  }
  else if (ds.payApprove) {
    var pd = pay.data, pe = ds.payApprove, to = ((pd.entities[pe] || {}).accountants || []);
    if (!to.length) return;
    if (!confirm("Approve " + pd.entityLabels[pe] + ", week of " + fmtDate(pay.week) + ", and send the figures to:\n\n" + to.join("\n") +
      "\n\nThey check them before running payroll. The week locks until someone undoes the approval." +
      (pd.mailConfigured ? "" : "\n\nEmail isn't set up here: the approval is recorded but nothing is sent."))) return;
    pay.approving = pe; render();
    api("/api/payroll/approve", { method: "POST", body: JSON.stringify({ entity: pe, week: pay.week }) })
      .then(function (ap) {
        if (ap.mailed) toast("Approved and sent to " + ap.sentTo.join(", ") + ".");
        else if (ap.mailError) toast("Approved, but the email failed: " + ap.mailError, true);
        else toast("Approved, but email isn't set up here, so nothing was sent.");
      }, function (err) { toast(err.message, true); })
      .then(function () { pay.approving = ""; pay.at = 0; loadPayroll(); });
  }
  else if (ds.payUnapprove) {
    var ue = ds.payUnapprove, uw = pay.week;
    sfAsk("Undo the approval", "Why? It's logged, and the week unlocks. Approving again sends the email again.", function (reason) {
      api("/api/payroll/approve/undo", { method: "POST", body: JSON.stringify({ entity: ue, week: uw, reason: reason }) })
        .then(function () { toast("Approval undone."); }, function (err) { toast(err.message, true); }).then(function () { pay.at = 0; loadPayroll(); });
    });
  }
  else if (ds.paySaverules) payPut("/api/payroll/entity/" + encodeURIComponent(ds.paySaverules), { rules: pay.ruleDraft[ds.paySaverules] || {} }, "Leave rules saved.");
  else if (ds.payDeladj) {
    if (!confirm("Remove this adjustment?")) return;
    api("/api/payroll/adjustments/" + encodeURIComponent(ds.payDeladj), { method: "DELETE" }).catch(function (err) { toast(err.message, true); }).then(function () { pay.at = 0; loadPayroll(); });
  }
  else if ("payAddopen" in ds) { pay.adding = true; pay.add = {}; render(); }
  else if ("payAddcancel" in ds) { pay.adding = false; render(); }
  else if ("payAddsave" in ds) {
    var d = pay.data, l = d.logins.filter(function (x) { return x.username === pay.add.person; })[0];
    var ent = l ? payEntityOf(d, l) : "SOI";
    api("/api/payroll/adjustments", { method: "POST", body: JSON.stringify({ person: pay.add.person, amount: pay.add.amount, reason: pay.add.reason, week: pay.week, currency: payCurrency(d, ent, payPerson(d, pay.add.person)) }) })
      .then(function () { pay.adding = false; toast("Adjustment added."); }, function (err) { toast(err.message, true); })
      .then(function () { pay.at = 0; loadPayroll(); });
  }
  else if (ds.payCancelleave) {
    var id = ds.payCancelleave;
    sfAsk("Cancel approved leave", "Why? The person will see this.", function (note) {
      api("/api/staff-forms/" + encodeURIComponent(id) + "/leave", { method: "POST", body: JSON.stringify({ decision: "cancel", note: note }) })
        .then(function () { toast("Leave cancelled."); }, function (err) { toast(err.message, true); }).then(function () { pay.at = 0; loadPayroll(); });
    });
  }
});

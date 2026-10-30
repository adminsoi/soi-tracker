"use strict";
// Quarterly business review panels (Overview, Leadership).
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- Quarterly business review (Overview, Leadership) ----
// The QBR slides as live numbers from Pentagon (dashboards.qbr_* queries).
// Any number can be typed in for the quarter (e.g. until its query exists);
// typed numbers are marked. Targets come from /admin.html.
// scope: "full" (Overview, leadership) or "warehouse" (Warehouse → Insights).
var qbr = { quarter: "", data: null, at: 0, loading: false, error: "", scope: "full" };
function qbrUrl() { return qbr.scope === "warehouse" ? "/api/qbr-warehouse" : "/api/qbr"; }
function qbrCan() { return qbr.scope === "full" || !!(qbr.data && qbr.data.canEdit); }
function qbrNow() { var d = new Date(); return d.getFullYear() + "-Q" + (Math.floor(d.getMonth() / 3) + 1); }
function qbrShift(q, n) { var m = /^(\d{4})-Q([1-4])$/.exec(q); var i = (+m[1]) * 4 + (+m[2] - 1) + n; return Math.floor(i / 4) + "-Q" + (i % 4 + 1); }
function loadQbr(fresh) {
  if (qbr.loading) return;
  qbr.loading = true;
  var q = qbr.quarter || qbrNow(), key = qbr.scope + "|" + q;
  api(qbrUrl() + "?quarter=" + encodeURIComponent(q) + (fresh ? "&fresh=1" : "")).then(function (d) { if (qbr.scope + "|" + q === key) { qbr.data = d; qbr.error = ""; qbr.key = key; } }, function (err) { qbr.error = err.message; })
    .then(function () { qbr.loading = false; qbr.at = Date.now(); if (page === "overview" || page === "departments") requestRender(); });
}
function qbrVal(k) { var d = qbr.data; return d.overrides[k] != null ? d.overrides[k] : d.metrics[k] != null ? d.metrics[k] : null; }
function qbrFmt(v, kind) {
  if (v == null) return "—";
  if (kind === "money") return Number(v).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  if (kind === "pct") return (Math.round(Number(v) * 100) / 100).toLocaleString() + "%";
  if (kind === "days") return Math.round(Number(v)) + " days";
  return Number(v).toLocaleString();
}
function qbrTile(k, label, kind) {
  var typed = qbr.data.overrides[k] != null, can = qbrCan();
  return '<div class="metric qbr-tile"><strong>' + E(qbrFmt(qbrVal(k), kind)) + '</strong><div class="eyebrow">' + E(label) + "</div>" +
    '<small>' + (typed ? "Typed in" : qbr.data.metrics[k] == null ? "No data yet" : "From Pentagon") +
    (can ? ' · <button type="button" class="text-button" data-qbr-edit="' + k + '" data-kind="' + (kind || "") + '" data-label="' + E(label) + '">' + (typed ? "change" : "type in") + "</button>" +
      (typed ? ' · <button type="button" class="text-button" data-qbr-clear="' + k + '">use Pentagon</button>' : "") : "") + "</small></div>";
}
// A query that didn't work, with Transmute's own error so it can be fixed.
function qbrMissing(keys) {
  // The rejections list query is optional (the list can be typed in), so a
  // missing one isn't worth a warning.
  var st = qbr.data.status, out = keys.filter(function (k) {
    return st[k] && !st[k].ok && !(k === "rejections" && /unknown_query|does not exist/i.test(st[k].error || ""));
  });
  return out.length ? '<div class="small-note qbr-missing">' + out.map(function (k) {
    return "<div><b>Couldn't read <code>" + E(st[k].query) + "</code></b>" + (st[k].error ? ' — Transmute said: <span class="qbr-err">' + E(st[k].error) + "</span>" : "") + "</div>";
  }).join("") + '<div style="margin-top:4px;">Type the numbers in for now, or fix the query in Transmute and <button type="button" class="text-button" data-qbr-recheck>check again</button>.</div></div>' : "";
}
function qbrNote(section, placeholder) {
  var v = (qbr.data.notes || {})[section] || "";
  if (!qbrCan()) return v ? '<div class="nb-field" style="margin-top:10px;"><label>Notes / context</label><div class="itr-note">' + E(v) + "</div></div>" : "";
  return '<div class="nb-field" style="margin-top:10px;"><label>Notes / context</label><textarea rows="2" data-qbr-note="' + section + '" placeholder="' + E(placeholder) + '">' + E(v) + "</textarea></div>";
}
function qbrMeter(label, actual, target, yearTarget, what) {
  if (!target) return '<div class="qbr-meter"><div class="card-label">' + E(label) + '</div><p class="small-note">Set the quarterly target in /admin.html → Quarterly review targets.</p></div>';
  var pct = actual != null ? actual / target * 100 : null;
  var fill = pct == null ? 0 : Math.min(pct, 100);
  return '<div class="qbr-meter"><div class="card-label">' + E(label) + ' — % of target</div>' +
    '<div class="qbr-big">' + (pct == null ? "—" : (Math.round(pct * 100) / 100).toFixed(2) + "%") + "</div>" +
    '<div class="qbr-bar" role="img" aria-label="' + E(label + ": " + (pct == null ? "no data" : pct.toFixed(1) + "% of target")) + '"><span style="width:' + fill + '%"></span><i title="Target (100%)"></i></div>' +
    '<div class="qbr-scale"><span>0%</span><span>50%</span><span>Target</span></div>' +
    '<p class="small-note" style="margin-top:8px;">' + E(qbrFmt(actual, "money")) + " " + E(what) + " against a quarterly target of " + E(qbrFmt(target, "money")) +
    (pct != null ? (pct >= 100 ? " — target exceeded." : " — " + qbrFmt(target - actual, "money") + " to go.") : ".") +
    (yearTarget ? " Annual target " + E(qbrFmt(yearTarget, "money")) + "." : "") + "</p></div>";
}
function qbrPicker(q) {
  var m = /^(\d{4})-Q([1-4])$/.exec(q);
  return '<div class="cos"><button type="button" class="co" data-qbr-q="-1" aria-label="Previous quarter">‹</button><button type="button" class="co active" data-qbr-q="0">Q' + m[2] + " " + m[1] + '</button><button type="button" class="co" data-qbr-q="1" aria-label="Next quarter">›</button></div>';
}
// Loads (or reloads) for a scope; returns true once that scope's data is in.
function qbrReady(scope) {
  var q = qbr.quarter || qbrNow(), key = scope + "|" + q;
  if (qbr.scope !== scope) { qbr.scope = scope; qbr.data = null; qbr.error = ""; qbr.loading = false; }
  if (!qbr.data || qbr.key !== key || Date.now() - qbr.at > 300000) loadQbr();
  return !!(qbr.data && qbr.key === key);
}
function qbrWarehousePanel(num) {
  var d = qbr.data, met = d.metrics, can = qbrCan();
  var rejQuery = met.rejectionList, manual = d.manualRejections || [];
  var rejRows = rejQuery ? rejQuery.map(function (r) { return "<tr><td>" + E(r.part) + "</td><td>" + E(r.party) + "</td><td>" + E(r.reason) + "</td><td>" + E(r.date ? fmtDate(r.date) : "") + "</td><td></td></tr>"; }).join("")
    : manual.map(function (r, i) { return "<tr><td>" + E(r.part) + "</td><td>" + E(r.party) + "</td><td>" + E(r.reason) + "</td><td>" + E(r.date ? fmtDate(r.date) : "") + "</td><td>" + (can ? '<button type="button" class="text-button" data-qbr-rmrej="' + i + '">Remove</button>' : "") + "</td></tr>"; }).join("");
  return '<div class="qbr-panel"><div class="qbr-h">' + (num ? '<span class="qbr-num">' + num + "</span>" : "") + "<h3>Warehouse — Logistics</h3></div>" + qbrMissing(["warehouse", "rejections"]) +
    '<div class="summary-cards">' + qbrTile("linesReceived", "Lines received") + qbrTile("supplierOnTime", "Supplier on-time", "pct") + qbrTile("linesShipped", "Lines shipped") + "</div>" +
    '<div class="grid-2">' + qbrTile("customerOnTime", "Customer on-time", "pct") + qbrTile("rejections", "Total rejections") + "</div>" +
    '<div class="card-label" style="margin-top:14px;">Rejections</div><div class="table-wrap"><table class="plain"><thead><tr><th>Part # / line item</th><th>Customer / supplier</th><th>Reason for rejection</th><th>Date</th><th></th></tr></thead><tbody>' +
      (rejRows || '<tr><td colspan="5" class="empty">None listed.</td></tr>') + "</tbody></table></div>" +
    (rejQuery || !can ? "" : '<div class="qbr-addrej"><input id="qr-part" placeholder="Part # / line item"><input id="qr-party" placeholder="Customer / supplier"><input id="qr-reason" placeholder="Reason"><input id="qr-date" type="date"><button type="button" data-qbr-addrej>+ Add rejection</button></div>') +
    qbrNote("warehouse", "Context on on-time performance or rejections") + "</div>";
}
// Warehouse → Insights: the warehouse part of the quarterly review.
function renderWarehouseInsights() {
  var q = qbr.quarter || qbrNow(), ok = qbrReady("warehouse");
  var head = '<div class="section-title" style="margin-top:16px;"><div><h2>Warehouse insights</h2><span class="small-note">Live from Pentagon, refreshed every 5 minutes · the same numbers as the quarterly review</span></div>' + qbrPicker(q) + "</div>";
  if (qbr.error) return head + '<div class="banner">' + E(qbr.error) + "</div>";
  if (!ok) return head + '<div class="empty">Loading…</div>';
  return head + '<div class="qbr">' + qbrWarehousePanel("") + "</div>" +
    (qbr.data.canEdit ? "" : '<p class="small-note" style="margin-top:10px;">Only managers can type in numbers or change the rejections list.</p>');
}
function renderQbr() {
  var q = qbr.quarter || qbrNow(), ok = qbrReady("full");
  var head = '<div class="section-title" style="margin-top:30px;"><div><h2>Quarterly business review</h2><span class="small-note">Leadership only · live from Pentagon, refreshed every 5 minutes</span></div>' + qbrPicker(q) + "</div>";
  if (qbr.error) return head + '<div class="banner">' + E(qbr.error) + "</div>";
  if (!ok) return head + '<div class="empty">Loading…</div>';
  var d = qbr.data, met = d.metrics, t = d.targets;
  var cust = met.topCustomers || [];
  var procurement = '<div class="qbr-panel"><div class="qbr-h"><span class="qbr-num">1</span><h3>Procurement — Quotes &amp; RFQs</h3></div>' + qbrMissing(["customers"]) +
    '<div class="summary-cards">' + qbrTile("quoted", "Total quoted value", "money") + qbrTile("orders", "Total orders won", "money") + qbrTile("conversion", "Quote-to-sale conversion", "pct") + "</div>" +
    (cust.length ? '<div class="card-label">Top customers — quoted vs. order value</div><div class="table-wrap"><table class="plain"><thead><tr><th>Customer</th><th>Quoted value</th><th>Order value</th><th>Conversion</th></tr></thead><tbody>' +
      cust.slice(0, 5).map(function (c) { return "<tr><td>" + E(c.customer) + "</td><td>" + E(qbrFmt(c.quoted, "money")) + "</td><td>" + E(qbrFmt(c.ordered, "money")) + "</td><td>" + E(qbrFmt(c.conversion, "pct")) + "</td></tr>"; }).join("") +
      "</tbody></table></div>" : "") + qbrNote("procurement", "Anything worth flagging about quotes or customers this quarter") + "</div>";
  var purchasing = '<div class="qbr-panel"><div class="qbr-h"><span class="qbr-num">2</span><h3>Purchasing</h3></div>' + qbrMissing(["purchasing"]) +
    '<div class="summary-cards">' + qbrTile("openPos", "Total open POs") + qbrTile("newPos", "New POs issued (quarter)") + qbrTile("avgCycleDays", "Avg. PO cycle time", "days") + "</div>" +
    '<div class="grid-2">' + qbrTile("receivedNoExt", "Line items purchased & received — no extension") + qbrTile("receivedWithExt", "Line items purchased & received — with extension") + "</div>" +
    qbrNote("purchasing", "Extension causes, vendor performance notes, or trends worth flagging") + "</div>";
  var warehouse = qbrWarehousePanel("3");
  var targets = '<div class="qbr-panel"><div class="qbr-h"><span class="qbr-num">4</span><h3>Quarter snapshot — target attainment</h3></div>' + qbrMissing(["grossProfit"]) +
    '<div class="grid-2">' + qbrMeter("Procurement", qbrVal("orders"), t.procurementQuarter, t.procurementYear, "in new entered sales orders") +
    qbrMeter("Purchasing", qbrVal("grossProfit"), t.purchasingQuarter, t.purchasingYear, "in gross profit") + "</div>" +
    '<div style="margin-top:8px;">' + qbrTile("grossProfit", "Gross profit (quarter)", "money") + "</div>" + qbrNote("targets", "How the teams did against target this quarter") + "</div>";
  return head + '<div class="qbr">' + procurement + purchasing + warehouse + targets + "</div>";
}
function qbrSave(body) {
  var q = qbr.quarter || qbrNow();
  return api(qbrUrl() + "/" + encodeURIComponent(q), { method: "PUT", body: JSON.stringify(body) }).then(function () { qbr.at = 0; loadQbr(); }, function (err) { toast(err.message, true); });
}
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-qbr-q],[data-qbr-edit],[data-qbr-clear],[data-qbr-addrej],[data-qbr-rmrej],[data-qbr-recheck]");
  if (!t) return;
  var ds = t.dataset;
  if ("qbrRecheck" in ds) { t.textContent = "checking…"; loadQbr(true); return; }
  if (ds.qbrQ !== undefined) { var n = +ds.qbrQ; qbr.quarter = n ? qbrShift(qbr.quarter || qbrNow(), n) : qbrNow(); qbr.data = null; render(); return; }
  if (ds.qbrEdit) {
    var cur = qbrVal(ds.qbrEdit), v = prompt(ds.label + (ds.kind === "pct" ? " (%)" : ds.kind === "money" ? " ($)" : ds.kind === "days" ? " (days)" : "") + " for this quarter:", cur == null ? "" : cur);
    if (v === null) return;
    var ov = {}; ov[ds.qbrEdit] = v.trim(); qbrSave({ overrides: ov }).then(function () { toast("Saved."); });
    return;
  }
  if (ds.qbrClear) { var c = {}; c[ds.qbrClear] = null; qbrSave({ overrides: c }); return; }
  if ("qbrAddrej" in ds) {
    var row = { part: $("#qr-part").value, party: $("#qr-party").value, reason: $("#qr-reason").value, date: $("#qr-date").value };
    if (!row.part.trim() && !row.reason.trim()) { toast("Add the part and the reason.", true); return; }
    qbrSave({ rejections: (qbr.data.manualRejections || []).concat([row]) });
    return;
  }
  if (ds.qbrRmrej !== undefined) { var list = (qbr.data.manualRejections || []).slice(); list.splice(+ds.qbrRmrej, 1); qbrSave({ rejections: list }); }
});
document.addEventListener("change", function (e) {
  var k = e.target.dataset && e.target.dataset.qbrNote;
  if (!k) return;
  var notes = {}; notes[k] = e.target.value;
  qbrSave({ notes: notes }).then(function () { toast("Saved."); });
});

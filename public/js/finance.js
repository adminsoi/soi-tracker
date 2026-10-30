"use strict";
// Finance: bank balances, payments to approve, expected receipts.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- Finance ----
function renderFinance() {
  if (activeCompany === ALL) return '<div class="empty">Pick one company to see its finance tables.</div>';
  if (!finance || finance.company !== activeCompany) { loadFinance().then(requestRender); return '<div class="empty">Loading finance…</div>'; }
  if (finance.error) return '<div class="empty">' + E(finance.error) + "</div>";
  var f = finance.data;
  var mgr = isManager();
  setQuickAdd("Add payment", "fin:dailyPayments");
  var fin = function (list, r, key, type, ph) {
    if (r.source === "pentagon" && key !== "notes") {
      if (type === "number") return '<span class="static fb-num">' + E(money(r[key])) + "</span>";
      if (type === "date") return '<span class="static">' + (r[key] ? E(fmtDate(r[key])) : '<span class="dim">—</span>') + "</span>";
      var first = key === "name" || key === "vendor" || key === "party";
      return '<span class="static">' + E(r[key] || "—") + (first ? '<span class="src">PENTAGON</span>' : "") + "</span>" +
        (first && (r.docNo || r.ref) && key !== "name" ? '<span class="co-note">' + E([r.docNo ? "#" + r.docNo : "", r.ref].filter(Boolean).join(" · ")) + "</span>" : "");
    }
    var attrs = ' data-fin="' + list + '" data-fid="' + E(r.id) + '" data-key="' + key + '"';
    if (type === "textarea") return '<textarea class="fb-in fb-notes" rows="1"' + attrs + ' placeholder="Notes…">' + E(r[key]) + "</textarea>";
    return '<input class="fb-in' + (type === "number" ? " fb-num" : "") + '" type="' + (type || "text") + '"' + (type === "number" ? ' step="0.01"' : "") + attrs + ' value="' + E(r[key]) + '" placeholder="' + E(ph || "") + '">';
  };
  var tick = function (list, r, key, label) {
    return '<input class="check" type="checkbox" data-fin-tick="' + list + '" data-fid="' + E(r.id) + '" data-key="' + key + '"' + (r[key] ? " checked" : "") + (mgr ? "" : " disabled") + ' aria-label="' + E(label) + '">';
  };
  var del = function (list, r) { return r.source === "pentagon" ? "" : '<button type="button" class="del" data-fin-del="' + list + '" data-fid="' + E(r.id) + '" title="Delete" aria-label="Delete">×</button>'; };
  // Where each table's rows come from (SOI pulls from Pentagon).
  var pgNote = "";
  if (f.pentagon) {
    var line = function (label, st) { return st.connected ? label + ": " + st.count + " from Pentagon" : label + ": " + st.error; };
    pgNote = '<div class="banner"><b>Bills, customer invoices and bank balances come from Pentagon</b> (refreshed every minute; amounts change in Pentagon, not here). ' +
      E([line("Bills", f.pentagon.payables), line("Customer invoices", f.pentagon.receivables), line("Bank balances", f.pentagon.banks)].join(" · ")) + " — you can still add rows by hand.</div>";
  }
  var sect = function (title, note, list, label) {
    return '<div class="section-title"><div><h2>' + title + '</h2><span class="small-note">' + note + "</span></div>" +
      (list ? '<button type="button" class="primary" data-add="fin:' + list + '">+ ' + label + "</button>" : "") + "</div>";
  };
  var unreceived = f.expectedReceipts.filter(function (r) { return !r.received; });
  return '<div class="summary-cards four">' +
    metric("Bank balances", money(sum(f.accounts, "balance")), "Across " + f.accounts.length + " account" + (f.accounts.length === 1 ? "" : "s")) +
    metric("Payments due", money(sum(f.dailyPayments, "amount")), f.dailyPayments.length + " awaiting approval") +
    metric("Approved to pay", money(sum(f.approvedToPay, "amount")), f.approvedToPay.length + " approved, " + f.approvedToPay.filter(function (r) { return r.paid; }).length + " paid") +
    metric("Expected in", money(sum(unreceived, "amount")), unreceived.length + " still to receive") + "</div>" +
    pgNote +
    '<div class="banner"><b>Nothing here is connected to a bank</b> and nothing is ever sent. Don\'t enter account numbers. ' +
    (mgr ? "As a manager you approve payments and tick paid / received." : "Only a manager can approve payments or tick paid / received.") + "</div>" +
    sect("Bank accounts", f.pentagon ? "Balances from Pentagon, plus any entered by hand." : "Current balances, entered by hand.", "accounts", "Add account") +
    '<div class="table-wrap"><table class="narrow"><thead><tr><th>Account</th><th>Balance</th><th>As of</th><th>Notes</th><th></th></tr></thead><tbody>' +
    (f.accounts.length ? f.accounts.map(function (a) {
      return "<tr><td>" + fin("accounts", a, "name", "text", "Account name") + "</td><td>" + fin("accounts", a, "balance", "number", "0.00") + "</td><td>" + fin("accounts", a, "asOf", "date") +
        '</td><td class="notes-cell">' + fin("accounts", a, "notes", "textarea") + "</td><td>" + del("accounts", a) + "</td></tr>";
    }).join("") : '<tr><td colspan="5" class="empty">No accounts yet.</td></tr>') + "</tbody></table></div>" +
    sect("Daily payments", "Payments due. A manager ticks Approve and the row moves to Approved to pay.", "dailyPayments", "Add payment") +
    '<div class="table-wrap"><table class="narrow"><thead><tr><th>Vendor</th><th>Amount</th><th>Due</th><th>Notes</th><th>Approve</th><th></th></tr></thead><tbody>' +
    (f.dailyPayments.length ? f.dailyPayments.map(function (r) {
      return '<tr class="' + (r.due && r.due < today ? "overdue" : "") + '"><td>' + fin("dailyPayments", r, "vendor", "text", "Vendor") + "</td><td>" + fin("dailyPayments", r, "amount", "number", "0.00") + "</td><td>" + fin("dailyPayments", r, "due", "date") +
        '</td><td class="notes-cell">' + fin("dailyPayments", r, "notes", "textarea") + '</td><td class="center"><input class="check" type="checkbox" data-approve="' + E(r.id) + '"' + (mgr ? "" : " disabled") + ' aria-label="Approve payment to ' + E(r.vendor || "vendor") + '"></td><td>' + del("dailyPayments", r) + "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="empty">Nothing waiting for approval.</td></tr>') + "</tbody></table></div>" +
    sect("Approved to pay", "Untick Approved to send a row back to Daily payments.", "", "") +
    '<div class="table-wrap"><table class="narrow"><thead><tr><th>Vendor</th><th>Amount</th><th>Due</th><th>Approved on</th><th>Notes</th><th>Approved</th><th>Paid</th><th></th></tr></thead><tbody>' +
    (f.approvedToPay.length ? f.approvedToPay.map(function (r) {
      return '<tr class="' + (r.paid ? "done" : "") + '"><td>' + fin("approvedToPay", r, "vendor", "text", "Vendor") + "</td><td>" + fin("approvedToPay", r, "amount", "number", "0.00") + "</td><td>" + fin("approvedToPay", r, "due", "date") +
        '</td><td class="small-note">' + E(fmtTime(r.approvedAt)) + (r.approvedBy ? "<br>by " + E(r.approvedBy) : "") + '</td><td class="notes-cell">' + fin("approvedToPay", r, "notes", "textarea") +
        '</td><td class="center"><input class="check" type="checkbox" checked data-unapprove="' + E(r.id) + '"' + (mgr ? "" : " disabled") + ' aria-label="Remove approval"></td><td class="center">' + tick("approvedToPay", r, "paid", "Paid") + "</td><td>" + del("approvedToPay", r) + "</td></tr>";
    }).join("") : '<tr><td colspan="8" class="empty">No approved payments yet.</td></tr>') + "</tbody></table></div>" +
    sect("Expected receipts", "Money coming in: who from, how much and when.", "expectedReceipts", "Add receipt") +
    '<div class="table-wrap"><table class="narrow"><thead><tr><th>Customer / vendor</th><th>Amount</th><th>Expected</th><th>Received</th><th>Notes</th><th></th></tr></thead><tbody>' +
    (f.expectedReceipts.length ? f.expectedReceipts.map(function (r) {
      return '<tr class="' + (r.received ? "done " : "") + (r.expected && !r.received && r.expected < today ? "overdue" : "") + '"><td>' + fin("expectedReceipts", r, "party", "text", "Customer or vendor") + "</td><td>" + fin("expectedReceipts", r, "amount", "number", "0.00") +
        "</td><td>" + fin("expectedReceipts", r, "expected", "date") + '</td><td class="center">' + tick("expectedReceipts", r, "received", "Received") + '</td><td class="notes-cell">' + fin("expectedReceipts", r, "notes", "textarea") + "</td><td>" + del("expectedReceipts", r) + "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="empty">No expected receipts yet.</td></tr>') + "</tbody></table></div>";
}
function financeOp(body, okMsg) {
  body.company = activeCompany;
  setSync("busy", "Saving…");
  return api("/api/finance", { method: "POST", body: JSON.stringify(body) }).then(function () {
    setSync("on", "Live");
    if (okMsg) toast(okMsg);
  }).catch(function (err) {
    setSync("on", "Live");
    toast(err.message, true);
  }).then(loadFinance).then(requestRender);
}
function financeDefaults(list) {
  if (list === "accounts") return { name: "", balance: 0, asOf: today, notes: "" };
  if (list === "dailyPayments") return { vendor: "", amount: 0, due: today, notes: "" };
  return { party: "", amount: 0, expected: today, received: false, notes: "" };
}

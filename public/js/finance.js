"use strict";
// Finance → Department-Facing: Approvals, Transfers and Balances.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- Finance ----
// Approvals is everything above "Approved to pay": bills waiting for a
// manager's approval and staff reimbursements still being checked.
// Transfers is "Approved to pay" and below: approved bills and
// reimbursements, until they're paid, then expected receipts. Balances
// keeps bank balances. Every table has per-column filters.
var FIN_SUBS = ["approvals", "transfers", "balances"];
// Shared by every Finance tab: loads the tables, or says why it can't.
function financeReady() {
  if (activeCompany === ALL) return '<div class="empty">Pick one company to see its finance tables.</div>';
  if (!finance || finance.company !== activeCompany) { loadFinance().then(requestRender); return '<div class="empty">Loading finance…</div>'; }
  if (finance.error) return '<div class="empty">' + E(finance.error) + "</div>";
  return "";
}
function finCell(list, r, key, type, ph) {
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
}
function finTick(list, r, key, label) {
  return '<input class="check" type="checkbox" data-fin-tick="' + list + '" data-fid="' + E(r.id) + '" data-key="' + key + '"' + (r[key] ? " checked" : "") + (isManager() ? "" : " disabled") + ' aria-label="' + E(label) + '">';
}
function finDel(list, r) { return r.source === "pentagon" ? "" : '<button type="button" class="del" data-fin-del="' + list + '" data-fid="' + E(r.id) + '" title="Delete" aria-label="Delete">×</button>'; }
function finSect(title, note, list, label) {
  return '<div class="section-title"><div><h2>' + title + '</h2><span class="small-note">' + note + "</span></div>" +
    (list ? '<button type="button" class="primary" data-add="fin:' + list + '">+ ' + label + "</button>" : "") + "</div>";
}
function finTable(head, rows, cols, emptyText) {
  return '<div class="table-wrap"><table class="narrow"><thead><tr>' + head.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead><tbody>" +
    (rows.length ? rows.join("") : '<tr><td colspan="' + cols + '" class="empty">' + emptyText + "</td></tr>") + "</tbody></table></div>";
}
// Filter fields every bill / receipt table shares.
function finSrc(r) { return r.source === "pentagon" ? "Pentagon" : "Added here"; }
function pgNote(f) {
  if (!f.pentagon) return "";
  var line = function (label, st) { return st.connected ? label + ": " + st.count + " from Pentagon" : label + ": " + st.error; };
  return '<div class="banner"><b>Bills, customer invoices and bank balances come from Pentagon</b> (refreshed every minute; amounts change in Pentagon, not here). ' +
    E([line("Bills", f.pentagon.payables), line("Customer invoices", f.pentagon.receivables), line("Bank balances", f.pentagon.banks)].join(" · ")) + " — you can still add rows by hand.</div>";
}
function finBanner() {
  return '<div class="banner"><b>Nothing here is connected to a bank</b> and nothing is ever sent. Don\'t enter account numbers. ' +
    (isManager() ? "As a manager you approve payments and tick paid / received." : "Only a manager can approve payments or tick paid / received.") + "</div>";
}
// Filtered rows for one table, plus its filter bar.
function finFiltered(scope, fields, rows) {
  var list = applyColFilters(scope, fields, rows);
  return { list: list, ui: filterUi(scope, fields, rows, list.length) };
}

// Staff reimbursements, from Finance's side (staff-forms.js loads them).
function finReimbFields(withApprover) {
  var f = [
    { key: "status", label: "Status", get: function (i) { return sfStatusLabel(i.kind, i.status); } },
    { key: "by", label: "From", get: function (i) { return i.by; } },
    { key: "cur", label: "Currency", get: function (i) { return i.fields.currency; } },
    { key: "owner", label: "Responsible", get: function (i) { return i.assignee || "Unassigned"; } },
    { key: "month", label: "Sent", get: function (i) { return new Date(i.at).toLocaleString([], { month: "short", year: "numeric" }); } }
  ];
  if (withApprover) f.push({ key: "appr", label: "Approved by", get: function (i) { return i.approvedBy; } });
  return f;
}
function finReimbRows(d, list, only) {
  var dept = "Accounting & Finance";
  return list.map(function (i) {
    var f = i.fields;
    // Non-managers can only move a request between Submitted and Finance checked.
    var open = ["submitted", "checked"];
    var pick = d.canWork && (d.manager || open.indexOf(i.status) !== -1) ? sfStatusPick(dept, i, true, d.manager ? only : open) : sfChip(i.kind, i.status);
    return '<tr class="' + (["paid", "rejected"].indexOf(i.status) !== -1 ? "done" : "") + '"><td>' + E(sfAge(i)) + "</td><td>" + E(i.by) + "</td>" +
      '<td class="sf-what"><b>' + E(f.description) + '</b><span class="co-note">Paid ' + E(fmtDate(f.spentOn)) + (f.notes ? " · " + E(f.notes) : "") + "</span>" + (sfFiles(i) ? '<span class="co-note">' + sfFiles(i) + "</span>" : "") +
      (i.reason ? '<span class="co-note">Reason given: ' + E(i.reason) + "</span>" : "") + "</td>" +
      '<td class="fb-num">' + E(sfAmount(f.amount, f.currency)) + "</td><td>" + pick +
      (i.approvedBy ? '<span class="co-note">Approved by ' + E(i.approvedBy) + "</span>" : "") + (i.paidBy ? '<span class="co-note">Paid by ' + E(i.paidBy) + "</span>" : "") + "</td>" +
      "<td>" + sfAssignPick(dept, i, d.canWork, d.people) + '</td><td class="notes-cell">' + sfNotes(dept, i, d.canWork) + "</td></tr>";
  });
}
function finReimbSection(title, note, statuses, only, scope, withApprover) {
  var c = sfDept("Accounting & Finance");
  if (c.error) return finSect(title, note) + '<div class="banner">' + E(c.error) + "</div>";
  if (!c.data) return finSect(title, note) + '<div class="empty">Loading reimbursements…</div>';
  var all = c.data.items.filter(function (i) { return i.kind === "reimburse" && statuses.indexOf(i.status) !== -1; })
    .sort(function (a, b) { return statuses.indexOf(a.status) - statuses.indexOf(b.status) || a.at - b.at; });
  var x = finFiltered(scope, finReimbFields(withApprover), all);
  return finSect(title, note) + x.ui +
    finTable(["Sent", "From", "What", "Amount", "Status", "Responsible", "Notes"], finReimbRows(c.data, x.list, only), 7, all.length ? "Nothing matches these filters." : "Nothing here.");
}
function finReimbCount(statuses) {
  var c = sfDept("Accounting & Finance");
  return c.data ? c.data.items.filter(function (i) { return i.kind === "reimburse" && statuses.indexOf(i.status) !== -1; }).length : 0;
}

// ---- Approvals ----
function renderFinanceApprovals() {
  var wait = financeReady();
  if (wait) return wait;
  var f = finance.data, mgr = isManager();
  setQuickAdd("Add payment", "fin:dailyPayments");
  var fields = [
    { key: "vendor", label: "Vendor", get: function (r) { return r.vendor; } },
    { key: "due", label: "Due", get: function (r) { return dueBucket(r.due); } },
    { key: "src", label: "Source", get: finSrc },
    { key: "by", label: "Added by", get: function (r) { return r.source === "pentagon" ? "Pentagon" : r.createdBy; } }
  ];
  var x = finFiltered("fin:daily", fields, f.dailyPayments);
  return '<div class="summary-cards four">' +
    metric("Bills to approve", money(sum(f.dailyPayments, "amount")), f.dailyPayments.length + " awaiting approval") +
    metric("Overdue bills", f.dailyPayments.filter(function (r) { return r.due && r.due < today; }).length, "Past their due date", f.dailyPayments.some(function (r) { return r.due && r.due < today; })) +
    metric("Reimbursements to check", finReimbCount(["submitted"]), "Sent by staff") +
    metric("Finance checked", finReimbCount(["checked"]), "Waiting to be approved to pay") + "</div>" +
    pgNote(f) + finBanner() +
    finSect("Daily payments", "Bills due. A manager ticks Approve and the row moves to Transfers → Approved to pay.", "dailyPayments", "Add payment") + x.ui +
    finTable(["Vendor", "Amount", "Due", "Notes", "Approve", ""], x.list.map(function (r) {
      return '<tr class="' + (r.due && r.due < today ? "overdue" : "") + '"><td>' + finCell("dailyPayments", r, "vendor", "text", "Vendor") + "</td><td>" + finCell("dailyPayments", r, "amount", "number", "0.00") + "</td><td>" + finCell("dailyPayments", r, "due", "date") +
        '</td><td class="notes-cell">' + finCell("dailyPayments", r, "notes", "textarea") + '</td><td class="center"><input class="check" type="checkbox" data-approve="' + E(r.id) + '"' + (mgr ? "" : " disabled") + ' aria-label="Approve payment to ' + E(r.vendor || "vendor") + '"></td><td>' + finDel("dailyPayments", r) + "</td></tr>";
    }), 6, f.dailyPayments.length ? "Nothing matches these filters." : "Nothing waiting for approval.") +
    finReimbSection("Reimbursements", "Staff send these from Finance → Staff-Facing with a receipt. Anyone in Finance marks them checked; a Finance manager approves them to pay (they move to Transfers) or rejects them with a reason the person sees.",
      ["submitted", "checked", "rejected"], ["submitted", "checked", "approved", "rejected"], "fin:reimb-approvals", false);
}

// ---- Transfers ----
function renderFinanceTransfers() {
  var wait = financeReady();
  if (wait) return wait;
  var f = finance.data, mgr = isManager();
  var fields = [
    { key: "vendor", label: "Vendor", get: function (r) { return r.vendor; } },
    { key: "due", label: "Due", get: function (r) { return dueBucket(r.due); } },
    { key: "paid", label: "Paid", get: function (r) { return r.paid ? "Paid" : "Not paid"; } },
    { key: "appr", label: "Approved by", get: function (r) { return r.approvedBy; } },
    { key: "src", label: "Source", get: finSrc }
  ];
  var x = finFiltered("fin:approved", fields, f.approvedToPay);
  var r = finFiltered("fin:receipts", [
    { key: "party", label: "Customer / vendor", get: function (x) { return x.party; } },
    { key: "exp", label: "Expected", get: function (x) { return dueBucket(x.expected); } },
    { key: "rec", label: "Received", get: function (x) { return x.received ? "Received" : "Not received"; } },
    { key: "src", label: "Source", get: finSrc }
  ], f.expectedReceipts);
  var unreceived = f.expectedReceipts.filter(function (x) { return !x.received; });
  return '<div class="summary-cards four">' +
    metric("Bills approved to pay", money(sum(f.approvedToPay.filter(function (r) { return !r.paid; }), "amount")), f.approvedToPay.filter(function (r) { return !r.paid; }).length + " not paid yet") +
    metric("Bills paid", f.approvedToPay.filter(function (r) { return r.paid; }).length, "Ticked paid") +
    metric("Reimbursements to pay", finReimbCount(["approved"]), "Approved to pay") +
    metric("Reimbursements paid", finReimbCount(["paid"]), "Marked paid") + "</div>" +
    pgNote(f) + finBanner() +
    finSect("Approved to pay", "Untick Approved to send a bill back to Approvals. Tick Paid once the transfer has gone.", "", "") + x.ui +
    finTable(["Vendor", "Amount", "Due", "Approved on", "Notes", "Approved", "Paid", ""], x.list.map(function (r) {
      return '<tr class="' + (r.paid ? "done" : "") + '"><td>' + finCell("approvedToPay", r, "vendor", "text", "Vendor") + "</td><td>" + finCell("approvedToPay", r, "amount", "number", "0.00") + "</td><td>" + finCell("approvedToPay", r, "due", "date") +
        '</td><td class="small-note">' + E(fmtTime(r.approvedAt)) + (r.approvedBy ? "<br>by " + E(r.approvedBy) : "") + '</td><td class="notes-cell">' + finCell("approvedToPay", r, "notes", "textarea") +
        '</td><td class="center"><input class="check" type="checkbox" checked data-unapprove="' + E(r.id) + '"' + (mgr ? "" : " disabled") + ' aria-label="Remove approval"></td><td class="center">' + finTick("approvedToPay", r, "paid", "Paid") + "</td><td>" + finDel("approvedToPay", r) + "</td></tr>";
    }), 8, f.approvedToPay.length ? "Nothing matches these filters." : "No approved payments yet.") +
    finReimbSection("Reimbursements", "Approved to pay, then Paid once the money has gone to the person. A Finance manager can send one back to Finance checked.",
      ["approved", "paid"], ["checked", "approved", "paid"], "fin:reimb-transfers", true) +
    // Expected receipts sit below Reimbursements (moved from Balances).
    finSect("Expected receipts", "Money coming in: who from, how much and when. " + money(sum(unreceived, "amount")) + " still to receive from " + unreceived.length + ".", "expectedReceipts", "Add receipt") + r.ui +
    finTable(["Customer / vendor", "Amount", "Expected", "Received", "Notes", ""], r.list.map(function (x) {
      return '<tr class="' + (x.received ? "done " : "") + (x.expected && !x.received && x.expected < today ? "overdue" : "") + '"><td>' + finCell("expectedReceipts", x, "party", "text", "Customer or vendor") + "</td><td>" + finCell("expectedReceipts", x, "amount", "number", "0.00") +
        "</td><td>" + finCell("expectedReceipts", x, "expected", "date") + '</td><td class="center">' + finTick("expectedReceipts", x, "received", "Received") + '</td><td class="notes-cell">' + finCell("expectedReceipts", x, "notes", "textarea") + "</td><td>" + finDel("expectedReceipts", x) + "</td></tr>";
    }), 6, f.expectedReceipts.length ? "Nothing matches these filters." : "No expected receipts yet.");
}

// ---- Balances ----
function renderFinanceBalances() {
  var wait = financeReady();
  if (wait) return wait;
  var f = finance.data;
  setQuickAdd("Add account", "fin:accounts");
  var a = finFiltered("fin:accounts", [
    { key: "name", label: "Account", get: function (r) { return r.name; } },
    { key: "src", label: "Source", get: finSrc }
  ], f.accounts);
  return '<div class="summary-cards">' +
    metric("Bank balances", money(sum(f.accounts, "balance")), "Across " + f.accounts.length + " account" + (f.accounts.length === 1 ? "" : "s")) + "</div>" +
    pgNote(f) + finBanner() +
    finSect("Bank accounts", f.pentagon ? "Balances from Pentagon, plus any entered by hand." : "Current balances, entered by hand.", "accounts", "Add account") + a.ui +
    finTable(["Account", "Balance", "As of", "Notes", ""], a.list.map(function (x) {
      return "<tr><td>" + finCell("accounts", x, "name", "text", "Account name") + "</td><td>" + finCell("accounts", x, "balance", "number", "0.00") + "</td><td>" + finCell("accounts", x, "asOf", "date") +
        '</td><td class="notes-cell">' + finCell("accounts", x, "notes", "textarea") + "</td><td>" + finDel("accounts", x) + "</td></tr>";
    }), 5, f.accounts.length ? "Nothing matches these filters." : "No accounts yet.");
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

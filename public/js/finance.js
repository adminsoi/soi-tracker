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
// A bill added from Bills from email: its invoice number and the file.
function finFromEmail(r) {
  if (!r.fromEmail) return "";
  return '<span class="co-note">' + (r.invoiceNo ? "#" + E(r.invoiceNo) + " · " : "") + '<button type="button" class="text-button" data-fbm-file="' + E(r.fromEmail) + '">📎 from email</button></span>';
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
    pgNote(f) + finBanner() + renderEmailBills() +
    finSect("Daily payments", "Bills due. A manager ticks Approve and the row moves to Transfers → Approved to pay.", "dailyPayments", "Add payment") + x.ui +
    finTable(["Vendor", "Amount", "Due", "Notes", "Approve", ""], x.list.map(function (r) {
      return '<tr class="' + (r.due && r.due < today ? "overdue" : "") + '"><td>' + finCell("dailyPayments", r, "vendor", "text", "Vendor") + finFromEmail(r) + "</td><td>" + finCell("dailyPayments", r, "amount", "number", "0.00") + "</td><td>" + finCell("dailyPayments", r, "due", "date") +
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
      return '<tr class="' + (r.paid ? "done" : "") + '"><td>' + finCell("approvedToPay", r, "vendor", "text", "Vendor") + finFromEmail(r) + "</td><td>" + finCell("approvedToPay", r, "amount", "number", "0.00") + "</td><td>" + finCell("approvedToPay", r, "due", "date") +
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

// ---- Bills from email (Approvals) ----
// Invoice emails found in the mailboxes set at /admin.html → Bills from
// email, read by Claude to fill in the details. Someone in Finance checks
// each one, then adds it to Daily payments, keeps it as paid (records only)
// or hides it. The emails and files stay in Outlook; Open file fetches the
// attachment through the tracker.
var fbm = { company: null, data: null, error: "", loading: false, timer: 0, busy: {} };
function loadEmailBills() {
  var co = activeCompany;
  fbm.loading = true;
  return api("/api/finance/email-bills?company=" + encodeURIComponent(co)).then(function (d) {
    fbm = Object.assign(fbm, { company: co, data: d, error: "", loading: false });
  }).catch(function (err) {
    fbm = Object.assign(fbm, { company: co, data: null, error: err.message, loading: false });
  }).then(function () {
    clearTimeout(fbm.timer);
    // Keep refreshing while the mailboxes are being checked or files read.
    var d = fbm.data;
    if (d && d.enabled && (d.scanning || d.items.some(function (i) { return i.read === "pending"; }))) {
      fbm.timer = setTimeout(function () { if (page === "department" && activeCompany === co) loadEmailBills().then(requestRender); }, 5000);
    }
  });
}
function fbmAgo(iso) {
  if (!iso) return "never";
  var m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : fmtDate(iso.slice(0, 10));
}
function fbmIn(i, b, key, type, ph) {
  var v = b[key];
  if (type === "number") v = v ? v : "";
  return '<input class="fb-in' + (type === "number" ? " fb-num" : "") + '" type="' + type + '"' + (type === "number" ? ' step="0.01" min="0"' : "") +
    ' data-fbm-in="' + E(i.id) + '" data-n="' + b.n + '" data-k="' + key + '" value="' + E(v) + '" placeholder="' + E(ph || "") + '" aria-label="' + E(ph || key) + '">';
}
function fbmBtn(i, b, op, label, cls) {
  var busy = fbm.busy[i.id + ":" + b.n];
  return '<button type="button" class="' + (cls || "") + ' fbm-btn" data-fbm-op="' + op + '" data-fbm-id="' + E(i.id) + '" data-n="' + b.n + '"' + (busy ? " disabled" : "") + ">" + label + "</button>";
}
function fbmSource(i) {
  return '<span class="fbm-when">' + E(fmtTime(i.receivedAt)) + "</span>" +
    '<b class="fbm-subj">' + E(i.subject) + "</b>" +
    '<span class="co-note">' + E(i.from.name || i.from.email) + (i.from.name && i.from.email ? " · " + E(i.from.email) : "") + " · in " + E(i.mailbox.split("@")[0]) + "</span>" +
    (i.file ? '<button type="button" class="text-button fbm-file" data-fbm-file="' + E(i.id) + '">📎 ' + E(i.file.name) + "</button>" : '<span class="co-note">List in the email text</span>');
}
function fbmKind(i) {
  return { ap_list: "AP list", statement: "Statement", receipt: "Receipt", not_a_bill: "Not a bill?" }[i.kind] || "";
}
function renderEmailBills() {
  if (activeCompany === ALL) return "";
  if (fbm.company !== activeCompany && !fbm.loading) { loadEmailBills().then(requestRender); return ""; }
  var d = fbm.data;
  if (fbm.error) return finSect("Bills from email", "") + '<div class="banner">' + E(fbm.error) + "</div>";
  if (!d || !d.enabled) return "";
  var last = Object.keys(d.scans).map(function (k) { return d.scans[k]; }).sort().pop();
  var errs = Object.keys(d.errors || {});
  var rows = [], kept = [], hidden = [], added = [], reading = 0;
  d.items.forEach(function (i) {
    if (i.read === "pending") { reading++; return; }
    var open = i.bills.filter(function (b) { return b.status === "new"; });
    open.forEach(function (b, k) {
      rows.push('<tr class="fbm-row' + (k === 0 ? " first" : "") + '">' +
        '<td class="fbm-src">' + (k === 0 ? fbmSource(i) + (fbmKind(i) ? '<span class="badge fbm-kind">' + fbmKind(i) + (open.length > 1 ? " · " + open.length + " bills" : "") + "</span>" : "") +
          (i.read === "error" ? '<span class="co-note warn">Couldn\'t read it automatically: ' + E(i.readError) + " Type the details in, or " + '<button type="button" class="text-button" data-fbm-op="reread" data-fbm-id="' + E(i.id) + '" data-n="0">try again</button>.</span>' : "") : "") + "</td>" +
        "<td>" + fbmIn(i, b, "vendor", "text", "Vendor") + (b.dupe ? '<span class="co-note warn">⚠ ' + E(b.dupe) + "</span>" : "") + "</td>" +
        "<td>" + fbmIn(i, b, "invoiceNo", "text", "Invoice #") + "</td>" +
        "<td>" + fbmIn(i, b, "amount", "number", "0.00") + (b.currency && b.currency !== "USD" ? '<span class="co-note">' + E(b.currency) + "</span>" : "") + "</td>" +
        "<td>" + fbmIn(i, b, "due", "date", "Due") + (b.invoiceDate ? '<span class="co-note">Invoice ' + E(fmtDate(b.invoiceDate)) + "</span>" : "") + "</td>" +
        '<td class="fbm-acts">' + fbmBtn(i, b, "add", "Add to bills", "primary") + fbmBtn(i, b, "paid", b.paid ? "Paid already ✓" : "Paid already") + fbmBtn(i, b, "dismiss", "Not a bill") +
          (k === open.length - 1 ? '<button type="button" class="text-button" data-fbm-op="addline" data-fbm-id="' + E(i.id) + '" data-n="0">+ another bill on this email</button>' : "") + "</td></tr>");
    });
    i.bills.forEach(function (b) {
      var line = { i: i, b: b };
      if (b.status === "paid") kept.push(line);
      else if (b.status === "dismissed") hidden.push(line);
      else if (b.status === "added") added.push(line);
    });
  });
  var undo = function (x, label) { return '<button type="button" class="text-button" data-fbm-op="reopen" data-fbm-id="' + E(x.i.id) + '" data-n="' + x.b.n + '">' + label + "</button>"; };
  var file = function (x) { return x.i.file ? '<button type="button" class="text-button" data-fbm-file="' + E(x.i.id) + '">📎 ' + E(x.i.file.name) + "</button>" : E(x.i.subject); };
  var by = function (x) { return '<span class="co-note">' + E(x.b.by || "") + (x.b.at ? " · " + E(fmtDate(x.b.at.slice(0, 10))) : "") + "</span>"; };
  var sub = function (title, list, head, row) {
    if (!list.length) return "";
    return '<details class="fbm-more"><summary>' + title + " (" + list.length + ")</summary>" +
      finTable(head, list.map(row), head.length, "") + "</details>";
  };
  var note = "Found in " + d.mailboxes.join(", ") + " · checked " + fbmAgo(last) + (d.scanning ? " · checking now…" : "") + (reading ? " · reading " + reading + " file" + (reading === 1 ? "" : "s") + "…" : "") +
    ". Claude fills in the details from the file — check them against the file, then add the bill or keep it as paid for the records.";
  return '<div class="section-title"><div><h2>Bills from email</h2><span class="small-note">' + E(note) + "</span></div>" +
      '<button type="button" data-fbm-scan="1"' + (d.scanning ? " disabled" : "") + ">" + (d.scanning ? "Checking…" : "Check now") + "</button></div>" +
    (errs.length ? '<div class="banner">' + errs.map(function (m) { return "<b>" + E(m) + ":</b> " + E(d.errors[m]); }).join("<br>") + "</div>" : "") +
    '<div class="table-wrap"><table class="narrow fbm-table"><thead><tr><th>Email</th><th>Vendor</th><th>Invoice #</th><th>Amount</th><th>Due</th><th></th></tr></thead><tbody>' +
    (rows.length ? rows.join("") : '<tr><td colspan="6" class="empty">' + (reading || d.scanning ? "Looking for invoices…" : "No new invoice emails.") + "</td></tr>") + "</tbody></table></div>" +
    sub("Kept as paid — for the records", kept, ["Vendor", "Invoice #", "Amount", "Invoice date", "File", "Marked by", ""], function (x) {
      return "<tr><td>" + E(x.b.vendor || "—") + "</td><td>" + E(x.b.invoiceNo || "—") + '</td><td class="fb-num">' + E(money(x.b.amount)) + "</td><td>" + (x.b.invoiceDate ? E(fmtDate(x.b.invoiceDate)) : "—") + "</td><td>" + file(x) + "</td><td>" + by(x) + "</td><td>" + undo(x, "Undo") + "</td></tr>";
    }) +
    sub("Added to Daily payments", added, ["Vendor", "Invoice #", "Amount", "File", "Added by", ""], function (x) {
      return "<tr><td>" + E(x.b.vendor || "—") + "</td><td>" + E(x.b.invoiceNo || "—") + '</td><td class="fb-num">' + E(money(x.b.amount)) + "</td><td>" + file(x) + "</td><td>" + by(x) + "</td><td>" + (x.b.rowGone ? undo(x, "Bring back") : '<span class="co-note">In Daily payments / Approved to pay</span>') + "</td></tr>";
    }) +
    sub("Hidden — not a bill", hidden, ["Email", "File", "Hidden by", ""], function (x) {
      return "<tr><td>" + E(x.i.subject) + '<span class="co-note">' + E(x.i.from.email) + "</span></td><td>" + file(x) + "</td><td>" + (x.b.auto ? '<span class="co-note">Claude: not a bill</span>' : by(x)) + "</td><td>" + undo(x, "Bring back") + "</td></tr>";
    });
}
function fbmOpenFile(id) {
  var w = window.open("", "_blank");
  fetch("/api/finance/email-bills/" + encodeURIComponent(id) + "/file", { headers: { Authorization: "Bearer " + token() } })
    .then(function (r) { if (!r.ok) return r.json().then(function (x) { throw new Error(x.error || "Couldn't open the file"); }); return r.blob(); })
    .then(function (b) { var u = URL.createObjectURL(b); if (w) w.location = u; else window.open(u, "_blank"); setTimeout(function () { URL.revokeObjectURL(u); }, 60000); })
    .catch(function (err) { if (w) w.close(); toast(err.message, true); });
}
function fbmFields(id, n) {
  var f = {};
  document.querySelectorAll('[data-fbm-in="' + id + '"][data-n="' + n + '"]').forEach(function (el) { f[el.getAttribute("data-k")] = el.value; });
  return f;
}
document.addEventListener("click", function (e) {
  var t = e.target.closest("[data-fbm-scan],[data-fbm-file],[data-fbm-op]");
  if (!t) return;
  if (t.hasAttribute("data-fbm-scan")) {
    if (fbm.data) fbm.data.scanning = true;
    render();
    api("/api/finance/email-bills/scan", { method: "POST", body: "{}" }).catch(function (err) { toast(err.message, true); })
      .then(loadEmailBills).then(render);
    return;
  }
  if (t.hasAttribute("data-fbm-file")) { fbmOpenFile(t.getAttribute("data-fbm-file")); return; }
  var id = t.getAttribute("data-fbm-id"), n = Number(t.getAttribute("data-n")), op = t.getAttribute("data-fbm-op");
  var key = id + ":" + n;
  if (fbm.busy[key]) return;
  var body = { op: op, n: n, fields: fbmFields(id, n) };
  fbm.busy[key] = true;
  var ok = { add: "Added to Daily payments", paid: "Kept as paid, for the records", dismiss: "Hidden", reopen: "Back in Bills from email", reread: "Reading it again…" }[op];
  api("/api/finance/email-bills/" + encodeURIComponent(id), { method: "POST", body: JSON.stringify(body) })
    .then(function () { if (ok) toast(ok); }, function (err) { toast(err.message, true); })
    .then(function () { delete fbm.busy[key]; return Promise.all([loadEmailBills(), op === "add" || op === "reopen" ? loadFinance() : null]); })
    .then(render);
});

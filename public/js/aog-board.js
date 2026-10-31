"use strict";
// AOG operations board and case files.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---------- Operations board ----------
// One board for Procurement, Purchasing and Warehouse. Each quote is a file:
// a heading (file no., platform(s), customer, Highlighted Items, due date,
// responsible person, on-time ✓ / ✗, and the Sales Order no. from Sale
// Received on) with its line items as rows underneath, moving left to right
// RFQ → Quoted → Sale Received → Purchased → Item Received → Item Sent. The
// server holds the rules (hard stops, approvals, who sees cost and margin);
// this draws the columns, the side panel (case file), the customer file and
// the settings. Pentagon documents not yet on a file show as files too; the
// first change to one stores it (brdReal).
var BOARD_DEPTS = ["Procurement", "Purchasing", "Warehouse"];
var brd = { data: null, at: 0, loading: false, error: "", retryIn: 15000, q: "", flag: "", person: "", colf: {}, colOpen: "", open: "", line: "", customer: "", settings: false, adding: false, draft: null, busy: false };
var BRD_FLAG = { overdue: ["Overdue", "bf-over"], due: ["Due", "bf-due"], approval: ["For approval", "bf-appr"], highlighted: ["Highlighted items", "bf-hi"], rejected: ["Quote rejected", "bf-rej"] };
var BRD_DOTS = [["due", "Due", "bd-due"], ["approval", "For approval", "bd-appr"], ["highlighted", "Highlighted", "bd-hi"], ["flagged", "Flagged", "bd-flag"]];
var BRD_DEPT_CLASS = { Procurement: "dp-proc", Purchasing: "dp-purch", Warehouse: "dp-wh" };
function canSeeBoardUi() { return me.fullAccess || me.leadership || BOARD_DEPTS.some(function (d) { return me.departments.indexOf(d) !== -1; }); }
function canAddRfq() { return me.fullAccess || me.leadership || me.departments.indexOf("Procurement") !== -1; }
// After an error, wait before asking again (15 s, doubling to 5 min) instead
// of asking on every render; Refresh / Try again asks straight away.
function loadBoard() {
  if (brd.loading) return;
  brd.loading = true;
  api("/api/board" + (activeCompany && activeCompany !== ALL ? "?company=" + encodeURIComponent(activeCompany) : ""))
    .then(function (d) { brd.data = d; brd.error = ""; brd.retryIn = 15000; }, function (err) { if (brd.error) brd.retryIn = Math.min(brd.retryIn * 2, 300000); brd.error = err.message; })
    .then(function () { brd.loading = false; brd.at = Date.now(); brd.co = activeCompany; requestRender(); if (brd.open) drawCaseFile(); });
}
function brdDue() {
  if (brd.loading) return false;
  if (brd.co !== activeCompany) return true;
  if (brd.error) return Date.now() - brd.at > brd.retryIn;
  return !brd.data || Date.now() - brd.at > 60000;
}
function brdCard(id) { return brd.data ? brd.data.cards.filter(function (c) { return c.id === id; })[0] : null; }
function brdPut(card) {
  var i = brd.data.cards.findIndex(function (c) { return c.id === card.id; });
  if (i === -1) brd.data.cards.push(card); else brd.data.cards[i] = card;
  render(); if (brd.open === card.id) drawCaseFile();
}
function brdStage(id) { return brd.data.stages.filter(function (s) { return s.id === id; })[0] || { label: id }; }
function brdStageAt(c) { return brd.data.stages.findIndex(function (s) { return s.id === c.stage; }); }
function brdLabel(c) {
  var n = c.fileNo || c.quoteNo || c.rfqNo;
  return n ? "File " + n : c.orderNo ? "SO " + c.orderNo : c.poNo ? "PO " + c.poNo : "New file (no number yet)";
}
// The Sales Order no. joins the heading from Sale Received on.
function brdSo(c) { return brdStageAt(c) >= 2 && c.orderNo && brdLabel(c) !== "SO " + c.orderNo ? c.orderNo : ""; }
// Row colour: the responsible person's department (this column's, if theirs).
function brdDeptOf(c) {
  var pd = brd.data.peopleDepts || {}, key = Object.keys(pd).filter(function (k) { return sameUser(k, c.assignee); })[0];
  var ds = key ? pd[key] : [], here = brdStage(c.stage).dept;
  return ds.indexOf(here) !== -1 ? here : ds[0] || "";
}
function brdFlaggedLines(c) { return (c.lines || []).filter(function (l) { return l.flagged; }); }
// Everything searchable in a file: heading, line items, notes, attachment
// names and links.
function brdText(c) {
  var out = [c.fileNo, c.rfqNo, c.quoteNo, c.orderNo, c.poNo, c.platforms, c.customer, c.vendor, c.assignee, c.dueDate, c.dueDate ? fmtDate(c.dueDate) : ""];
  (c.lines || []).forEach(function (l) { out.push(l.pn, l.desc, l.exportLicence, l.location, l.carrier, l.tracking); });
  (c.notes || []).forEach(function (x) { out.push(x.text, x.by, x.for); });
  (c.files || []).forEach(function (f) { out.push(f.name); });
  (c.links || []).forEach(function (l) { out.push(l.title, l.url, l.text); });
  return out.filter(Boolean).join(" \n ").toLowerCase();
}
function brdHas(c, f) { return c.flags.indexOf(f) !== -1 || (f === "due" && c.flags.indexOf("overdue") !== -1) || (f === "flagged" && brdFlaggedLines(c).length > 0); }
// Board-wide: search, the legend's flag and the person picker.
function brdMatch(c) {
  var q = brd.q.trim().toLowerCase();
  if (q && brdText(c).indexOf(q) === -1) return false;
  if (brd.flag && !brdHas(c, brd.flag)) return false;
  if (brd.person && !sameUser(c.assignee, brd.person)) return false;
  return true;
}
// Per column: every heading field, plus flagged / unflagged line items.
var BCF_FIELDS = ["fileNo", "platforms", "customer", "so", "hl", "due", "person", "onTime", "lines"];
function brdColMatch(c, f) {
  var has = function (v, q) { return !q || String(v || "").toLowerCase().indexOf(String(q).trim().toLowerCase()) !== -1; };
  if (!has([c.fileNo, c.rfqNo, c.quoteNo, c.poNo].join(" "), f.fileNo) || !has(c.platforms, f.platforms) || !has(c.customer || c.vendor, f.customer) || !has(c.orderNo, f.so)) return false;
  if (f.hl && (f.hl === "yes") !== !!c.hl) return false;
  if (f.person && (f.person === "-" ? !!c.assignee : !sameUser(c.assignee, f.person))) return false;
  if (f.onTime && (f.onTime === "open" ? c.onTime !== "" : c.onTime !== f.onTime)) return false;
  if (f.due) {
    var days = c.dueDate ? (Date.parse(c.dueDate + "T23:59:59") - Date.now()) / 86400000 : null;
    if (f.due === "none" ? days !== null : days === null || (f.due === "overdue" ? days >= 0 : f.due === "2" ? days < 0 || days >= 2 : days < 0 || days >= 7)) return false;
  }
  return true;
}
function brdLinesShown(c, f) {
  var lines = c.lines || [];
  if (f.lines === "flagged") return lines.filter(function (l) { return l.flagged; });
  if (f.lines === "unflagged") return lines.filter(function (l) { return !l.flagged; });
  return lines;
}
function brdColFilter(s) {
  var f = brd.colf[s.id] || {}, d = brd.data, n = BCF_FIELDS.filter(function (k) { return f[k]; }).length;
  var id = function (k) { return "bcf-" + s.id + "-" + k; };
  var txt = function (k, label) { return '<label for="' + id(k) + '">' + label + '</label><input id="' + id(k) + '" data-bcf="' + s.id + '" data-k="' + k + '" value="' + E(f[k] || "") + '" autocomplete="off">'; };
  var sel = function (k, label, opts) {
    return '<label for="' + id(k) + '">' + label + '</label><select id="' + id(k) + '" data-bcf="' + s.id + '" data-k="' + k + '">' + opts.map(function (o) { return '<option value="' + E(o[0]) + '"' + ((f[k] || "") === o[0] ? " selected" : "") + ">" + E(o[1]) + "</option>"; }).join("") + "</select>";
  };
  var later = d.stages.findIndex(function (x) { return x.id === s.id; }) >= 2;
  return '<details class="bcf" data-bcf-box="' + s.id + '"' + (brd.colOpen === s.id ? " open" : "") + '><summary title="Filter this column">Filter' + (n ? ' <span class="ib-n">' + n + "</span>" : "") + "</summary>" +
    '<div class="bcf-pop">' + txt("fileNo", "File no.") + txt("platforms", "Platform") + txt("customer", "Customer") + (later ? txt("so", "Sales Order no.") : "") +
    sel("hl", "Highlighted items", [["", "Any"], ["yes", "Ticked"], ["no", "Not ticked"]]) +
    sel("due", "Due", [["", "Any"], ["overdue", "Overdue"], ["2", "Within 2 days"], ["7", "Within a week"], ["none", "No due date"]]) +
    sel("person", "Responsible", [["", "Anyone"], ["-", "Nobody"]].concat(d.people.map(function (p) { return [p, p]; }))) +
    sel("onTime", "Quote on time", [["", "Any"], ["yes", "✓ On time"], ["no", "✗ Late"], ["open", "Not judged yet"]]) +
    sel("lines", "Line items", [["", "All"], ["flagged", "Flagged only"], ["unflagged", "Unflagged only"]]) +
    (n ? '<button type="button" class="text-button" data-bcf-clear="' + s.id + '">Clear filters</button>' : "") + "</div></details>";
}

function renderBoard(dept) {
  var qa = $("#quickAdd"); if (qa) qa.style.display = "none";
  if (brdDue()) loadBoard();
  var retry = '<button type="button" class="text-button" data-brd-refresh>Try again</button>';
  if (brd.error && !brd.data) return '<div class="banner">' + E(brd.error) + " " + (brd.loading ? "Trying again…" : retry) + "</div>";
  if (!brd.data) return '<div class="empty">Loading the board…</div>';
  var d = brd.data, all = d.cards, shown = all.filter(brdMatch);
  var count = function (f) { return all.filter(function (c) { return brdHas(c, f); }).length; };
  var legend = BRD_DOTS.map(function (f) {
    return '<button type="button" class="bd-leg' + (brd.flag === f[0] ? " active" : "") + '" data-brd-flag="' + (brd.flag === f[0] ? "" : f[0]) + '" title="' + (brd.flag === f[0] ? "Show everything" : "Show only " + f[1]) + '"><span class="bd ' + f[2] + '"></span>' + E(f[1]) + ' <span class="ib-n">' + count(f[0]) + "</span></button>";
  }).join("");
  var depts = '<span class="brd-depts" aria-label="Row colour: responsible person\'s department">' + BOARD_DEPTS.map(function (x) { return '<span class="brd-dkey ' + BRD_DEPT_CLASS[x] + '">' + E(shortDept(x)) + "</span>"; }).join("") + "</span>";
  var people = '<select id="brdPerson" aria-label="Responsible person"><option value="">Everyone</option>' + d.people.map(function (p) {
    return '<option value="' + E(p) + '"' + (sameUser(p, brd.person) ? " selected" : "") + ">" + E(p) + "</option>";
  }).join("") + "</select>";
  var head = (brd.error ? '<div class="banner">Couldn\'t refresh the board: ' + E(brd.error) + " " + retry + "</div>" : "") +
    ((d.pentagonErrors || []).length ? '<p class="small-note">Pentagon files not shown — ' + E(d.pentagonErrors.join("; ")) + "</p>" : "") +
    '<div class="brd-bar"><div class="brd-legend">' + legend + (brd.flag ? '<button type="button" class="text-button" data-brd-flag="">Show all</button>' : "") + depts + "</div>" +
    '<div class="brd-tools"><input type="search" id="brdSearch" placeholder="Search files, P/N, notes, attachments" value="' + E(brd.q) + '" aria-label="Search headings, line items, notes and attachment names">' +
    '<button type="button" data-brd-refresh title="Reload the board">Refresh</button>' + people +
    (d.can.settings ? '<button type="button" data-brd-settings>Stage managers</button>' : "") +
    (canAddRfq() ? '<button type="button" class="primary" data-brd-new>+ Add file</button>' : "") + "</div></div>";
  var cols = d.stages.map(function (s) {
    var f = brd.colf[s.id] || {};
    var list = shown.filter(function (c) { return c.stage === s.id && brdColMatch(c, f); })
      .filter(function (c) { return !f.lines || brdLinesShown(c, f).length; })
      .sort(function (a, b) { return String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")) || b.updatedAt - a.updatedAt; });
    return '<section class="brd-col st-' + E(s.colour || "blue") + (s.dept === dept ? " mine" : "") + '" aria-label="' + E(s.label) + '"><header><div class="brd-colt"><b>' + E(s.label) + "</b>" + brdColFilter(s) + "</div>" +
      '<span class="brd-mgr" title="Files moved here are assigned to ' + E(d.managers[s.id] || "nobody yet") + '">' + list.length + " file" + (list.length === 1 ? "" : "s") + " · " + E(d.managers[s.id] || s.dept) + "</span></header>" +
      (list.length ? list.map(function (c) { return brdFileHtml(c, f); }).join("") : '<div class="brd-empty">Nothing here</div>') + "</section>";
  }).join("");
  return head + '<div class="brd-cols">' + cols + "</div>" +
    '<p class="small-note brd-cap">Click a heading or a line item for the file\'s documents, notes and history. Moving a file on assigns it to that stage\'s manager. Hard stops: sourcing ✓ before Quoted, quote ✓ and Sales Order no. before Sale Received, purchase ✓ and export licence field on every line before Purchased, location and date in before Item Received, quality sign-off before Item Sent. Numbers, certificates and licences come from Pentagon or source documents — the tracker never makes them up.</p>' +
    (brd.adding ? brdNewForm() : "");
}
function brdFileHtml(c, f) {
  var lines = brdLinesShown(c, f), hidden = (c.lines || []).length - lines.length, so = brdSo(c), dp = brdDeptOf(c);
  var ot = c.onTime === "yes" ? '<span class="of-ot ot-yes" title="Quote completed on time">✓</span>' : c.onTime === "no" ? '<span class="of-ot ot-no" title="Quote late">✗</span>' : '<span class="of-ot ot-open" title="Quote on time: not judged yet">–</span>';
  var hl = '<span class="of-hl' + (c.hl ? " on" : "") + '" role="img" aria-label="Highlighted items: ' + (c.hl ? "yes" : "no") + '" title="Highlighted items (ticked when any line item is)"><span class="of-box">' + (c.hl ? "✓" : "") + "</span>HL</span>";
  var flags = c.flags.filter(function (x) { return x === "overdue" || x === "due" || x === "approval" || x === "rejected"; }).map(function (x) { var b = BRD_FLAG[x]; return '<span class="bf ' + b[1] + '">' + b[0] + "</span>"; }).join("");
  return '<div class="of-file' + (dp ? " " + BRD_DEPT_CLASS[dp] : "") + (c.virtual ? " of-pg" : "") + (brd.open === c.id ? " open" : "") + '">' +
    '<button type="button" class="of-head" data-brd-open="' + E(c.id) + '" title="' + E(dp ? "Responsible person's department: " + dp : "Open the file") + '">' +
      '<span class="of-r1"><b class="of-no">' + E(brdLabel(c)) + "</b>" + (so ? '<span class="of-so">SO ' + E(so) + "</span>" : "") + '<span class="grow"></span>' + hl + ot + "</span>" +
      '<span class="of-r2">' + (c.platforms ? '<span class="of-plat">' + E(c.platforms) + "</span>" : "") + '<span class="of-cust">' + E(c.customer || c.vendor || "No customer yet") + (activeCompany === ALL ? " · " + E(shortCo(c.company)) : "") + "</span></span>" +
      '<span class="of-r3"><span class="co-note">' + (c.dueDate ? "Due " + E(fmtDate(c.dueDate)) : "No due date") + "</span>" + flags + '<span class="grow"></span>' +
        (c.assignee ? '<span class="av" aria-hidden="true">' + E(initialsOf(c.assignee)) + '</span><span class="of-who">' + E(c.assignee) + "</span>" : '<span class="co-note">Nobody</span>') + "</span>" +
      (c.virtual ? '<span class="of-pgnote">From Pentagon</span>' : "") +
    "</button>" +
    '<div class="of-lines">' + (lines.length ? lines.map(function (l) {
      return '<div class="of-line' + (l.flagged ? " flagged" : "") + (brd.open === c.id && brd.line === l.id ? " picked" : "") + '">' +
        '<button type="button" class="of-flag" data-brd-flagline="' + E(c.id) + '" data-lid="' + E(l.id) + '" aria-pressed="' + !!l.flagged + '" title="' + (l.flagged ? "Flagged" + (l.flaggedBy ? " by " + E(l.flaggedBy) : "") + " — click to unflag" : "Flag for discussion") + '">⚑</button>' +
        '<button type="button" class="of-lbtn" data-brd-open="' + E(c.id) + '" data-line="' + E(l.id) + '"><span class="of-pn">' + E(l.pn || "No P/N") + "</span>" +
          (l.qty && l.qty !== 1 ? '<span class="co-note">×' + E(l.qty) + "</span>" : "") + (l.desc ? '<span class="of-desc">' + E(l.desc) + "</span>" : "") +
          (l.highlighted ? '<span class="bd bd-hi" title="Highlighted: not found online"></span>' : "") + "</button></div>";
    }).join("") : '<div class="of-noline">' + ((c.lines || []).length ? "" : "No line items yet") + "</div>") +
    (hidden > 0 ? '<div class="of-noline">+' + hidden + " other line" + (hidden === 1 ? "" : "s") + "</div>" : "") + "</div></div>";
}

// + Add file (Procurement). Numbers are typed from Pentagon, never made up.
function brdNewForm() {
  var f = brd.draft || (brd.draft = { company: activeCompany !== ALL ? activeCompany : myCompanies()[0], customer: "", fileNo: "", rfqNo: "", quoteNo: "", platforms: "", dueDate: "", pn: "", desc: "", qty: 1, highlighted: false });
  var field = function (k, label, extra) { return '<div class="nb-field"><label for="bn-' + k + '">' + label + '</label><input id="bn-' + k + '" data-bn="' + k + '" value="' + E(f[k]) + '" autocomplete="off"' + (extra || "") + "></div>"; };
  return '<div class="rs-modal" data-brd-modal="new"><div class="rs-card rs-wide" role="dialog" aria-modal="true" aria-labelledby="brdNewT"><h3 id="brdNewT">Add a file</h3>' +
    '<div class="grid-2" style="gap:0 14px;">' +
    (activeCompany === ALL ? '<div class="nb-field"><label for="bn-company">Company</label><select id="bn-company" data-bn="company">' + myCompanies().map(function (c) { return "<option" + (c === f.company ? " selected" : "") + ' value="' + E(c) + '">' + E(shortCo(c)) + "</option>"; }).join("") + "</select></div>" : "") +
    field("customer", "Customer") + field("platforms", "Platform(s)", ' placeholder="e.g. C-130H"') +
    field("fileNo", "File no. (if there is one)") + field("rfqNo", "RFQ no. (from Pentagon)") + field("quoteNo", "Quote no. (from Pentagon)") +
    '<div class="nb-field"><label for="bn-dueDate">Due</label><input id="bn-dueDate" type="date" data-bn="dueDate" value="' + E(f.dueDate) + '"></div>' +
    field("pn", "First line item: P/N") + field("desc", "Description") +
    '<div class="nb-field"><label for="bn-qty">Qty</label><input id="bn-qty" type="number" min="1" data-bn="qty" value="' + E(f.qty) + '"></div></div>' +
    '<label class="small-note" style="display:flex;gap:7px;align-items:center;"><input type="checkbox" class="check" data-bn="highlighted"' + (f.highlighted ? " checked" : "") + "> Highlighted: this part can't be found online (Google, ILS, PartsBase, Locatory)</label>" +
    '<div class="nb-foot" style="margin-top:14px;"><span class="small-note">It starts in RFQ, assigned to ' + E(brd.data.managers.rfq || "you") + '. Pentagon RFQs show up on their own.</span><span class="grow"></span><button type="button" class="text-button" data-brd-close>Cancel</button><button type="button" class="primary" data-brd-create' + (brd.busy ? " disabled" : "") + ">Add file</button></div></div></div>";
}

// The side panel (the file's case file), opened from a heading or a line item.
function brdModal(html) {
  var box = $("#brdModal");
  if (!box) { box = document.createElement("div"); box.id = "brdModal"; document.body.appendChild(box); }
  box.innerHTML = html;
  return box;
}
function closeBrdModal() { var was = brd.open; brd.open = ""; brd.line = ""; brd.customer = ""; brd.settings = false; brd.lineDraft = null; var b = $("#brdModal"); if (b) b.remove(); if (was) render(); }
function drawCaseFile() {
  var c = brdCard(brd.open);
  if (!c) { closeBrdModal(); return; }
  var d = brd.data, can = d.can, si = d.stages.findIndex(function (s) { return s.id === c.stage; });
  var lines = brd.lineDraft || (brd.lineDraft = JSON.parse(JSON.stringify(c.lines || [])));
  var showFrom = function (stage) { return si >= d.stages.findIndex(function (s) { return s.id === stage; }); };
  var cols = [["flagged", "Flag", "flag"], ["pn", "P/N", "text"], ["desc", "Description", "text"], ["qty", "Qty", "number"], ["highlighted", "Highlighted", "check"]]
    .concat(can.cost ? [["cost", "Cost", "number"], ["markup", "Mark-up %", "number"]] : [])
    .concat([["price", "Price", "number"]])
    .concat(can.margin ? [["margin", "Margin", "ro"]] : [])
    .concat(showFrom("sale") ? [["exportLicence", "Export licence", "text"]] : [])
    .concat(showFrom("purchased") ? [["location", "Location", "text"], ["dateIn", "Date in", "date"], ["listOnWebsite", "Website", "check"], ["qualityOk", "Quality ✓", "check"]] : [])
    .concat(showFrom("received") ? [["carrier", "Carrier", "text"], ["tracking", "Tracking", "text"]] : []);
  var cell = function (l, i, col) {
    var k = col[0], v = l[k];
    if (col[2] === "ro") return "<td>" + (v == null ? "—" : E(v) + "%") + "</td>";
    if (col[2] === "flag") return '<td class="center">' + (l.id ? '<button type="button" class="of-flag" data-brd-flagline="' + E(c.id) + '" data-lid="' + E(l.id) + '" aria-pressed="' + !!v + '" title="' + (v ? "Flagged" + (l.flaggedBy ? " by " + E(l.flaggedBy) : "") : "Flag for discussion") + '">⚑</button>' : "") + "</td>";
    if (col[2] === "check") return '<td class="center"><input type="checkbox" class="check" data-bl="' + i + '" data-k="' + k + '"' + (v ? " checked" : "") + (k === "qualityOk" && !can.quality ? " disabled title=\"Warehouse manager signs off quality\"" : "") + (k === "highlighted" ? ' title="Can\'t be found online (Google, ILS, PartsBase, Locatory)"' : "") + "></td>";
    return '<td><input type="' + (col[2] === "date" ? "date" : col[2] === "number" ? "number" : "text") + '" data-bl="' + i + '" data-k="' + k + '" value="' + E(v == null ? "" : v) + '"' + (col[2] === "number" ? ' min="0" step="any"' : "") + (k === "exportLicence" ? ' placeholder="As on the source document"' : "") + "></td>";
  };
  var kind = d.approvals[c.stage], appr = kind ? (c.approvals || {})[kind] || {} : null;
  var checks = function (stage, title) {
    return '<div class="brd-checks"><div class="card-label">' + title + "</div>" + (d.checks[stage] || []).map(function (ch) {
      return '<label><input type="checkbox" class="check" data-brd-check="' + ch.id + '"' + ((c.checks || {})[ch.id] ? " checked" : "") + "> " + E(ch.label) + "</label>";
    }).join("") + "</div>";
  };
  var next = c.next ? brdStage(c.next) : null;
  var fld = function (k, label, ph) { return '<div class="nb-field"><label for="bf-' + k + '">' + label + '</label><input id="bf-' + k + '" data-brd-f="' + k + '" value="' + E(c[k] || "") + '"' + (ph ? ' placeholder="' + E(ph) + '"' : "") + "></div>"; };
  var ot = c.onTime === "yes" ? "✓ Quote done on time" : c.onTime === "no" ? "✗ Quote late" : c.dueDate ? "Not judged yet" : "No due date to judge by";
  var html = '<div class="rs-modal brd-side-wrap" data-brd-modal="case"><div class="rs-card brd-case brd-side" role="dialog" aria-modal="true" aria-labelledby="brdCaseT">' +
    '<div class="brd-case-head"><div><div class="eyebrow">' + E(shortCo(c.company)) + " · " + E(brdStage(c.stage).label) + (c.archived ? " · Archived" : "") + (c.virtual ? " · From Pentagon" : "") + '</div><h3 id="brdCaseT">' + E(brdLabel(c)) + (brdSo(c) ? " · SO " + E(brdSo(c)) : "") + "</h3>" +
    (c.customer ? '<button type="button" class="text-button" data-brd-customer="' + E(c.customer) + '">' + E(c.customer) + " — customer file</button>" : c.vendor ? '<span class="small-note">Vendor: ' + E(c.vendor) + "</span>" : "") + "</div>" +
    '<button type="button" class="text-button" data-brd-close aria-label="Close">Close ✕</button></div>' +
    (c.virtual ? '<p class="small-note brd-pgnote">This file comes from Pentagon and isn\'t stored yet. Your first change (a note, a file, a flag, a move) puts it on the board.</p>' : "") +
    '<div class="brd-flags">' + c.flags.map(function (f) { var x = BRD_FLAG[f]; return x ? '<span class="bf ' + x[1] + '">' + x[0] + "</span>" : ""; }).join("") +
      '<span class="bf ' + (c.onTime === "yes" ? "bf-ok" : c.onTime === "no" ? "bf-over" : "bf-none") + '">' + E(ot) + "</span></div>" +
    '<div class="brd-grid">' +
      fld("fileNo", "File no.") + fld("rfqNo", "RFQ no.", "From Pentagon") + fld("quoteNo", "Quote no.", "From Pentagon") +
      fld("orderNo", "Sales Order no.", "From Pentagon, at Sale Received") + fld("poNo", "PO no.", "From Pentagon") + fld("customer", "Customer") +
      fld("platforms", "Platform(s)") +
      '<div class="nb-field"><label for="bf-dueDate">Due</label><input id="bf-dueDate" type="date" data-brd-f="dueDate" value="' + E(c.dueDate || "") + '"></div>' +
      '<div class="nb-field"><label for="bf-assignee">Responsible</label>' + (can.assign ? '<select id="bf-assignee" data-brd-f="assignee"><option value="">Nobody</option>' + d.people.map(function (p) { return '<option value="' + E(p) + '"' + (sameUser(p, c.assignee) ? " selected" : "") + ">" + E(p) + "</option>"; }).join("") + "</select>" : '<div class="static">' + E(c.assignee || "—") + "</div>") + "</div>" +
      '<div class="nb-field"><label>Highlighted items</label><div class="static">' + (c.hl ? "☑ Yes" : "☐ None") + (c.highlighted ? ' <button type="button" class="text-button" data-brd-unhl>clear (whole-file mark from the old board)</button>' : "") + '</div></div>' +
    "</div>" +
    '<div class="card-label" style="margin-top:12px;">Line items' + (c.total ? " · quote total " + E(money(c.total)) : "") + "</div>" +
    '<div class="table-wrap"><table class="plain brd-lines"><thead><tr>' + cols.map(function (x) { return "<th>" + E(x[1]) + "</th>"; }).join("") + "<th></th></tr></thead><tbody>" +
      lines.map(function (l, i) { return '<tr' + (l.id && l.id === brd.line ? ' class="picked"' : "") + ">" + cols.map(function (col) { return cell(l, i, col); }).join("") + '<td><button type="button" class="text-button" data-brd-rmline="' + i + '" title="Remove line">✕</button></td></tr>'; }).join("") +
    "</tbody></table></div>" +
    '<div class="nb-foot"><button type="button" class="text-button" data-brd-addline>+ Add line</button><span class="grow"></span><button type="button" class="primary" data-brd-savelines>Save lines</button></div>' +
    brdCaseBox(c) +
    (si <= 1 ? checks("rfq", "Black file — sourcing checks") : "") +
    (si >= 2 && si <= 3 ? checks("sale", "Red file — before the purchase goes for approval") : "") +
    (kind ? '<div class="brd-approval"><div class="card-label">' + E({ sourcing: "Sourcing approval", quote: "Quote approval", purchase: "Purchase approval" }[kind]) + "</div>" +
      (appr.state ? '<p class="small-note">' + (appr.state === "approved" ? "✓ Approved" : "✗ Rejected") + " by " + E(appr.by) + " · " + E(new Date(appr.at).toLocaleString()) + (appr.note ? " — " + E(appr.note) : "") + "</p>" : "") +
      (c.approvalBlockers[kind].length ? '<p class="small-note">Not ready for approval: ' + E(c.approvalBlockers[kind].join("; ")) + ".</p>"
        : '<div class="brd-appr-row"><input id="brdApprNote" placeholder="Note (optional — say why if rejecting)"><button type="button" class="st-btn st-done" data-brd-approve="' + kind + '">✓ Approve</button><button type="button" class="st-btn st-del" data-brd-reject="' + kind + '">✗ Reject</button></div>') + "</div>" : "") +
    '<div class="brd-move">' + (si > 0 ? '<button type="button" class="text-button" data-brd-move="' + d.stages[si - 1].id + '">← Back to ' + E(d.stages[si - 1].label) + "</button>" : "") + '<span class="grow"></span>' +
      (next ? (c.moveBlockers.length ? '<span class="small-note">Before ' + E(next.label) + ": " + E(c.moveBlockers.join("; ")) + "</span>" : "") +
        '<button type="button" class="primary" data-brd-move="' + next.id + '"' + (c.moveBlockers.length ? " disabled" : "") + ">Move to " + E(next.label) + " →</button>" : '<span class="small-note">Shipped.</span>') + "</div>" +
    '<details class="brd-hist"><summary>History (' + (c.history || []).length + ")</summary>" + (c.history || []).slice().reverse().map(function (h) { return '<div class="small-note">' + E(new Date(h.at).toLocaleString()) + " · <b>" + E(h.by) + "</b> · " + E(h.what) + "</div>"; }).join("") + "</details>" +
    (can.assign ? '<div class="nb-foot" style="margin-top:10px;"><span class="grow"></span><button type="button" class="text-button" data-brd-archive="' + (c.archived ? "0" : "1") + '">' + (c.archived ? "Restore file" : "Archive file") + "</button></div>" : "") +
    "</div></div>";
  var scroll = $("#brdModal .brd-side"), top = scroll ? scroll.scrollTop : 0;
  brdModal(html);
  var side = $("#brdModal .brd-side");
  if (side) { side.scrollTop = top; var pk = brd.lineJump && side.querySelector("tr.picked"); if (pk) pk.scrollIntoView({ block: "center" }); }
  brd.lineJump = false;
}

// The case file box: Notes · Pictures · PDFs · Websites · Emails · Teams ·
// + Add. Files and links carry the stage they were added in: RFQ / Quoted
// make up the black file (sourcing), Sale on the red file (the order).
var BRD_TABS = [["notes", "Notes"], ["picture", "Pictures"], ["pdf", "PDFs"], ["website", "Websites"], ["email", "Emails"], ["teams", "Teams"], ["add", "+ Add"]];
function brdFileOf(x) { return ["rfq", "quoted"].indexOf(x.stage) !== -1 ? '<span class="bk-file">Black file</span>' : x.stage ? '<span class="rd-file">Red file</span>' : ""; }
function brdCaseBox(c) {
  var tab = brd.tab || "notes", d = brd.data;
  var files = (c.files || []).filter(function (f) { return (f.kind || "other") === tab; });
  var links = (c.links || []).filter(function (l) { return l.kind === tab; });
  var n = function (k) { return k === "notes" ? (c.notes || []).length : k === "add" ? 0 : (c.files || []).filter(function (f) { return (f.kind || "other") === k; }).length + (c.links || []).filter(function (l) { return l.kind === k; }).length; };
  var tabs = '<div class="cf-tabs" role="tablist">' + BRD_TABS.map(function (t) {
    var k = n(t[0]);
    return '<button type="button" role="tab" class="cf-tab' + (tab === t[0] ? " active" : "") + '" aria-selected="' + (tab === t[0]) + '" data-brd-tab="' + t[0] + '">' + E(t[1]) + (k ? ' <span class="ib-n">' + k + "</span>" : "") + "</button>";
  }).join("") + "</div>";
  var fileRow = function (f) { return '<div class="brd-file"><button type="button" class="text-button" data-brd-dl="' + E(f.id) + '">' + E(f.name) + "</button>" + brdFileOf(f) + '<span class="co-note">' + E(f.by) + " · " + E(new Date(f.at).toLocaleDateString()) + "</span></div>"; };
  var linkRow = function (l) {
    var href = safeLink(l.url);
    return '<div class="cf-link">' + (href ? '<a href="' + E(href) + '" target="_blank" rel="noopener noreferrer">' + E(l.title || l.url) + " ↗</a>" : "<b>" + E(l.title || "Pasted in") + "</b>") + brdFileOf(l) +
      '<span class="co-note">' + E(l.by) + " · " + E(new Date(l.at).toLocaleDateString()) + "</span>" + (l.text ? '<div class="cf-text">' + E(l.text) + "</div>" : "") + "</div>";
  };
  var upload = function (kind, label, accept) { return '<button type="button" data-brd-upload="' + kind + '"' + (accept ? ' data-accept="' + accept + '"' : "") + ">" + label + "</button>"; };
  var linkForm = function (kind, ph) {
    return '<div class="cf-linkform"><input id="cfTitle" placeholder="Title (optional)"><input id="cfUrl" placeholder="' + E(ph) + '"><textarea id="cfText" rows="2" placeholder="' + (kind === "website" ? "What it shows (optional)" : "Paste the message text (optional)") + '"></textarea>' +
      '<button type="button" data-brd-link="' + kind + '">Add</button></div>';
  };
  var body;
  if (tab === "notes") {
    body = (c.notes || []).slice().reverse().map(function (x) {
      return '<div class="itr-note' + (x.manager ? " brd-mnote" : "") + '"><b>' + (x.manager ? "Manager feedback · " : "") + E(x.by) + "</b>" + (x.for ? " → " + E(x.for) : "") + (x.due ? ' · <span class="bf bf-due">Due ' + E(fmtDate(x.due)) + "</span>" : "") +
        " · " + E(new Date(x.at).toLocaleString()) + "<br>" + E(x.text) + "</div>";
    }).join("") +
      '<textarea id="brdNote" rows="3" placeholder="Add a note: what was found, what still needs doing to complete the file…"></textarea>' +
      (d.can.assign ? '<div class="brd-mgrnote"><label class="small-note"><input type="checkbox" class="check" id="brdNoteMgr"> Manager feedback / next step for</label>' +
        '<select id="brdNoteFor" aria-label="For"><option value="">' + E(c.assignee ? c.assignee + " (responsible)" : "Nobody") + "</option>" + d.people.filter(function (p) { return !sameUser(p, c.assignee); }).map(function (p) { return '<option value="' + E(p) + '">' + E(p) + "</option>"; }).join("") + "</select>" +
        '<label class="small-note" for="brdNoteDue">deadline</label><input type="date" id="brdNoteDue"></div><p class="small-note" style="margin:4px 0 0;">Feedback for someone also goes on their Mentions of You as a task (with the deadline).</p>' : "") +
      '<div class="nb-foot"><span class="grow"></span><button type="button" data-brd-note>Add note</button></div>';
  } else if (tab === "add") {
    body = '<p class="small-note">Add anything to this case file:</p><div class="cf-adds">' + upload("picture", "Pictures", "image/*") + upload("pdf", "PDFs or invoices", ".pdf") + upload("website", "Website screenshots", "image/*,.pdf") + upload("email", "Saved emails (.msg / .eml)", ".msg,.eml") + upload("other", "Other files", "") + "</div>" +
      ((c.files || []).filter(function (f) { return f.kind === "other" || !f.kind; }).map(fileRow).join("") || "");
  } else {
    var empty = { picture: "No pictures yet.", pdf: "No PDFs or invoices yet.", website: "No websites yet.", email: "No emails yet.", teams: "No Teams messages yet." }[tab];
    body = (files.length || links.length ? links.map(linkRow).join("") + files.map(fileRow).join("") : '<p class="small-note">' + empty + "</p>") +
      (tab === "picture" ? upload("picture", "+ Add pictures", "image/*") : tab === "pdf" ? upload("pdf", "+ Add PDFs / invoices", ".pdf") :
        tab === "website" ? linkForm("website", "https://… (the listing or page)") + upload("website", "+ Add a screenshot", "image/*,.pdf") :
        tab === "email" ? upload("email", "+ Add saved emails (.msg / .eml)", ".msg,.eml") + linkForm("email", "Outlook link (optional)") :
        linkForm("teams", "Teams message link (optional)"));
  }
  return '<div class="cf-box"><div class="cf-head"><b>Documents and notes</b><span class="small-note">Saved to AWS, one folder per file; the black file (sourcing) and red file (order) are built from it.</span></div>' + tabs +
    '<div class="cf-body">' + body + "</div>" +
    '<input type="file" id="brdFile" multiple hidden><p class="small-note" style="margin:8px 0 0;">Don\'t add export-controlled technical data until the compliance lead confirms this storage. Certificate and approval references are copied from source documents, never made up.</p></div>';
}

// Customer file: their RFQs and orders, and documents (export licences, certificates…).
function drawCustomerFile() {
  var name = brd.customer, d = brd.data;
  var mine = d.cards.filter(function (c) { return String(c.customer || "").toLowerCase() === name.toLowerCase(); }).sort(function (a, b) { return b.createdAt - a.createdAt; });
  var files = ((d.customers || {})[name] || {}).files || [];
  brdModal('<div class="rs-modal" data-brd-modal="customer"><div class="rs-card rs-wide" role="dialog" aria-modal="true" aria-labelledby="brdCustT">' +
    '<div class="brd-case-head"><div><div class="eyebrow">Customer file</div><h3 id="brdCustT">' + E(name) + '</h3></div><button type="button" class="text-button" data-brd-close>Close ✕</button></div>' +
    '<div class="card-label">RFQs and orders (' + mine.length + ")</div>" +
    '<div class="table-wrap"><table class="plain"><thead><tr><th>Card</th><th>Stage</th><th>P/N</th><th>Total</th><th>Created</th></tr></thead><tbody>' +
    (mine.length ? mine.map(function (c) { return '<tr><td><button type="button" class="text-button" data-brd-open="' + E(c.id) + '">' + E(brdLabel(c)) + "</button></td><td>" + E(brdStage(c.stage).label) + "</td><td>" + E((c.lines || []).map(function (l) { return l.pn; }).filter(Boolean).join(", ") || "—") + "</td><td>" + (c.total ? E(money(c.total)) : "—") + "</td><td>" + E(new Date(c.createdAt).toLocaleDateString()) + "</td></tr>"; }).join("") : '<tr><td colspan="5" class="empty">Nothing you can see yet.</td></tr>') +
    "</tbody></table></div>" +
    '<div class="card-label" style="margin-top:14px;">Documents</div>' +
    (files.length ? files.map(function (f) { return '<div class="brd-file"><button type="button" class="text-button" data-brd-cdl="' + E(f.id) + '">' + E(f.name) + '</button><span class="co-note">' + E(f.by) + " · " + E(new Date(f.at).toLocaleDateString()) + "</span></div>"; }).join("") : '<p class="small-note">No documents yet — add export licences, certificates and the like.</p>') +
    '<input type="file" id="brdCFile" multiple hidden><button type="button" data-brd-cupload>+ Add documents</button></div></div>');
}

// Stage managers (full-access and leadership).
function drawBoardSettings() {
  var d = brd.data, s = d.settings || { managers: {}, globalManager: "", bigTicket: 25000 };
  var pick = function (id, val, blank) { return '<select id="' + id + '"><option value="">' + E(blank) + "</option>" + d.people.map(function (p) { return '<option value="' + E(p) + '"' + (sameUser(p, val) ? " selected" : "") + ">" + E(p) + "</option>"; }).join("") + "</select>"; };
  brdModal('<div class="rs-modal" data-brd-modal="settings"><div class="rs-card rs-wide" role="dialog" aria-modal="true" aria-labelledby="brdSetT"><h3 id="brdSetT">Stage managers</h3>' +
    '<p class="small-note">A card moved into a column is assigned to its manager, who approves it there. Blank uses the department default from /admin.html.</p>' +
    '<div class="grid-2" style="gap:0 14px;">' + d.stages.map(function (st) { return '<div class="nb-field"><label>' + E(st.label) + " (" + E(st.dept) + ")</label>" + pick("bs-" + st.id, s.managers[st.id], "Department default") + "</div>"; }).join("") +
    '<div class="nb-field"><label>Global manager (big-ticket rejections)</label>' + pick("bs-global", s.globalManager, "Nobody") + "</div>" +
    '<div class="nb-field"><label>Big-ticket quote, USD and up</label><input id="bs-big" type="number" min="1" value="' + E(s.bigTicket) + '"></div></div>' +
    '<div class="nb-foot" style="margin-top:12px;"><span class="grow"></span><button type="button" class="text-button" data-brd-close>Cancel</button><button type="button" class="primary" data-brd-savesettings>Save</button></div></div></div>');
}

// A Pentagon file isn't stored until someone works on it: store it first,
// then carry on with the stored file's id.
function brdReal(id) {
  if (String(id).indexOf("pg:") !== 0) return Promise.resolve(id);
  return api("/api/board/adopt", { method: "POST", body: JSON.stringify({ id: id }) }).then(function (card) {
    brd.data.cards = brd.data.cards.filter(function (c) { return c.id !== id; });
    if (brd.open === id) brd.open = card.id;
    brdPut(card);
    return card.id;
  }, function (err) { toast(err.message, true); throw err; });
}
function brdApi(id, path, body, method) {
  return brdReal(id).then(function (rid) {
    return api("/api/board/" + encodeURIComponent(rid) + path, { method: method || "POST", body: JSON.stringify(body || {}) })
      .then(function (card) { if (card && card.id) brdPut(card); return card; }, function (err) { toast(err.message, true); throw err; });
  });
}
function brdDownload(url, name) {
  fetch(url, { headers: { Authorization: "Bearer " + token() } })
    .then(function (r) { if (!r.ok) throw new Error("Couldn't download that file"); return r.blob(); })
    .then(function (b) { var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = name || "file"; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); },
          function (err) { toast(err.message, true); });
}
function brdUpload(files, urlFor, done) {
  var list = Array.prototype.slice.call(files || []);
  if (!list.length) return;
  toast("Uploading " + list.length + " file" + (list.length === 1 ? "" : "s") + "…");
  list.reduce(function (p, f) {
    return p.then(function () {
      return fetch(urlFor(f), { method: "POST", headers: { Authorization: "Bearer " + token(), "Content-Type": "application/octet-stream" }, body: f })
        .then(function (r) { return r.json().then(function (x) { if (!r.ok) throw new Error(f.name + ": " + (x.error || "upload failed")); return x; }); });
    });
  }, Promise.resolve()).then(function () { toast("Uploaded."); done(); }, function (err) { toast(err.message, true); done(); });
}

// Typing in the search or a column filter redraws the board; put the cursor back.
function brdRefocus(id, pos) {
  var el = document.getElementById(id);
  if (el) { el.focus(); try { if (pos != null) el.setSelectionRange(pos, pos); } catch (x) {} }
}
document.addEventListener("input", function (e) {
  var t = e.target;
  if (t.id === "brdSearch") { brd.q = t.value; var pos = t.selectionStart; render(); brdRefocus("brdSearch", pos); return; }
  if (t.dataset && t.dataset.bcf && t.tagName === "INPUT") {
    var cf = brd.colf[t.dataset.bcf] = brd.colf[t.dataset.bcf] || {};
    cf[t.dataset.k] = t.value; brd.colOpen = t.dataset.bcf;
    var p0 = t.selectionStart; render(); brdRefocus(t.id, p0); return;
  }
  if (t.dataset && t.dataset.bn && brd.draft) { brd.draft[t.dataset.bn] = t.type === "checkbox" ? t.checked : t.value; return; }
  if (t.dataset && t.dataset.bl != null && brd.open) {
    if (!brd.lineDraft) { var oc = brdCard(brd.open); brd.lineDraft = JSON.parse(JSON.stringify((oc && oc.lines) || [])); }
    var l = brd.lineDraft[+t.dataset.bl], k = t.dataset.k;
    if (!l) return;
    l[k] = t.type === "checkbox" ? t.checked : t.value;
    // Price follows cost × (1 + mark-up) until someone types a price.
    if ((k === "cost" || k === "markup") && l.cost !== "" && l.markup !== "" && l.cost != null && l.markup != null) {
      l.price = Math.round(Number(l.cost) * (1 + Number(l.markup) / 100) * 100) / 100;
      var pi = document.querySelector('[data-bl="' + t.dataset.bl + '"][data-k="price"]'); if (pi) pi.value = l.price;
    }
  }
});
document.addEventListener("change", function (e) {
  var t = e.target;
  if (t.id === "brdPerson") { brd.person = t.value; render(); return; }
  if (t.dataset && t.dataset.bcf && t.tagName === "SELECT") {
    (brd.colf[t.dataset.bcf] = brd.colf[t.dataset.bcf] || {})[t.dataset.k] = t.value; brd.colOpen = t.dataset.bcf;
    render(); brdRefocus(t.id); return;
  }
  if (t.id === "brdFile") {
    var files = Array.prototype.slice.call(t.files || []), kd = brd.upKind || "";
    if (files.length && brd.open) brdReal(brd.open).then(function (rid) {
      brdUpload(files, function (f) { return "/api/board/" + encodeURIComponent(rid) + "/files?name=" + encodeURIComponent(f.name) + (kd ? "&kind=" + encodeURIComponent(kd) : ""); }, function () { brd.at = 0; loadBoard(); });
    }, function () {});
    return;
  }
  if (t.id === "brdCFile") { var name = brd.customer; brdUpload(t.files, function (f) { return "/api/board-customers/files?customer=" + encodeURIComponent(name) + "&name=" + encodeURIComponent(f.name); }, function () { brd.at = 0; loadBoard(); setTimeout(function () { if (brd.customer) drawCustomerFile(); }, 600); }); return; }
  if (t.dataset && t.dataset.brdCheck && brd.open) { var o = {}; o[t.dataset.brdCheck] = t.checked; brdApi(brd.open, "", { checks: o }, "PATCH"); return; }
  if (t.dataset && t.dataset.bl != null && t.type === "checkbox") return; // saved with the lines
  if (t.dataset && t.dataset.brdF && brd.open) {
    var b = {}; b[t.dataset.brdF] = t.type === "checkbox" ? t.checked : t.value;
    brdApi(brd.open, "", b, "PATCH");
  }
});
// Remember which column's filter box is open across redraws.
document.addEventListener("toggle", function (e) {
  var box = e.target;
  if (!box.dataset || !box.dataset.bcfBox) return;
  if (box.open) brd.colOpen = box.dataset.bcfBox; else if (brd.colOpen === box.dataset.bcfBox) brd.colOpen = "";
}, true);
document.addEventListener("keydown", function (e) { if (e.key === "Escape" && $("#brdModal")) { closeBrdModal(); } });
document.addEventListener("click", function (e) {
  // A click outside a column's filter box closes it.
  if (e.target.closest && !e.target.closest(".bcf")) Array.prototype.forEach.call(document.querySelectorAll("details.bcf[open]"), function (b) { b.open = false; brd.colOpen = ""; });
  var t = e.target.closest && e.target.closest("[data-brd-flag],[data-brd-refresh],[data-brd-new],[data-brd-close],[data-brd-create],[data-brd-open],[data-brd-customer],[data-brd-settings],[data-brd-savesettings],[data-brd-addline],[data-brd-rmline],[data-brd-savelines],[data-brd-approve],[data-brd-reject],[data-brd-move],[data-brd-note],[data-brd-upload],[data-brd-dl],[data-brd-cupload],[data-brd-cdl],[data-brd-archive],[data-brd-tab],[data-brd-link],[data-brd-flagline],[data-bcf-clear],[data-brd-unhl]");
  if (!t) { if (e.target.classList && e.target.classList.contains("rs-modal") && e.target.closest("#brdModal")) closeBrdModal(); return; }
  var ds = t.dataset, id = brd.open;
  if ("brdFlag" in ds) { brd.flag = ds.brdFlag; render(); return; }
  if ("brdRefresh" in ds) { brd.at = 0; brd.retryIn = 15000; loadBoard(); render(); return; }
  if ("bcfClear" in ds) { brd.colf[ds.bcfClear] = {}; render(); return; }
  if ("brdFlagline" in ds) {
    var fc = brdCard(ds.brdFlagline), fl0 = fc && (fc.lines || []).filter(function (x) { return x.id === ds.lid; })[0];
    if (!fl0) return;
    brdApi(fc.id, "/lines/" + encodeURIComponent(ds.lid) + "/flag", { flagged: !fl0.flagged }).then(function () { if (brd.lineDraft) brd.lineDraft.forEach(function (x) { if (x.id === ds.lid) x.flagged = !fl0.flagged; }); }, function () {});
    return;
  }
  if ("brdNew" in ds) { brd.adding = true; brd.draft = null; render(); var c0 = $("#bn-customer"); if (c0) c0.focus(); return; }
  if ("brdClose" in ds) { if (brd.adding) { brd.adding = false; render(); } closeBrdModal(); return; }
  if ("brdCreate" in ds) {
    var f = brd.draft;
    if (!String(f.customer).trim()) { toast("Who's the customer?", true); return; }
    brd.busy = true; render();
    api("/api/board", { method: "POST", body: JSON.stringify({ company: f.company, customer: f.customer, platforms: f.platforms, fileNo: f.fileNo, rfqNo: f.rfqNo, quoteNo: f.quoteNo, dueDate: f.dueDate,
      lines: f.pn ? [{ pn: f.pn, desc: f.desc, qty: f.qty, highlighted: f.highlighted }] : [] }) })
      .then(function (card) { brd.busy = false; brd.adding = false; brdPut(card); brd.open = card.id; brd.lineDraft = null; drawCaseFile(); render(); }, function (err) { brd.busy = false; render(); toast(err.message, true); });
    return;
  }
  if ("brdOpen" in ds) { brd.tab = brd.tab && ds.brdOpen === id ? brd.tab : "notes"; brd.open = ds.brdOpen; brd.line = ds.line || ""; brd.lineJump = !!ds.line; brd.customer = ""; brd.lineDraft = null; drawCaseFile(); render(); return; }
  if ("brdCustomer" in ds) { brd.customer = ds.brdCustomer; brd.open = ""; drawCustomerFile(); render(); return; }
  if ("brdSettings" in ds) { brd.settings = true; drawBoardSettings(); return; }
  if ("brdSavesettings" in ds) {
    var m = {}; brd.data.stages.forEach(function (st) { var v = $("#bs-" + st.id).value; if (v) m[st.id] = v; });
    api("/api/board-settings", { method: "PUT", body: JSON.stringify({ managers: m, globalManager: $("#bs-global").value, bigTicket: $("#bs-big").value }) })
      .then(function () { toast("Stage managers saved."); closeBrdModal(); brd.at = 0; loadBoard(); }, function (err) { toast(err.message, true); });
    return;
  }
  if ("brdUnhl" in ds) { brdApi(id, "", { highlighted: false }, "PATCH"); return; }
  if ("brdAddline" in ds) { brd.lineDraft.push({ pn: "", desc: "", qty: 1 }); drawCaseFile(); return; }
  if ("brdRmline" in ds) { brd.lineDraft.splice(+ds.brdRmline, 1); drawCaseFile(); return; }
  if ("brdSavelines" in ds) {
    if (!brd.lineDraft) return;
    var lines = brd.lineDraft.filter(function (l) { return String(l.pn || "").trim() || l.id; })
      .map(function (l) { var x = Object.assign({}, l); delete x.flagged; delete x.flaggedBy; delete x.flaggedAt; return x; });
    brdApi(id, "", { lines: lines }, "PATCH").then(function () { brd.lineDraft = null; drawCaseFile(); toast("Lines saved."); }, function () {});
    return;
  }
  if ("brdApprove" in ds || "brdReject" in ds) {
    var note = ($("#brdApprNote") || {}).value || "";
    if ("brdReject" in ds && !note.trim() && !confirm("Reject without saying why?")) return;
    brdApi(id, "/approval", { kind: ds.brdApprove || ds.brdReject, decision: "brdApprove" in ds ? "approve" : "reject", note: note })
      .then(function () { toast("brdApprove" in ds ? "Approved." : "Rejected — a follow-up task was added."); }, function () {});
    return;
  }
  if ("brdMove" in ds) {
    brdApi(id, "/move", { to: ds.brdMove }).then(function (card) { brd.lineDraft = null; drawCaseFile(); toast("Moved to " + brdStage(card.stage).label + (card.assignee ? " — now with " + card.assignee : "") + "."); }, function () {});
    return;
  }
  if ("brdNote" in ds) {
    var tx = $("#brdNote").value.trim();
    if (!tx) return;
    var mgr = !!($("#brdNoteMgr") && $("#brdNoteMgr").checked);
    brdApi(id, "/notes", { text: tx, manager: mgr, for: mgr ? $("#brdNoteFor").value : "", due: mgr ? $("#brdNoteDue").value : "" })
      .then(function () { if (mgr) toast("Feedback added — it's on their Mentions of You."); }, function () {});
    return;
  }
  if ("brdUpload" in ds) { var fi = $("#brdFile"); brd.upKind = ds.brdUpload || ""; fi.accept = t.dataset.accept || ""; fi.click(); return; }
  if ("brdTab" in ds) { brd.tab = ds.brdTab; drawCaseFile(); return; }
  if ("brdLink" in ds) {
    var lk = { kind: ds.brdLink, title: ($("#cfTitle") || {}).value || "", url: ($("#cfUrl") || {}).value || "", text: ($("#cfText") || {}).value || "" };
    brdApi(id, "/links", lk).then(function () { toast("Added."); }, function () {});
    return;
  }
  if ("brdCupload" in ds) { $("#brdCFile").click(); return; }
  if ("brdDl" in ds) { var c1 = brdCard(id), meta = c1 && (c1.files || []).filter(function (x) { return x.id === ds.brdDl; })[0]; brdDownload("/api/board/" + encodeURIComponent(id) + "/files/" + encodeURIComponent(ds.brdDl), meta && meta.name); return; }
  if ("brdCdl" in ds) { var fl = (((brd.data.customers || {})[brd.customer] || {}).files || []).filter(function (x) { return x.id === ds.brdCdl; })[0]; brdDownload("/api/board-customers/files/" + encodeURIComponent(ds.brdCdl), fl && fl.name); return; }
  if ("brdArchive" in ds) {
    var arch = ds.brdArchive === "1";
    if (arch && !confirm("Archive this file? It leaves the board but its documents, notes and history are kept.")) return;
    brdApi(id, "/archive", { archived: arch }).then(function (card) { if (arch) { closeBrdModal(); brd.data.cards = brd.data.cards.filter(function (c) { return c.id !== card.id; }); render(); } }, function () {});
  }
});

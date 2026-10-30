"use strict";
// AOG operations board and case files.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---------- AOG operations board ----------
// One card per quote, RFQ → Quoted → Sale → Purchased → Received → Sent, on
// the Board tab of Procurement, Purchasing and Warehouse. The server holds
// the rules (hard stops, approvals, who sees cost and margin); this draws
// the columns, the case file pop-up, the customer file and the settings.
var BOARD_DEPTS = ["Procurement", "Purchasing", "Warehouse"];
var brd = { data: null, at: 0, loading: false, error: "", q: "", flag: "", person: "", open: "", customer: "", settings: false, adding: false, draft: null, busy: false };
var BRD_FLAG = { overdue: ["Overdue", "bf-over"], due: ["Due", "bf-due"], approval: ["For approval", "bf-appr"], highlighted: ["Highlighted", "bf-hi"], rejected: ["Quote rejected", "bf-rej"] };
var BRD_DOTS = [["due", "Due", "bd-due"], ["approval", "For approval", "bd-appr"], ["highlighted", "Highlighted", "bd-hi"]];
// Coloured corner dots on a card (overdue and due share red).
function brdDots(c) {
  var on = function (f) { return c.flags.indexOf(f) !== -1; };
  return '<span class="bd-dots">' + (on("due") || on("overdue") ? '<span class="bd bd-due" title="' + (on("overdue") ? "Overdue" : "Due soon") + '"></span>' : "") +
    (on("approval") ? '<span class="bd bd-appr" title="For approval"></span>' : "") + (on("highlighted") ? '<span class="bd bd-hi" title="Highlighted: not on the open market"></span>' : "") +
    (on("rejected") ? '<span class="bd bd-rej" title="Quote rejected"></span>' : "") + "</span>";
}
function canSeeBoardUi() { return me.fullAccess || me.leadership || BOARD_DEPTS.some(function (d) { return me.departments.indexOf(d) !== -1; }); }
function canAddRfq() { return me.fullAccess || me.leadership || me.departments.indexOf("Procurement") !== -1; }
function loadBoard() {
  if (brd.loading) return;
  brd.loading = true;
  api("/api/board" + (activeCompany && activeCompany !== ALL ? "?company=" + encodeURIComponent(activeCompany) : ""))
    .then(function (d) { brd.data = d; brd.error = ""; }, function (err) { brd.error = err.message; })
    .then(function () { brd.loading = false; brd.at = Date.now(); brd.co = activeCompany; requestRender(); if (brd.open) drawCaseFile(); });
}
function brdCard(id) { return brd.data ? brd.data.cards.filter(function (c) { return c.id === id; })[0] : null; }
function brdPut(card) {
  var i = brd.data.cards.findIndex(function (c) { return c.id === card.id; });
  if (i === -1) brd.data.cards.push(card); else brd.data.cards[i] = card;
  render(); if (brd.open === card.id) drawCaseFile();
}
function brdStage(id) { return brd.data.stages.filter(function (s) { return s.id === id; })[0] || { label: id }; }
function brdLabel(c) {
  var later = ["sale", "purchased", "received", "sent"].indexOf(c.stage) !== -1;
  return later && c.orderNo ? "Order " + c.orderNo : c.quoteNo ? "Quote " + c.quoteNo : "RFQ (no quote no. yet)";
}
function brdMatch(c) {
  var q = brd.q.trim().toLowerCase();
  if (q && [c.quoteNo, c.orderNo, c.customer].concat((c.lines || []).map(function (l) { return l.pn; })).join(" ").toLowerCase().indexOf(q) === -1) return false;
  if (brd.flag && c.flags.indexOf(brd.flag) === -1 && !(brd.flag === "due" && c.flags.indexOf("overdue") !== -1)) return false;
  if (brd.person && !sameUser(c.assignee, brd.person)) return false;
  return true;
}

function renderBoard(dept) {
  var qa = $("#quickAdd"); if (qa) qa.style.display = "none";
  if (!brd.data || brd.co !== activeCompany || Date.now() - brd.at > 60000) loadBoard();
  if (brd.error) return '<div class="banner">' + E(brd.error) + "</div>";
  if (!brd.data) return '<div class="empty">Loading the board…</div>';
  var d = brd.data, all = d.cards, shown = all.filter(brdMatch);
  var count = function (f) { return all.filter(function (c) { return c.flags.indexOf(f) !== -1 || (f === "due" && c.flags.indexOf("overdue") !== -1); }).length; };
  var legend = BRD_DOTS.map(function (f) {
    return '<button type="button" class="bd-leg' + (brd.flag === f[0] ? " active" : "") + '" data-brd-flag="' + (brd.flag === f[0] ? "" : f[0]) + '" title="' + (brd.flag === f[0] ? "Show everything" : "Show only " + f[1]) + '"><span class="bd ' + f[2] + '"></span>' + E(f[1]) + ' <span class="ib-n">' + count(f[0]) + "</span></button>";
  }).join("");
  var people = '<select id="brdPerson" aria-label="Assigned to"><option value="">Everyone</option>' + d.people.map(function (p) {
    return '<option value="' + E(p) + '"' + (sameUser(p, brd.person) ? " selected" : "") + ">" + E(p) + "</option>";
  }).join("") + "</select>";
  var head = '<div class="brd-bar"><div class="brd-legend">' + legend + (brd.flag ? '<button type="button" class="text-button" data-brd-flag="">Show all</button>' : "") + "</div>" +
    '<div class="brd-tools"><input type="search" id="brdSearch" placeholder="Search # or P/N" value="' + E(brd.q) + '" aria-label="Search by quote number, order number, P/N or customer">' +
    '<button type="button" data-brd-refresh title="Reload the board">Refresh</button>' + people +
    (d.can.settings ? '<button type="button" data-brd-settings>Stage managers</button>' : "") +
    (canAddRfq() ? '<button type="button" class="primary" data-brd-new>+ New RFQ</button>' : "") + "</div></div>";
  var cols = d.stages.map(function (s) {
    var list = shown.filter(function (c) { return c.stage === s.id; })
      .sort(function (a, b) { return String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")) || b.updatedAt - a.updatedAt; });
    return '<section class="brd-col' + (s.dept === dept ? " mine" : "") + '"><header><b>' + E(s.label) + "</b>" +
      '<span class="brd-mgr" title="Cards moved here are assigned to ' + E(d.managers[s.id] || "nobody yet") + '">' + list.length + " · " + E(d.managers[s.id] || s.dept) + "</span></header>" +
      (list.length ? list.map(brdCardHtml).join("") : '<div class="brd-empty">Nothing here</div>') + "</section>";
  }).join("");
  return head + '<div class="brd-cols">' + cols + "</div>" +
    '<p class="small-note brd-cap">Quote number in RFQ and Quoted; order number from Sale onward. Moving a card to the next column auto-assigns it to that stage\'s manager. Hard stops: sourcing ✓ before Quoted, quote ✓ and order no. before Sale, purchase ✓ and export licence field on every line before Purchased, location and date in before Received, quality sign-off before Sent. Numbers, certificates and licences are copied from Pentagon and source documents — the tracker never makes them up.</p>' +
    (brd.adding ? brdNewForm() : "");
}
function brdCardHtml(c) {
  var lines = c.lines || [];
  var pns = lines.map(function (l) { return l.pn; }).filter(Boolean);
  return '<button type="button" class="brd-card" data-brd-open="' + E(c.id) + '">' + brdDots(c) +
    '<span class="brd-no">' + E(brdLabel(c)) + "</span>" +
    '<span class="brd-pn">' + (pns.length ? E(pns.slice(0, 2).join(", ")) + (pns.length > 2 ? " +" + (pns.length - 2) : "") + ' <span class="co-note">· ' + pns.length + " P/N line" + (pns.length === 1 ? "" : "s") + "</span>" : "No P/N lines yet") + "</span>" +
    '<span class="brd-cust">' + E(c.customer) + (activeCompany === ALL ? " · " + E(shortCo(c.company)) : "") + "</span>" +
    '<span class="brd-foot">' + (c.dueDate ? '<span class="co-note">Due ' + E(fmtDate(c.dueDate)) + "</span>" : "") + '<span class="grow"></span>' +
    (c.assignee ? '<span class="av" title="' + E(c.assignee) + '">' + E(initialsOf(c.assignee)) + "</span>" : "") + "</span></button>";
}

// New RFQ (Procurement).
function brdNewForm() {
  var f = brd.draft || (brd.draft = { company: activeCompany !== ALL ? activeCompany : myCompanies()[0], customer: "", quoteNo: "", dueDate: "", pn: "", desc: "", qty: 1, highlighted: false });
  return '<div class="rs-modal" data-brd-modal="new"><div class="rs-card rs-wide" role="dialog" aria-modal="true" aria-labelledby="brdNewT"><h3 id="brdNewT">New RFQ</h3>' +
    '<div class="grid-2" style="gap:0 14px;">' +
    (activeCompany === ALL ? '<div class="nb-field"><label for="bn-company">Company</label><select id="bn-company" data-bn="company">' + myCompanies().map(function (c) { return "<option" + (c === f.company ? " selected" : "") + ' value="' + E(c) + '">' + E(shortCo(c)) + "</option>"; }).join("") + "</select></div>" : "") +
    '<div class="nb-field"><label for="bn-customer">Customer</label><input id="bn-customer" data-bn="customer" value="' + E(f.customer) + '" autocomplete="off"></div>' +
    '<div class="nb-field"><label for="bn-quote">Quote no. (from Pentagon, if there is one)</label><input id="bn-quote" data-bn="quoteNo" value="' + E(f.quoteNo) + '" autocomplete="off"></div>' +
    '<div class="nb-field"><label for="bn-due">Due</label><input id="bn-due" type="date" data-bn="dueDate" value="' + E(f.dueDate) + '"></div>' +
    '<div class="nb-field"><label for="bn-pn">P/N</label><input id="bn-pn" data-bn="pn" value="' + E(f.pn) + '" autocomplete="off"></div>' +
    '<div class="nb-field"><label for="bn-desc">Description</label><input id="bn-desc" data-bn="desc" value="' + E(f.desc) + '" autocomplete="off"></div>' +
    '<div class="nb-field"><label for="bn-qty">Qty</label><input id="bn-qty" type="number" min="1" data-bn="qty" value="' + E(f.qty) + '"></div></div>' +
    '<label class="small-note" style="display:flex;gap:7px;align-items:center;"><input type="checkbox" class="check" data-bn="highlighted"' + (f.highlighted ? " checked" : "") + "> Highlight: this part isn't on the open market</label>" +
    '<div class="nb-foot" style="margin-top:14px;"><span class="small-note">It starts in RFQ, assigned to ' + E(brd.data.managers.rfq || "you") + '.</span><span class="grow"></span><button type="button" class="text-button" data-brd-close>Cancel</button><button type="button" class="primary" data-brd-create' + (brd.busy ? " disabled" : "") + ">Create</button></div></div></div>";
}

// The case file pop-up.
function brdModal(html) {
  var box = $("#brdModal");
  if (!box) { box = document.createElement("div"); box.id = "brdModal"; document.body.appendChild(box); }
  box.innerHTML = html;
  return box;
}
function closeBrdModal() { brd.open = ""; brd.customer = ""; brd.settings = false; brd.lineDraft = null; var b = $("#brdModal"); if (b) b.remove(); }
function drawCaseFile() {
  var c = brdCard(brd.open);
  if (!c) { closeBrdModal(); return; }
  var d = brd.data, can = d.can, si = d.stages.findIndex(function (s) { return s.id === c.stage; });
  var lines = brd.lineDraft || (brd.lineDraft = JSON.parse(JSON.stringify(c.lines || [])));
  var showFrom = function (stage) { return si >= d.stages.findIndex(function (s) { return s.id === stage; }); };
  var cols = [["pn", "P/N", "text"], ["desc", "Description", "text"], ["qty", "Qty", "number"]]
    .concat(can.cost ? [["cost", "Cost", "number"], ["markup", "Mark-up %", "number"]] : [])
    .concat([["price", "Price", "number"]])
    .concat(can.margin ? [["margin", "Margin", "ro"]] : [])
    .concat(showFrom("sale") ? [["exportLicence", "Export licence", "text"]] : [])
    .concat(showFrom("purchased") ? [["location", "Location", "text"], ["dateIn", "Date in", "date"], ["listOnWebsite", "Website", "check"], ["qualityOk", "Quality ✓", "check"]] : [])
    .concat(showFrom("received") ? [["carrier", "Carrier", "text"], ["tracking", "Tracking", "text"]] : []);
  var cell = function (l, i, col) {
    var k = col[0], v = l[k];
    if (col[2] === "ro") return "<td>" + (v == null ? "—" : E(v) + "%") + "</td>";
    if (col[2] === "check") return '<td class="center"><input type="checkbox" class="check" data-bl="' + i + '" data-k="' + k + '"' + (v ? " checked" : "") + (k === "qualityOk" && !can.quality ? " disabled title=\"Warehouse manager signs off quality\"" : "") + "></td>";
    return '<td><input type="' + (col[2] === "date" ? "date" : col[2] === "number" ? "number" : "text") + '" data-bl="' + i + '" data-k="' + k + '" value="' + E(v == null ? "" : v) + '"' + (col[2] === "number" ? ' min="0" step="any"' : "") + (k === "exportLicence" ? ' placeholder="As on the source document"' : "") + "></td>";
  };
  var kind = d.approvals[c.stage], appr = kind ? (c.approvals || {})[kind] || {} : null;
  var checks = function (stage, title) {
    return '<div class="brd-checks"><div class="card-label">' + title + "</div>" + (d.checks[stage] || []).map(function (ch) {
      return '<label><input type="checkbox" class="check" data-brd-check="' + ch.id + '"' + ((c.checks || {})[ch.id] ? " checked" : "") + "> " + E(ch.label) + "</label>";
    }).join("") + "</div>";
  };
  var next = c.next ? brdStage(c.next) : null;
  var html = '<div class="rs-modal" data-brd-modal="case"><div class="rs-card brd-case" role="dialog" aria-modal="true" aria-labelledby="brdCaseT">' +
    '<div class="brd-case-head"><div><div class="eyebrow">' + E(shortCo(c.company)) + " · " + E(brdStage(c.stage).label) + (c.archived ? " · Archived" : "") + '</div><h3 id="brdCaseT">' + E(brdLabel(c)) + "</h3>" +
    '<button type="button" class="text-button" data-brd-customer="' + E(c.customer) + '">' + E(c.customer) + " — customer file</button></div>" +
    '<button type="button" class="text-button" data-brd-close aria-label="Close">Close ✕</button></div>' +
    '<div class="brd-flags">' + c.flags.map(function (f) { var x = BRD_FLAG[f]; return x ? '<span class="bf ' + x[1] + '">' + x[0] + "</span>" : ""; }).join("") + "</div>" +
    '<div class="brd-grid">' +
      '<div class="nb-field"><label>Quote no.</label><input data-brd-f="quoteNo" value="' + E(c.quoteNo || "") + '"></div>' +
      '<div class="nb-field"><label>Order no.</label><input data-brd-f="orderNo" value="' + E(c.orderNo || "") + '" placeholder="From Pentagon, at Sale"></div>' +
      '<div class="nb-field"><label>Customer</label><input data-brd-f="customer" value="' + E(c.customer) + '"></div>' +
      '<div class="nb-field"><label>Due</label><input type="date" data-brd-f="dueDate" value="' + E(c.dueDate || "") + '"></div>' +
      '<div class="nb-field"><label>Assigned to</label>' + (can.assign ? '<select data-brd-f="assignee"><option value="">Nobody</option>' + d.people.map(function (p) { return '<option value="' + E(p) + '"' + (sameUser(p, c.assignee) ? " selected" : "") + ">" + E(p) + "</option>"; }).join("") + "</select>" : '<div class="static">' + E(c.assignee || "—") + "</div>") + "</div>" +
      '<div class="nb-field"><label>Open market</label><label class="small-note" style="display:flex;gap:6px;align-items:center;"><input type="checkbox" class="check" data-brd-f="highlighted"' + (c.highlighted ? " checked" : "") + "> Not available (highlight)</label></div>" +
    "</div>" +
    '<div class="card-label" style="margin-top:12px;">P/N lines' + (c.total ? " · quote total " + E(money(c.total)) : "") + "</div>" +
    '<div class="table-wrap"><table class="plain brd-lines"><thead><tr>' + cols.map(function (x) { return "<th>" + E(x[1]) + "</th>"; }).join("") + "<th></th></tr></thead><tbody>" +
      lines.map(function (l, i) { return "<tr>" + cols.map(function (col) { return cell(l, i, col); }).join("") + '<td><button type="button" class="text-button" data-brd-rmline="' + i + '" title="Remove line">✕</button></td></tr>'; }).join("") +
    "</tbody></table></div>" +
    '<div class="nb-foot"><button type="button" class="text-button" data-brd-addline>+ Add line</button><span class="grow"></span><button type="button" class="primary" data-brd-savelines>Save lines</button></div>' +
    (si <= 1 ? checks("rfq", "Black file — sourcing checks") : "") +
    (si >= 2 && si <= 3 ? checks("sale", "Red file — before the purchase goes for approval") : "") +
    (kind ? '<div class="brd-approval"><div class="card-label">' + E({ sourcing: "Sourcing approval", quote: "Quote approval", purchase: "Purchase approval" }[kind]) + "</div>" +
      (appr.state ? '<p class="small-note">' + (appr.state === "approved" ? "✓ Approved" : "✗ Rejected") + " by " + E(appr.by) + " · " + E(new Date(appr.at).toLocaleString()) + (appr.note ? " — " + E(appr.note) : "") + "</p>" : "") +
      (c.approvalBlockers[kind].length ? '<p class="small-note">Not ready for approval: ' + E(c.approvalBlockers[kind].join("; ")) + ".</p>"
        : '<div class="brd-appr-row"><input id="brdApprNote" placeholder="Note (optional — say why if rejecting)"><button type="button" class="st-btn st-done" data-brd-approve="' + kind + '">✓ Approve</button><button type="button" class="st-btn st-del" data-brd-reject="' + kind + '">✗ Reject</button></div>') + "</div>" : "") +
    '<div class="brd-move">' + (si > 0 ? '<button type="button" class="text-button" data-brd-move="' + d.stages[si - 1].id + '">← Back to ' + E(d.stages[si - 1].label) + "</button>" : "") + '<span class="grow"></span>' +
      (next ? (c.moveBlockers.length ? '<span class="small-note">Before ' + E(next.label) + ": " + E(c.moveBlockers.join("; ")) + "</span>" : "") +
        '<button type="button" class="primary" data-brd-move="' + next.id + '"' + (c.moveBlockers.length ? " disabled" : "") + ">Move to " + E(next.label) + " →</button>" : '<span class="small-note">Shipped.</span>') + "</div>" +
    brdCaseBox(c) +
    '<details class="brd-hist"><summary>History (' + (c.history || []).length + ")</summary>" + (c.history || []).slice().reverse().map(function (h) { return '<div class="small-note">' + E(new Date(h.at).toLocaleString()) + " · <b>" + E(h.by) + "</b> · " + E(h.what) + "</div>"; }).join("") + "</details>" +
    (can.assign ? '<div class="nb-foot" style="margin-top:10px;"><span class="grow"></span><button type="button" class="text-button" data-brd-archive="' + (c.archived ? "0" : "1") + '">' + (c.archived ? "Restore card" : "Archive card") + "</button></div>" : "") +
    "</div></div>";
  brdModal(html);
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
    body = (c.notes || []).slice().reverse().map(function (x) { return '<div class="itr-note' + (x.manager ? " brd-mnote" : "") + '"><b>' + (x.manager ? "Manager to-do · " : "") + E(x.by) + "</b> · " + E(new Date(x.at).toLocaleString()) + "<br>" + E(x.text) + "</div>"; }).join("") +
      '<textarea id="brdNote" rows="3" placeholder="Add a note: what was found, what still needs doing to complete the file…"></textarea>' +
      '<div class="nb-foot">' + (d.can.assign ? '<label class="small-note"><input type="checkbox" class="check" id="brdNoteMgr"> Manager to-do</label>' : "") + '<span class="grow"></span><button type="button" data-brd-note>Add note</button></div>';
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
  return '<div class="cf-box"><div class="cf-head"><b>Case file</b><span class="small-note">Saved to AWS, one folder per card; the black file (sourcing) and red file (order) are built from it.</span></div>' + tabs +
    '<div class="cf-body">' + body + "</div>" +
    '<input type="file" id="brdFile" multiple hidden><p class="small-note" style="margin:8px 0 0;">Don\'t add export-controlled technical data until the compliance lead confirms this storage. Certificate and approval references are copied from source documents, never made up.</p></div>';
}

// Customer file: their RFQs and orders, and documents (export licences, certificates…).
function drawCustomerFile() {
  var name = brd.customer, d = brd.data;
  var mine = d.cards.filter(function (c) { return c.customer.toLowerCase() === name.toLowerCase(); }).sort(function (a, b) { return b.createdAt - a.createdAt; });
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

function brdApi(path, body, method) {
  return api(path, { method: method || "POST", body: JSON.stringify(body || {}) }).then(function (card) { if (card && card.id) brdPut(card); return card; }, function (err) { toast(err.message, true); throw err; });
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

document.addEventListener("input", function (e) {
  var t = e.target;
  if (t.id === "brdSearch") { brd.q = t.value; var pos = t.selectionStart; render(); var s = $("#brdSearch"); if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (x) {} } return; }
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
  if (t.id === "brdFile") { var c = brdCard(brd.open), kd = brd.upKind || ""; if (c) brdUpload(t.files, function (f) { return "/api/board/" + encodeURIComponent(c.id) + "/files?name=" + encodeURIComponent(f.name) + (kd ? "&kind=" + encodeURIComponent(kd) : ""); }, function () { brd.at = 0; loadBoard(); }); return; }
  if (t.id === "brdCFile") { var name = brd.customer; brdUpload(t.files, function (f) { return "/api/board-customers/files?customer=" + encodeURIComponent(name) + "&name=" + encodeURIComponent(f.name); }, function () { brd.at = 0; loadBoard(); setTimeout(function () { if (brd.customer) drawCustomerFile(); }, 600); }); return; }
  if (t.dataset && t.dataset.brdCheck && brd.open) { var o = {}; o[t.dataset.brdCheck] = t.checked; brdApi("/api/board/" + encodeURIComponent(brd.open), { checks: o }, "PATCH"); return; }
  if (t.dataset && t.dataset.bl != null && t.type === "checkbox") return; // saved with the lines
  if (t.dataset && t.dataset.brdF && brd.open) {
    var b = {}; b[t.dataset.brdF] = t.type === "checkbox" ? t.checked : t.value;
    brdApi("/api/board/" + encodeURIComponent(brd.open), b, "PATCH");
  }
});
document.addEventListener("keydown", function (e) { if (e.key === "Escape" && $("#brdModal")) { closeBrdModal(); } });
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-brd-flag],[data-brd-refresh],[data-brd-new],[data-brd-close],[data-brd-create],[data-brd-open],[data-brd-customer],[data-brd-settings],[data-brd-savesettings],[data-brd-addline],[data-brd-rmline],[data-brd-savelines],[data-brd-approve],[data-brd-reject],[data-brd-move],[data-brd-note],[data-brd-upload],[data-brd-dl],[data-brd-cupload],[data-brd-cdl],[data-brd-archive],[data-brd-tab],[data-brd-link]");
  if (!t) { if (e.target.classList && e.target.classList.contains("rs-modal") && e.target.closest("#brdModal")) closeBrdModal(); return; }
  var ds = t.dataset, id = brd.open;
  if ("brdFlag" in ds) { brd.flag = ds.brdFlag; render(); return; }
  if ("brdRefresh" in ds) { brd.at = 0; loadBoard(); return; }
  if ("brdNew" in ds) { brd.adding = true; brd.draft = null; render(); var c0 = $("#bn-customer"); if (c0) c0.focus(); return; }
  if ("brdClose" in ds) { if (brd.adding) { brd.adding = false; render(); } closeBrdModal(); return; }
  if ("brdCreate" in ds) {
    var f = brd.draft;
    if (!String(f.customer).trim()) { toast("Who's the customer?", true); return; }
    brd.busy = true; render();
    api("/api/board", { method: "POST", body: JSON.stringify({ company: f.company, customer: f.customer, quoteNo: f.quoteNo, dueDate: f.dueDate, highlighted: f.highlighted, lines: f.pn ? [{ pn: f.pn, desc: f.desc, qty: f.qty }] : [] }) })
      .then(function (card) { brd.busy = false; brd.adding = false; brdPut(card); brd.open = card.id; brd.lineDraft = null; drawCaseFile(); }, function (err) { brd.busy = false; render(); toast(err.message, true); });
    return;
  }
  if ("brdOpen" in ds) { brd.open = ds.brdOpen; brd.customer = ""; brd.lineDraft = null; brd.tab = "notes"; drawCaseFile(); return; }
  if ("brdCustomer" in ds) { brd.customer = ds.brdCustomer; brd.open = ""; drawCustomerFile(); return; }
  if ("brdSettings" in ds) { brd.settings = true; drawBoardSettings(); return; }
  if ("brdSavesettings" in ds) {
    var m = {}; brd.data.stages.forEach(function (st) { var v = $("#bs-" + st.id).value; if (v) m[st.id] = v; });
    api("/api/board-settings", { method: "PUT", body: JSON.stringify({ managers: m, globalManager: $("#bs-global").value, bigTicket: $("#bs-big").value }) })
      .then(function () { toast("Stage managers saved."); closeBrdModal(); brd.at = 0; loadBoard(); }, function (err) { toast(err.message, true); });
    return;
  }
  if ("brdAddline" in ds) { brd.lineDraft.push({ pn: "", desc: "", qty: 1 }); drawCaseFile(); return; }
  if ("brdRmline" in ds) { brd.lineDraft.splice(+ds.brdRmline, 1); drawCaseFile(); return; }
  if ("brdSavelines" in ds) {
    if (!brd.lineDraft) return;
    var lines = brd.lineDraft.filter(function (l) { return String(l.pn || "").trim() || l.id; });
    brdApi("/api/board/" + encodeURIComponent(id), { lines: lines }, "PATCH").then(function () { brd.lineDraft = null; drawCaseFile(); toast("Lines saved."); }, function () {});
    return;
  }
  if ("brdApprove" in ds || "brdReject" in ds) {
    var note = ($("#brdApprNote") || {}).value || "";
    if ("brdReject" in ds && !note.trim() && !confirm("Reject without saying why?")) return;
    brdApi("/api/board/" + encodeURIComponent(id) + "/approval", { kind: ds.brdApprove || ds.brdReject, decision: "brdApprove" in ds ? "approve" : "reject", note: note })
      .then(function () { toast("brdApprove" in ds ? "Approved." : "Rejected — a follow-up task was added."); }, function () {});
    return;
  }
  if ("brdMove" in ds) {
    brdApi("/api/board/" + encodeURIComponent(id) + "/move", { to: ds.brdMove }).then(function (card) { brd.lineDraft = null; drawCaseFile(); toast("Moved to " + brdStage(card.stage).label + (card.assignee ? " — now with " + card.assignee : "") + "."); }, function () {});
    return;
  }
  if ("brdNote" in ds) {
    var tx = $("#brdNote").value.trim();
    if (!tx) return;
    brdApi("/api/board/" + encodeURIComponent(id) + "/notes", { text: tx, manager: !!($("#brdNoteMgr") && $("#brdNoteMgr").checked) });
    return;
  }
  if ("brdUpload" in ds) { var fi = $("#brdFile"); brd.upKind = ds.brdUpload || ""; fi.accept = t.dataset.accept || ""; fi.click(); return; }
  if ("brdTab" in ds) { brd.tab = ds.brdTab; drawCaseFile(); return; }
  if ("brdLink" in ds) {
    var lk = { kind: ds.brdLink, title: ($("#cfTitle") || {}).value || "", url: ($("#cfUrl") || {}).value || "", text: ($("#cfText") || {}).value || "" };
    brdApi("/api/board/" + encodeURIComponent(id) + "/links", lk).then(function () { toast("Added."); }, function () {});
    return;
  }
  if ("brdCupload" in ds) { $("#brdCFile").click(); return; }
  if ("brdDl" in ds) { var c1 = brdCard(id), meta = c1 && (c1.files || []).filter(function (x) { return x.id === ds.brdDl; })[0]; brdDownload("/api/board/" + encodeURIComponent(id) + "/files/" + encodeURIComponent(ds.brdDl), meta && meta.name); return; }
  if ("brdCdl" in ds) { var fl = (((brd.data.customers || {})[brd.customer] || {}).files || []).filter(function (x) { return x.id === ds.brdCdl; })[0]; brdDownload("/api/board-customers/files/" + encodeURIComponent(ds.brdCdl), fl && fl.name); return; }
  if ("brdArchive" in ds) {
    var arch = ds.brdArchive === "1";
    if (arch && !confirm("Archive this card? It leaves the board but its case file and history are kept.")) return;
    brdApi("/api/board/" + encodeURIComponent(id) + "/archive", { archived: arch }).then(function () { if (arch) { closeBrdModal(); brd.data.cards = brd.data.cards.filter(function (c) { return c.id !== id; }); render(); } }, function () {});
  }
});

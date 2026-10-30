"use strict";
// Mentions you.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---------- Mentions you ----------
// Everything assigned to you: tracker tasks (any company or department you
// have) and Pentagon rows a manager assigned you. Then, for SOI logins,
// Pentagon documents tied to your Pentagon code.
var mineOpen = 0; // open items assigned to you, for the sidebar badge
function loadMineCount() {
  var pentagon = hasSOI() && me.pentagonMentions ? api("/api/rfq-marks/mine").catch(function () { return []; }) : Promise.resolve([]);
  return Promise.all([api("/api/tasks/mine"), pentagon]).then(function (r) {
    var n = r[0].filter(function (t) { return !isDone(t); }).length + r[1].filter(function (m) { return !m.done; }).length;
    if (n !== mineOpen) { mineOpen = n; renderNav(); }
    return r;
  });
}
// Mentions you is a quick dashboard: summary boxes, two small charts, and
// everything grouped by urgency in collapsible sections (open/closed is
// remembered on this device). A filter narrows it to one kind of item.
var MN_GROUPS = [
  { id: "overdue", label: "Overdue", open: true },
  { id: "week", label: "Due this week", open: true },
  { id: "later", label: "Due later", open: false },
  { id: "nodue", label: "No due date", open: false },
  { id: "done", label: "Done", open: false }
];
var MN_TYPES = [
  { id: "all", label: "All" }, { id: "task", label: "Tasks" }, { id: "rfqs", label: "RFQs" }, { id: "quotes", label: "Quotes" },
  { id: "sales_orders", label: "SOs" }, { id: "purchase_orders", label: "POs" }, { id: "invoice", label: "Invoices" }
];
var MN_TYPE_LABEL = { task: "Tasks", rfqs: "RFQs", quotes: "Quotes", sales_orders: "Sales orders", purchase_orders: "Purchase orders", invoice: "Invoices", other: "Other" };
// Validated pair (dataviz palette check): one hue for counts, red only for Overdue (always labelled).
var mnRows = null, mnPentRows = [], mnPentError = null, mnFilter = "all", mnCharts = [];
var mnOpen = (function () {
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem("soi_tracker_mentions_open") || "null"); } catch (e) {}
  var out = {};
  MN_GROUPS.forEach(function (g) { out[g.id] = saved && typeof saved[g.id] === "boolean" ? saved[g.id] : g.open; });
  return out;
})();
function saveMnOpen() { try { localStorage.setItem("soi_tracker_mentions_open", JSON.stringify(mnOpen)); } catch (e) {} }

function renderMentionsShell() {
  setBreadcrumb(["You", "Mentions of You"]);
  setTimeout(loadMentions, 0);
  var wantPentagon = hasSOI() && !!me.pentagonCode && !!me.pentagonMentions;
  return '<div class="intro"><div><div class="eyebrow">You</div><h1>Mentions of You</h1><p>Everything assigned to you' +
    (hasSOI() && me.pentagonMentions ? ", and every Pentagon document where you're the contact" : "") + " — sorted by what's urgent.</p></div></div>" +
    (hasSOI() && me.pentagonMentions && !me.pentagonCode ? '<div class="banner">No Pentagon code is set on your login yet — ask an admin to add one at <b>/admin.html</b> so your RFQs, Quotes, Sales Orders, Purchase Orders and Invoices show up here.</div>' : "") +
    '<div id="mn-dash"><div class="empty">Loading…</div></div>' +
    (wantPentagon
      ? '<details class="mn-group" id="mn-all"><summary><span class="mn-title">All your Pentagon documents</span><span class="small-note" id="mn-msg"></span></summary>' +
        '<div class="grid-2" id="mn-charts" style="display:none;margin:14px 0 18px;"><div class="card"><div class="card-label" id="mn-line-title">Total value over time</div><div class="chart-wrap"><canvas id="mn-line"></canvas></div></div>' +
        '<div class="card"><div class="card-label" id="mn-pie-title">By status</div><div class="chart-wrap"><canvas id="mn-pie"></canvas></div></div></div>' +
        '<div class="table-wrap"><table class="wide" id="mn-table" style="display:none;"></table><div class="empty" id="mn-empty">Loading…</div></div></details>'
      : "");
}

// Pentagon document kinds (dashboards.mine's DOC_KIND) -> tracker view.
function kindToView(kind) {
  var k = String(kind || "").toLowerCase();
  if (k.indexOf("rfq") !== -1 || k.indexOf("request") !== -1) return { id: "rfqs", label: "RFQ", dept: "Procurement" };
  if (k.indexOf("quote") !== -1) return { id: "quotes", label: "Quote", dept: "Procurement" };
  if (k.indexOf("sales") !== -1) return { id: "sales_orders", label: "SO", dept: "Purchasing" };
  if (k.indexOf("purchase") !== -1) return { id: "purchase_orders", label: "PO", dept: "Purchasing" };
  if (k.indexOf("invoice") !== -1) return { id: "invoice", label: "Invoice", dept: "Accounting & Finance", noMarks: true };
  return { id: "other", label: kind || "Document", dept: "Procurement", noMarks: true };
}

function loadMentions() {
  // Pentagon documents with your code as the contact, and the ticks /
  // notes / assignments kept on them (if your login can see those).
  var wantPentagon = hasSOI() && !!me.pentagonCode && !!me.pentagonMentions;
  var mine = wantPentagon
    ? api("/api/pentagon/dashboards.mine", { method: "POST", body: JSON.stringify({ params: {}, limit: 200 }) })
        .then(function (d) { return { rows: findResultRows(d) || [] }; }, function (err) { return { rows: [], error: err }; })
    : Promise.resolve({ rows: [] });
  var marks = wantPentagon ? api("/api/rfq-marks").catch(function () { return {}; }) : Promise.resolve({});
  if ($("#mn-msg")) $("#mn-msg").textContent = wantPentagon ? "Loading…" : "";

  Promise.all([loadMineCount(), mine, marks]).then(function (r) {
    var tasksMine = r[0][0], assignedMarks = r[0][1], pent = r[1], allMarks = r[2] || {};
    var rows = tasksMine.map(function (task) {
      return {
        type: "task", done: isDone(task), due: task.dueDate || "",
        what: task.title || task.part || "Untitled task",
        sub: [task.part && task.title ? "Part " + task.part : "", task.customer].filter(Boolean).join(" · "),
        where: shortCo(task.company || "SOI Aviation") + " · " + task.department,
        link: "dept/" + encodeURIComponent(task.department), company: task.company || "SOI Aviation",
        notes: task.notes || "", by: task.createdBy || ""
      };
    });
    var seen = {};
    assignedMarks.forEach(function (m) {
      seen[m.key] = true;
      var dept = { rfqs: "Procurement", quotes: "Procurement", sales_orders: "Purchasing", purchase_orders: "Purchasing" }[m.view] || "Procurement";
      rows.push({
        type: m.view || "other", done: !!m.done, due: m.dueDate || "",
        what: (m.label || "") + " " + (m.docNo || m.key), sub: [m.party, m.pentagonUser ? "Pentagon contact " + m.pentagonUser : ""].filter(Boolean).join(" · "),
        where: "SOI · " + dept, link: "dept/" + encodeURIComponent(dept), company: "SOI Aviation",
        notes: m.notes || "", by: m.assignedBy ? "Assigned by " + m.assignedBy : "", pentagon: true
      });
    });
    var prow = pent.rows[0];
    if (prow) {
      var fNo = findField(prow, ["DOC_NO", "RFQ_NO", "QUOTE_NO", "SO_NO", "PO_NO"], ["_NO"]);
      var fKind = findField(prow, ["DOC_KIND", "DOC_TYPE"], ["KIND", "TYPE"]);
      var fParty = findField(prow, ["ACCOUNT_NAME", "CUSTOMER", "VENDOR"], ["NAME"]) || findField(prow, ["ACCTNO"], ["ACCT"]);
      var fDue = findField(prow, ["DUE_DATE"], ["DUE"]);
      var fDate = findField(prow, ["DOC_DATE_ANY", "ENTER_DATE", "DOC_DATE"], ["DATE"]);
      pent.rows.forEach(function (row) {
        var docNo = fNo ? cellText(row[fNo]) : "";
        var v = kindToView(fKind ? row[fKind] : "");
        var key = !v.noMarks && docNo ? (v.id === "rfqs" ? docNo : v.id + ":" + docNo) : "";
        if (key && seen[key]) return; // already listed as assigned
        var m = key ? allMarks[key] || {} : {};
        var dated = fDate ? fmtDate(cellText(row[fDate])) : "";
        rows.push({
          type: v.id, done: !!m.done, due: fDue ? cellText(row[fDue]).slice(0, 10) : "",
          what: v.label + " " + docNo,
          sub: [fParty ? cellText(row[fParty]) : "", dated ? "Dated " + dated : "", "You're the Pentagon contact"].filter(Boolean).join(" · "),
          where: "SOI · " + v.dept, link: "dept/" + encodeURIComponent(v.dept), company: "SOI Aviation",
          notes: m.notes || "", by: m.assignee ? "Assigned to " + m.assignee : "Pentagon", pentagon: true
        });
      });
    }
    mnRows = rows;
    mnPentRows = pent.rows;
    mnPentError = pent.error || null;
    drawMentions();
    drawPentagonList();
  }).catch(function (err) {
    var box = $("#mn-dash");
    if (box) box.innerHTML = '<div class="banner">' + E(err.message) + "</div>";
  });
}

function mnGroupOf(x) {
  if (x.done) return "done";
  if (!x.due) return "nodue";
  if (x.due < today) return "overdue";
  if (x.due <= shiftDays(today, 6)) return "week";
  return "later";
}

function drawMentions() {
  var box = $("#mn-dash");
  if (!box || !mnRows) return;
  mnCharts.forEach(function (c) { try { c.destroy(); } catch (e) {} });
  mnCharts = [];
  var present = {};
  mnRows.forEach(function (x) { present[x.type] = true; });
  var types = MN_TYPES.filter(function (t) { return t.id === "all" || present[t.id]; });
  if (!types.some(function (t) { return t.id === mnFilter; })) mnFilter = "all";
  var rows = mnRows.filter(function (x) { return mnFilter === "all" || x.type === mnFilter; });
  var groups = {};
  MN_GROUPS.forEach(function (g) { groups[g.id] = []; });
  rows.forEach(function (x) { groups[mnGroupOf(x)].push(x); });
  Object.keys(groups).forEach(function (k) {
    groups[k].sort(function (a, b) { return String(a.due || "9999").localeCompare(String(b.due || "9999")) || a.what.localeCompare(b.what); });
  });
  var open = rows.filter(function (x) { return !x.done; });

  var tile = function (id, label, n, note, alert) {
    return '<button type="button" class="metric mn-tile' + (alert && n ? " alert" : "") + '" data-mn-jump="' + id + '"><div class="eyebrow">' + E(label) + "</div><strong>" + n + "</strong><small>" + E(note) + "</small></button>";
  };
  var html =
    (types.length > 2 ? '<div class="table-toolbar" style="margin-top:4px;"><span class="small-note">Show:</span><div class="seg">' + types.map(function (t) {
      return '<button type="button" data-mn-filter="' + t.id + '" class="' + (t.id === mnFilter ? "active" : "") + '">' + E(t.label) + "</button>";
    }).join("") + "</div></div>" : "") +
    '<div class="summary-cards four">' +
    tile("overdue", "Overdue", groups.overdue.length, "Past due and not done", true) +
    tile("week", "Due this week", groups.week.length, "Today through " + new Date(shiftDays(today, 6) + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" })) +
    tile("open", "Open", open.length, (groups.nodue.length ? groups.nodue.length + " with no due date" : "All open items")) +
    tile("done", "Done", groups.done.length, "Ticked off") + "</div>";

  if (open.length) {
    html += '<div class="grid-2" style="margin-bottom:18px;">' +
      '<div class="card"><div class="card-label">Open by type</div><div class="chart-wrap mn-chart"><canvas id="mn-bytype" aria-label="Open items by type"></canvas></div></div>' +
      '<div class="card"><div class="card-label">Due over the next 4 weeks</div><div class="chart-wrap mn-chart"><canvas id="mn-byweek" aria-label="Open items by due week"></canvas></div>' +
      '<div class="small-note" id="mn-week-note"></div></div></div>';
  }

  html += MN_GROUPS.map(function (g) {
    var list = groups[g.id];
    var isOpen = mnOpen[g.id] && list.length > 0;
    return '<details class="mn-group' + (g.id === "overdue" && list.length ? " mn-urgent" : "") + '" data-mn-group="' + g.id + '" id="mn-g-' + g.id + '"' + (isOpen ? " open" : "") + ">" +
      '<summary><span class="mn-title">' + E(g.label) + '</span><span class="badge' + (g.id === "overdue" && list.length ? " mn-badge-red" : "") + '">' + list.length + "</span></summary>" +
      (list.length
        ? '<div class="table-wrap"><table class="plain"><thead><tr><th>What</th><th>Where</th><th>Due date</th><th>Done</th><th>Notes</th><th>From</th></tr></thead><tbody>' +
          list.map(mnRowHtml).join("") + "</tbody></table></div>"
        : '<div class="small-note" style="padding:6px 2px 10px;">Nothing here.</div>') +
      "</details>";
  }).join("");
  box.innerHTML = rows.length || mnFilter !== "all" ? html : '<div class="card empty">Nothing is assigned to you right now.' + (mnPentError ? " (Couldn't load your Pentagon documents: " + E(mnPentError.message) + ")" : "") + "</div>";
  if (open.length) drawMentionCharts(open);
}

function mnRowHtml(x) {
  var late = x.due && !x.done && x.due < today;
  return '<tr class="' + (x.done ? "done" : "") + '"><td><a href="#' + x.link + '" data-mine-co="' + E(x.company) + '"><strong>' + E(x.what) + "</strong></a>" +
    (x.pentagon ? '<span class="src">PENTAGON</span>' : "") + (x.sub ? '<span class="co-note" style="padding:0">' + E(x.sub) + "</span>" : "") + "</td>" +
    "<td>" + E(x.where) + '</td><td style="' + (late ? "color:var(--danger);font-weight:600" : "") + '">' + E(fmtDate(x.due) || "—") + "</td>" +
    '<td><span class="pill ' + (x.done ? "" : "rose") + '">' + (x.done ? "✓ Done" : "✗ Open") + "</span></td><td>" + E(x.notes) + "</td><td>" + E(x.by) + "</td></tr>";
}

// Value labels at the end of each bar, in text ink (never the bar color).
var mnValueLabels = {
  id: "mnValueLabels",
  afterDatasetsDraw: function (chart) {
    var ctx = chart.ctx;
    chart.data.datasets.forEach(function (ds, i) {
      chart.getDatasetMeta(i).data.forEach(function (bar, j) {
        var v = ds.data[j];
        if (!v) return;
        ctx.save();
        ctx.fillStyle = CT().ink;
        ctx.font = "600 11px 'DM Sans', system-ui, sans-serif";
        if (chart.options.indexAxis === "y") { ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(v, bar.x + 6, bar.y); }
        else { ctx.textAlign = "center"; ctx.textBaseline = "bottom"; ctx.fillText(v, bar.x, bar.y - 4); }
        ctx.restore();
      });
    });
  }
};

function drawMentionCharts(open) {
  if (typeof Chart === "undefined") return;
  var tick = { color: CT().text, font: { size: 11 } };
  var grid = { color: CT().grid };
  var tooltip = { backgroundColor: CT().tooltip, padding: 8, displayColors: false };

  // 1. Open by type — one hue; the axis labels carry identity.
  var counts = {};
  open.forEach(function (x) { counts[x.type] = (counts[x.type] || 0) + 1; });
  var typeIds = Object.keys(MN_TYPE_LABEL).filter(function (k) { return counts[k]; });
  var el1 = $("#mn-bytype");
  if (el1) {
    var max1 = Math.max.apply(null, typeIds.map(function (k) { return counts[k]; }));
    mnCharts.push(new Chart(el1, {
      type: "bar",
      data: { labels: typeIds.map(function (k) { return MN_TYPE_LABEL[k]; }), datasets: [{ label: "Open", data: typeIds.map(function (k) { return counts[k]; }), backgroundColor: CT().blue, borderRadius: 4, borderSkipped: "start", maxBarThickness: 18 }] },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: tooltip },
        scales: { x: { beginAtZero: true, suggestedMax: Math.ceil(max1 * 1.2) || 1, ticks: Object.assign({ precision: 0 }, tick), grid: grid, border: { display: false } },
                  y: { ticks: tick, grid: { display: false }, border: { display: false } } }
      },
      plugins: [mnValueLabels]
    }));
  }

  // 2. Due over the next 4 weeks — Overdue in red (labelled), the rest in the same blue.
  var buckets = [
    { label: "Overdue", n: 0, red: true },
    { label: "This week", n: 0 }, { label: "Next week", n: 0 }, { label: "In 2 weeks", n: 0 }, { label: "In 3 weeks", n: 0 }
  ];
  var later = 0, nodue = 0;
  open.forEach(function (x) {
    if (!x.due) { nodue++; return; }
    if (x.due < today) { buckets[0].n++; return; }
    var days = Math.round((new Date(x.due + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000);
    var w = Math.floor(days / 7);
    if (w < 4) buckets[1 + w].n++; else later++;
  });
  var el2 = $("#mn-byweek");
  if (el2) {
    var max2 = Math.max.apply(null, buckets.map(function (b) { return b.n; }));
    mnCharts.push(new Chart(el2, {
      type: "bar",
      data: { labels: buckets.map(function (b) { return b.label; }), datasets: [{ label: "Due", data: buckets.map(function (b) { return b.n; }), backgroundColor: buckets.map(function (b) { return b.red ? CT().red : CT().blue; }), borderRadius: 4, borderSkipped: "start", maxBarThickness: 34 }] },
      options: {
        responsive: true, maintainAspectRatio: false, layout: { padding: { top: 16 } },
        plugins: { legend: { display: false }, tooltip: tooltip },
        scales: { x: { ticks: tick, grid: { display: false }, border: { display: false } },
                  y: { beginAtZero: true, suggestedMax: Math.ceil(max2 * 1.2) || 1, ticks: Object.assign({ precision: 0 }, tick), grid: grid, border: { display: false } } }
      },
      plugins: [mnValueLabels]
    }));
    var note = [later ? later + " due later" : "", nodue ? nodue + " with no due date" : ""].filter(Boolean).join(" · ");
    if ($("#mn-week-note")) $("#mn-week-note").textContent = note;
  }
}

// The full Pentagon list (collapsed by default); its charts are drawn when opened.
function drawPentagonList() {
  var pt = $("#mn-table"), pe = $("#mn-empty");
  if (!pt) return;
  $("#mn-msg").textContent = mnPentRows.length ? " · " + mnPentRows.length + " document" + (mnPentRows.length === 1 ? "" : "s") : "";
  if (mnPentError) { pe.textContent = mnPentError.message; return; }
  var html = autoTable(mnPentRows);
  if (!html) { pe.textContent = "Nothing found for your Pentagon code."; return; }
  pt.innerHTML = html; pt.style.display = "table"; pe.style.display = "none";
  var all = $("#mn-all");
  if (all && all.open) { try { pentagonCharts("mn", mnPentRows); } catch (x) { console.error(x); } }
}

document.addEventListener("toggle", function (e) {
  var d = e.target;
  if (!d || d.tagName !== "DETAILS" || page !== "mentions") return;
  if (d.dataset.mnGroup) { mnOpen[d.dataset.mnGroup] = d.open; saveMnOpen(); }
  if (d.id === "mn-all" && d.open && mnPentRows.length) { try { pentagonCharts("mn", mnPentRows); } catch (x) { console.error(x); } }
}, true);

document.addEventListener("click", function (e) {
  if (page !== "mentions") return;
  var f = e.target.closest("[data-mn-filter]");
  if (f) { mnFilter = f.dataset.mnFilter; drawMentions(); return; }
  var j = e.target.closest("[data-mn-jump]");
  if (j) {
    var id = j.dataset.mnJump;
    var target = id === "open" ? (document.querySelector("#mn-g-overdue .badge").textContent !== "0" ? "overdue" : "week") : id;
    var d = $("#mn-g-" + target);
    if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }
});

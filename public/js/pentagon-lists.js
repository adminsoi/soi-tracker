"use strict";
// Pentagon lists (RFQs, Quotes, SOs, POs, Invoices).
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- Pentagon lists (RFQs, Quotes, SOs, POs, Invoices) ----
var docState = { view: null, rows: null, marks: {}, showAll: false };
function renderPentagonListShell(view) {
  setTimeout(function () { runPentagonList(view); }, 0);
  return '<div id="plv-toolbar" class="table-toolbar" style="display:none;"></div>' +
    '<div class="table-wrap"><table class="wide" id="plv-table" style="display:none;"></table><div class="empty" id="plv-empty">Loading…</div></div>';
}
function findField(row, exact, subs) {
  var keys = Object.keys(row);
  for (var i = 0; i < exact.length; i++) if (keys.indexOf(exact[i]) !== -1) return exact[i];
  for (var j = 0; j < keys.length; j++) for (var k = 0; k < subs.length; k++) if (keys[j].toUpperCase().indexOf(subs[k]) !== -1) return keys[j];
  return null;
}
function docField(view, row, name) {
  var named = view.fields && view.fields[name];
  if (named && Object.prototype.hasOwnProperty.call(row, named)) return named;
  var g = FIELD_GUESSES[name];
  return g ? findField(row, g[0], g[1]) : null;
}
function markKey(view, docNo) { return view.id === "rfqs" ? docNo : view.id + ":" + docNo; }
function docLabelOf(view) { return view.docLabel || (view.fields && view.fields.docLabel) || "Doc"; }
function findResultRows(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.rows)) return data.rows;
  if (data && Array.isArray(data.result_sets) && data.result_sets[0] && Array.isArray(data.result_sets[0].rows)) return data.result_sets[0].rows;
  return null;
}
function autoTable(rows) {
  if (!rows || !rows.length) return null;
  var cols = [];
  rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (cols.indexOf(k) === -1) cols.push(k); }); });
  return "<thead><tr>" + cols.map(function (c) { return "<th>" + E(c) + "</th>"; }).join("") + "</tr></thead><tbody>" +
    rows.map(function (r) { return "<tr>" + cols.map(function (c) { return '<td style="padding:10px 12px;">' + E(cellText(r[c])) + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody>";
}
function runPentagonList(view) {
  if (!$("#plv-table")) return;
  // Loads the latest rows straight away; there are no filters to set.
  api("/api/pentagon/" + encodeURIComponent(view.queryName), {
    method: "POST",
    body: JSON.stringify({ params: {}, limit: 200 })
  }).then(function (data) {
    if (!$("#plv-table")) return;
    var rows = findResultRows(data);
    if (view.layout === "doc" && rows && rows.length) {
      docState.view = view;
      docState.rows = rows;
      return api("/api/rfq-marks").catch(function () { return {}; }).then(function (m) {
        docState.marks = m || {};
        drawDocTable();
      });
    }
    $("#plv-toolbar").style.display = "none";
    var html = autoTable(rows);
    if (!html) {
      $("#plv-table").style.display = "none";
      $("#plv-empty").style.display = "block";
      $("#plv-empty").textContent = rows && rows.length === 0 ? "Nothing in Pentagon yet." : "No table-shaped data came back.";
      return;
    }
    $("#plv-table").innerHTML = html;
    $("#plv-table").style.display = "table";
    $("#plv-empty").style.display = "none";
  }).catch(function (err) {
    if (!$("#plv-table")) return;
    $("#plv-table").style.display = "none";
    $("#plv-empty").style.display = "block";
    $("#plv-empty").textContent = err.message || "Couldn't load from Pentagon.";
  });
}
function drawDocTable() {
  var view = docState.view, rows = docState.rows || [];
  var table = $("#plv-table"), empty = $("#plv-empty"), bar = $("#plv-toolbar");
  if (!table || !rows.length) return;
  var sample = rows[0], f = {};
  ["key", "part", "party", "person", "due", "notes"].forEach(function (k) { f[k] = docField(view, sample, k); });
  var mgr = isManager();
  var missing = [];
  if (!f.part) missing.push("part number");
  if (!f.person) missing.push("Pentagon user");
  bar.style.display = "flex";
  bar.innerHTML = '<label class="small-note" style="display:flex;gap:6px;align-items:center;cursor:pointer;"><input type="checkbox" class="check" id="plv-all"' + (docState.showAll ? " checked" : "") + "> Show all Pentagon columns</label>" +
    '<span class="small-note">' + (mgr ? "Assign, tick ✓ / ✗ and add notes — managers only." : "Only managers can assign, tick or add notes.") + "</span>" +
    (missing.length ? '<span class="small-note">This query doesn\'t return ' + missing.join(" or ") + " yet.</span>" : "") +
    (f.key ? "" : '<span class="small-note" style="color:var(--danger)">No document number column found, so changes can\'t be saved.</span>');
  // Filters: the visible columns, or every Pentagon column when "Show all".
  var markOf = function (r) { var no = f.key ? cellText(r[f.key]) : ""; return no ? docState.marks[markKey(view, no)] || {} : {}; };
  var dfields;
  if (docState.showAll) {
    var cols = [];
    rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (cols.indexOf(k) === -1) cols.push(k); }); });
    dfields = cols.map(function (c) { return { key: "c:" + c, label: c, get: function (r) { return cellText(r[c]); } }; });
  } else {
    dfields = [
      { key: "part", label: "Part number", get: function (r) { return f.part ? cellText(r[f.part]) : ""; } },
      { key: "party", label: (view.fields && view.fields.partyLabel) || "Customer", get: function (r) { return f.party ? cellText(r[f.party]) : ""; } },
      { key: "person", label: "Pentagon user", get: function (r) { return f.person ? cellText(r[f.person]) : ""; } },
      { key: "due", label: "Due", get: function (r) { return dueBucket(f.due ? cellText(r[f.due]) : ""); } },
      { key: "assigned", label: "Assigned to", get: function (r) { return markOf(r).assignee || "Unassigned"; } },
      { key: "done", label: "Done", get: function (r) { return markOf(r).done ? "Done" : "Not done"; } },
      { key: "notes", label: "Notes", get: function (r) { return markOf(r).notes ? "Has notes" : "No notes"; } }
    ];
  }
  var dscope = "doc:" + view.id + (docState.showAll ? ":all" : "");
  var indexed = rows.map(function (r, i) { return { r: r, i: i }; });
  var kept = applyColFilters(dscope, dfields.map(function (x) { return { key: x.key, label: x.label, get: function (o) { return x.get(o.r); } }; }), indexed);
  bar.innerHTML += filterUi(dscope, dfields, rows, kept.length);
  $("#plv-all").onchange = function () { docState.showAll = this.checked; drawDocTable(); };
  if (docState.showAll) {
    table.innerHTML = autoTable(kept.map(function (o) { return o.r; })) || '<tbody><tr><td class="empty">Nothing matches these filters.</td></tr></tbody>';
  } else {
    var users = mgr ? usersFor("SOI Aviation") : [];
    table.innerHTML = "<thead><tr><th>Part number</th><th>" + E((view.fields && view.fields.partyLabel) || "Customer") + "</th><th>Pentagon user</th><th>Due date</th><th>Assigned to</th><th>Done</th><th>Notes</th></tr></thead><tbody>" +
      (kept.length ? "" : '<tr><td colspan="7" class="empty">Nothing matches these filters.</td></tr>') +
      kept.map(function (o) {
        var r = o.r, i = o.i;
        var docNo = f.key ? cellText(r[f.key]) : "";
        var key = docNo ? markKey(view, docNo) : "";
        var m = key ? docState.marks[key] || {} : {};
        var done = !!m.done;
        var assignee = m.assignee || "";
        var opts = users.concat(assignee && !users.some(function (u) { return sameUser(u, assignee); }) ? [assignee] : []);
        var assign = mgr && key
          ? '<select class="fb-in" data-doc="' + i + '" data-doc-act="assign" aria-label="Assigned to"><option value="">Unassigned</option>' +
            opts.map(function (u) { return '<option value="' + E(u) + '"' + (sameUser(u, assignee) ? " selected" : "") + ">" + E(u) + "</option>"; }).join("") + "</select>"
          : staticCell(assignee);
        var tick = '<button type="button" class="toggle ' + (done ? "yes" : "no") + '" data-doc="' + i + '" data-doc-act="toggle"' + (mgr && key ? "" : " disabled") + ' aria-label="' + (done ? "Done" : "Not done") + '">' + (done ? "✓" : "✗") + "</button>";
        var pnote = f.notes ? cellText(r[f.notes]) : "";
        var notes = (mgr && key
          ? '<textarea class="fb-in fb-notes" rows="1" data-doc="' + i + '" data-doc-act="notes" placeholder="Notes…">' + E(m.notes || "") + "</textarea>"
          : staticCell(m.notes)) + (pnote ? '<span class="co-note">Pentagon: ' + E(pnote) + "</span>" : "");
        var part = f.part ? cellText(r[f.part]) : "";
        return '<tr class="' + (done ? "done" : "") + '"><td><span class="static">' + (part ? E(part) : '<span class="dim">—</span>') + "</span>" +
          (docNo ? '<span class="co-note">' + E(docLabelOf(view)) + " " + E(docNo) + "</span>" : "") + "</td>" +
          "<td>" + staticCell(f.party ? cellText(r[f.party]) : "") + "</td>" +
          "<td>" + staticCell(f.person ? cellText(r[f.person]) : "") + "</td>" +
          "<td>" + staticCell(f.due ? fmtDate(cellText(r[f.due])) : "") + "</td>" +
          "<td>" + assign + '</td><td class="center">' + tick + '</td><td class="notes-cell">' + notes + "</td></tr>";
      }).join("") + "</tbody>";
  }
  table.style.display = "table";
  empty.style.display = "none";
  autosize();
  function info(i) {
    var r = rows[i], docNo = cellText(r[f.key]);
    return {
      key: markKey(view, docNo),
      snapshot: { label: docLabelOf(view), docNo: docNo, party: f.party ? cellText(r[f.party]) : "", dueDate: f.due ? cellText(r[f.due]).slice(0, 10) : "", pentagonUser: f.person ? cellText(r[f.person]) : "" }
    };
  }
  table.querySelectorAll("[data-doc-act]").forEach(function (el) {
    var i = +el.getAttribute("data-doc"), act = el.getAttribute("data-doc-act");
    var send = function (change) {
      var inf = info(i);
      saveMark(view.id, inf.key, inf.snapshot, change).then(function (m) { docState.marks[inf.key] = m; drawDocTable(); refresh(); }).catch(function () {});
    };
    if (act === "toggle") el.onclick = function () { var k = info(i).key; send({ done: !(docState.marks[k] && docState.marks[k].done) }); };
    else if (act === "assign") el.onchange = function () { send({ assignee: el.value }); };
    else el.onchange = function () { send({ notes: el.value }); };
  });
}
var PALETTE = ["#78846c", "#d1a1b3", "#354936", "#c9a35c", "#a96b82", "#bbc6ad", "#8e7d6d", "#633f47"];
// Brighter, clearly different colours for charts on the dark background.
var DARK_PALETTE = ["#5fb37a", "#e07aa0", "#4f8ef0", "#e3b04b", "#b58cf0", "#4fc3c3", "#f08a5d", "#9aa1ad"];
// Chart colours for the current look (light or dark).
function CT() {
  var d = document.documentElement.dataset.theme !== "light";
  return {
    text: d ? "#a9afba" : "#948575", ink: d ? "#eceef2" : "#3f352c", grid: d ? "rgba(255,255,255,0.07)" : "rgba(63,53,44,0.06)",
    tooltip: d ? "#2a2e36" : "#3f352c", palette: d ? DARK_PALETTE : PALETTE,
    sage: d ? "#5fb37a" : "#78846c", sageFill: d ? "rgba(95,179,122,0.18)" : "rgba(120,132,108,0.15)",
    rose: d ? "#e07aa0" : "#d1a1b3", blue: d ? "#4f8ef0" : "#3f6ba8", red: d ? "#ef6b5e" : "#c0504d"
  };
}
function chartOptions(legend, stacked) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: legend ? { position: "bottom", labels: { color: CT().text, boxWidth: 10, font: { size: 10.5 } } } : { display: false } },
    scales: {
      x: { stacked: !!stacked, ticks: { color: CT().text, font: { size: 10.5 } }, grid: { display: false } },
      y: { stacked: !!stacked, beginAtZero: true, ticks: { color: CT().text, precision: 0 }, grid: { color: CT().grid } }
    }
  };
}
function pentagonCharts(prefix, rows) {
  var row = $("#" + prefix + "-charts");
  if (!row) return;
  if (typeof Chart === "undefined" || !rows || !rows.length) { row.style.display = "none"; return; }
  var dateField = findField(rows[0], ["ENTER_DATE", "DOC_DATE", "DOC_DATE_ANY"], ["DATE"]);
  var amountField = findField(rows[0], ["DOC_TOTAL"], ["TOTAL", "AMT", "AMOUNT"]);
  var statusField = findField(rows[0], ["DOC_STATUS"], ["STATUS"]);
  if (!dateField && !statusField) { row.style.display = "none"; return; }
  row.style.display = "grid";
  var lineCard = $("#" + prefix + "-line").closest(".card"), pieCard = $("#" + prefix + "-pie").closest(".card");
  if (dateField && amountField) {
    lineCard.style.display = "block";
    $("#" + prefix + "-line-title").textContent = "Total value over time (" + amountField + ")";
    var byDate = {};
    rows.forEach(function (r) { if (!r[dateField]) return; var d = String(r[dateField]).slice(0, 10); byDate[d] = (byDate[d] || 0) + (parseFloat(r[amountField]) || 0); });
    var days = Object.keys(byDate).sort();
    charts.push(new Chart($("#" + prefix + "-line"), {
      type: "line",
      data: { labels: days, datasets: [{ data: days.map(function (d) { return byDate[d]; }), borderColor: CT().sage, backgroundColor: CT().sageFill, fill: true, tension: 0.25, pointRadius: 2 }] },
      options: chartOptions(false)
    }));
  } else lineCard.style.display = "none";
  if (statusField) {
    pieCard.style.display = "block";
    $("#" + prefix + "-pie-title").textContent = "By " + statusField;
    var by = {};
    rows.forEach(function (r) { var s = r[statusField] === null || r[statusField] === undefined ? "(none)" : String(r[statusField]); by[s] = (by[s] || 0) + 1; });
    var labels = Object.keys(by);
    charts.push(new Chart($("#" + prefix + "-pie"), {
      type: "doughnut",
      data: { labels: labels, datasets: [{ data: labels.map(function (s) { return by[s]; }), backgroundColor: labels.map(function (_, i) { return CT().palette[i % PALETTE.length]; }), borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: "60%", plugins: { legend: { position: "bottom", labels: { color: CT().text, boxWidth: 10, font: { size: 10.5 } } } } }
    }));
  } else pieCard.style.display = "none";
}

// Pentagon cards and RFQ / SO / PO rows save to the same mark.
function saveMark(viewId, key, snapshot, change) {
  setSync("busy", "Saving…");
  return api("/api/rfq-marks/" + encodeURIComponent(key), { method: "PUT", body: JSON.stringify(Object.assign({ view: viewId, snapshot: snapshot }, change)) })
    .then(function (m) {
      setSync("on", "Live");
      if (change.assignee !== undefined) toast(change.assignee ? "Assigned to " + change.assignee + "." : "Unassigned.");
      return m;
    })
    .catch(function (err) { setSync("on", "Live"); if (err.message !== "Session expired") toast("Couldn't save: " + err.message, true); throw err; });
}

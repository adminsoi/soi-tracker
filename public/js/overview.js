"use strict";
// Overview page.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---------- Overview ----------
var breakdown = { at: 0, data: null, error: null };
function showBreakdown() { return isManager() && (activeCompany === "SOI Aviation" || activeCompany === ALL); }
function renderOverview() {
  setBreadcrumb(["Overview", shortCo(activeCompany)]);
  var depts = visibleDepartments();
  var all = depts.reduce(function (acc, d) { return acc.concat(deptItems(d)); }, []);
  var open = all.filter(function (t) { return !isDone(t); }).length;
  var late = all.filter(isOverdue).length;
  if (showBreakdown() && Date.now() - breakdown.at > 60000) {
    breakdown.at = Date.now();
    api("/api/team-breakdown").then(function (d) { breakdown.data = d; breakdown.error = null; requestRender(); })
      .catch(function (err) { breakdown.error = err.message; requestRender(); });
  }
  var html = '<div class="intro"><div><div class="eyebrow">Overview / ' + E(shortCo(activeCompany)) + "</div><h1>Overview · " + E(shortCo(activeCompany)) + "</h1>" +
    "<p>Every department at a glance — tasks made here and Pentagon rows together.</p></div>" + companySwitcher(open) + "</div>" +
    '<div class="summary-cards four">' + metric("Open", open, "Across " + depts.length + " departments") + metric("Overdue", late, "Past due and not done", late > 0) +
    metric("Done", all.filter(isDone).length, "Ticked off") + metric("Total", all.length, all.filter(isCard).length + " from Pentagon") + "</div>" +
    '<div class="grid-2"><div class="card"><div class="card-label">Open and done by department</div><div class="chart-wrap"><canvas id="ov-chart"></canvas></div></div>' +
    '<div class="table-wrap"><table class="plain"><thead><tr><th>Department</th><th>Open</th><th>Overdue</th><th>Done</th><th>Total</th></tr></thead><tbody>' +
    depts.map(function (d) {
      var items = deptItems(d);
      return '<tr><td><a href="#dept/' + encodeURIComponent(d) + '">' + E(d) + "</a></td><td>" + items.filter(function (t) { return !isDone(t); }).length + "</td><td>" + items.filter(isOverdue).length +
        "</td><td>" + items.filter(isDone).length + "</td><td>" + items.length + "</td></tr>";
    }).join("") + "</tbody></table></div></div>";
  if (canSeeItRequests()) html += renderItOverview();
  if (me.leadership) html += renderQbr();
  if (showBreakdown()) html += renderBreakdown();
  return html;
}
// IT requests on the Overview: requests per week (one hue) and open
// requests by internal priority. Details live on IT → Requests.
function itWeeks() {
  var monday = function (d) { d = new Date(d); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
  var start = monday(Date.now()); start.setDate(start.getDate() - 7 * 11);
  var weeks = [];
  for (var i = 0; i < 12; i++) { var w = new Date(start); w.setDate(start.getDate() + 7 * i); weeks.push({ from: w, n: 0 }); }
  (itr.data ? itr.data.requests : []).forEach(function (r) {
    if (r.duplicateOf || r.archived) return;
    var d = new Date(String(r.submittedAt).replace(" ", "T"));
    if (isNaN(d) || d < start) return;
    var i = Math.floor((monday(d) - start) / (7 * 864e5));
    if (weeks[i]) weeks[i].n++;
  });
  return weeks;
}
function renderItOverview() {
  if (!itr.data || Date.now() - itr.at > 120000) loadItRequests();
  var html = '<div class="section-title"><div><h2>IT requests</h2><span class="small-note">From the IT form. Rate and close them on <a href="#dept/IT">IT → Requests</a>.</span></div></div>';
  if (itr.error) return html + '<div class="empty">' + E(itr.error) + "</div>";
  if (!itr.data) return html + '<div class="empty">Loading…</div>';
  var open = itr.data.requests.filter(function (r) { return r.status !== "done" && !r.duplicateOf && !r.archived; });
  var rows = IT_PRIOS.map(function (p) { return { label: p.label, n: open.filter(function (r) { return r.priority === p.id; }).length }; });
  rows.push({ label: "Not rated", n: open.filter(function (r) { return !r.priority; }).length });
  var weeks = itWeeks(), total = weeks.reduce(function (s, w) { return s + w.n; }, 0);
  return html + '<div class="grid-2"><div class="card"><div class="card-label">Requests per week — last 12 weeks (' + total + ")</div>" +
    '<div class="chart-wrap"><canvas id="ov-it-weekly" aria-label="IT requests per week"></canvas></div></div>' +
    '<div class="table-wrap"><table class="plain"><thead><tr><th>Open requests by priority</th><th>Count</th></tr></thead><tbody>' +
    rows.map(function (r) { return "<tr><td>" + E(r.label) + "</td><td>" + r.n + "</td></tr>"; }).join("") +
    "<tr><td><b>Total open</b></td><td><b>" + open.length + "</b></td></tr></tbody></table></div></div>";
}
function renderBreakdown() {
  var d = breakdown.data;
  var html = '<div class="section-title"><div><h2>Team breakdown</h2><span class="small-note">Managers only. ' + E(d && d.windowNote || "") + "</span></div></div>";
  if (breakdown.error) return html + '<div class="empty">' + E(breakdown.error) + "</div>";
  if (!d) return html + '<div class="empty">Loading…</div>';
  var depts = Object.keys(d.departments || {});
  if (!depts.length || !depts.some(function (k) { return d.departments[k].people.length; })) {
    return html + '<div class="banner">Tick <b>Show in team breakdown</b> on each person\'s login in /admin.html (and set their Pentagon code) to see their numbers here.</div>';
  }
  return html + '<div class="grid-2">' + depts.map(function (k, i) {
    var dep = d.departments[k];
    return '<div class="card"><div class="card-label">' + E(k) + ' — by person</div><div class="chart-wrap"><canvas id="bd-chart-' + i + '"></canvas></div>' +
      '<div class="table-wrap" style="margin-top:14px;"><table class="plain"><thead><tr><th>Person</th>' + dep.columns.map(function (c) { return "<th>" + E(c.label) + "</th>"; }).join("") + "</tr></thead><tbody>" +
      dep.people.map(function (p) {
        return "<tr><td>" + E(p.username) + (p.pentagonCode ? ' <span class="small-note">(' + E(p.pentagonCode) + ")</span>" : "") + "</td>" +
          dep.columns.map(function (c) { return "<td>" + (p.counts[c.id] || 0) + "</td>"; }).join("") + "</tr>";
      }).join("") + "</tbody></table></div></div>";
  }).join("") + "</div>";
}
function drawOverviewCharts() {
  if (typeof Chart === "undefined") return;
  var el = $("#ov-chart");
  if (el) {
    var depts = visibleDepartments();
    charts.push(new Chart(el, {
      type: "bar",
      data: {
        labels: depts.map(shortDept),
        datasets: [
          { label: "Open", data: depts.map(function (d) { return deptItems(d).filter(function (t) { return !isDone(t); }).length; }), backgroundColor: CT().rose },
          { label: "Done", data: depts.map(function (d) { return deptItems(d).filter(isDone).length; }), backgroundColor: CT().sage }
        ]
      },
      options: chartOptions(true, true)
    }));
  }
  var itEl = $("#ov-it-weekly");
  if (itEl) {
    var weeks = itWeeks();
    charts.push(new Chart(itEl, {
      type: "bar",
      data: {
        labels: weeks.map(function (w) { return w.from.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }),
        datasets: [{ label: "Requests", data: weeks.map(function (w) { return w.n; }), backgroundColor: CT().blue, borderRadius: 3 }]
      },
      options: chartOptions(false)
    }));
  }
  var d = breakdown.data;
  if (!d || !showBreakdown()) return;
  Object.keys(d.departments || {}).forEach(function (k, i) {
    var c = $("#bd-chart-" + i);
    if (!c) return;
    var dep = d.departments[k];
    charts.push(new Chart(c, {
      type: "bar",
      data: {
        labels: dep.people.map(function (p) { return p.username; }),
        datasets: dep.columns.map(function (col, j) { return { label: col.label, data: dep.people.map(function (p) { return p.counts[col.id] || 0; }), backgroundColor: CT().palette[j % PALETTE.length] }; })
      },
      options: chartOptions(true)
    }));
  });
}

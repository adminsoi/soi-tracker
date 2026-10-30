"use strict";
// Global page.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---------- Global ----------
function renderGlobalShell() {
  setBreadcrumb(["Tools", "Global"]);
  setTimeout(function () {
    setSync("busy", "Loading…");
    api("/api/tasks").then(function (all) {
      setSync("on", "Live");
      var body = $("#globalBody");
      if (!body) return;
      $("#globalSub").textContent = all.length + (all.length === 1 ? " task" : " tasks") + " made in the tracker, across every company.";
      body.innerHTML = myCompanies().map(function (co) {
        var list = all.filter(function (t) { return (t.company || "SOI Aviation") === co; });
        return '<div class="section-title"><div><h2>' + E(co) + '</h2><span class="small-note">' + list.length + " task" + (list.length === 1 ? "" : "s") + "</span></div></div>" +
          '<div class="table-wrap"><table class="plain"><thead><tr><th>Department</th><th>Open</th><th>Overdue</th><th>Done</th><th>Total</th></tr></thead><tbody>' +
          DEPARTMENTS.map(function (d) {
            var dl = list.filter(function (t) { return t.department === d; });
            return "<tr><td>" + E(d) + "</td><td>" + dl.filter(function (t) { return !isDone(t); }).length + "</td><td>" + dl.filter(isOverdue).length + "</td><td>" + dl.filter(isDone).length + "</td><td><strong>" + dl.length + "</strong></td></tr>";
          }).join("") + "</tbody></table></div>";
      }).join("");
    }).catch(function (err) { if (err.message !== "Session expired") { setSync("off", "Sync error"); toast("Couldn't load the global view: " + err.message, true); } });
  }, 0);
  return '<div class="intro"><div><div class="eyebrow">Tools</div><h1>Global — every company</h1><p id="globalSub"></p></div></div><div id="globalBody"><div class="empty">Loading…</div></div>';
}

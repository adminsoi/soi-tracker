"use strict";
// Department pages: tables, column filters, part rows, projects, tasks and Business Development analytics.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---------- Department page ----------
// Tabs for the current sidebar group. Procurement, Purchasing and
// Warehouse share one tab, which opens the last of them you used.
function deptTabs(depts, opsHere, dept) {
  var out = [], opsDone = false;
  depts.forEach(function (d) {
    if (OPS_DEPTS.indexOf(d) !== -1 && opsHere.length > 1) {
      if (opsDone) return;
      opsDone = true;
      var on = opsHere.indexOf(dept) !== -1;
      var to = on ? dept : (lastDeptIn.ops && opsHere.indexOf(lastDeptIn.ops) !== -1 ? lastDeptIn.ops : opsHere[0]);
      var n = opsHere.reduce(function (s, x) { return s + openCount(x); }, 0);
      out.push('<button type="button" role="tab" class="tab ops-tab ' + (on ? "active" : "") + '" aria-selected="' + on + '" data-dept="' + E(to) + '">' +
        E(opsHere.map(shortDept).join(" / ")) + (n ? '<span class="badge">' + n + "</span>" : "") + "</button>");
      return;
    }
    var k = openCount(d);
    out.push('<button type="button" role="tab" class="tab ' + (d === dept ? "active" : "") + '" aria-selected="' + (d === dept) + '" data-dept="' + E(d) + '">' +
      E(shortDept(d)) + (k ? '<span class="badge">' + k + "</span>" : "") + "</button>");
  });
  if (OPS_DEPTS.indexOf(dept) !== -1) lastDeptIn.ops = dept;
  return out.join("");
}

// Master Chat: the AOG CRM spec's one Claude chat that can read the
// tracker and make changes when asked. It needs Claude running inside
// SOI's compliant AWS environment (Bedrock), which compliance still has to
// approve, so for now this says what it will do and opens Claude.
function renderMasterChat() {
  setBreadcrumb(["Tools", "Master Chat"]);
  var row = function (a, b) { return "<tr><td><b>" + a + "</b></td><td>" + b + "</td></tr>"; };
  return '<div class="intro"><div><div class="eyebrow">Tools</div><h1>Master Chat</h1>' +
    "<p>One Claude chat for the whole tracker, replacing the department chats. It isn't switched on yet: it has to run inside SOI's compliant AWS environment (for example Claude on Amazon Bedrock in GovCloud), and the compliance lead has to approve what it can read.</p></div></div>" +
    '<div class="card" style="padding:18px 20px;"><div class="card-label">What it will do</div>' +
    '<table class="plain"><tbody>' +
    row("When asked", "Add notes; create and assign tasks; add tags and flags; search and summarise a quote, order or customer; attach emails and files to a case file; draft emails and quotes (as drafts only).") +
    row("Shows a preview, you confirm", "Move a card to another column; send any email to a client or supplier; change prices or mark-ups; edit or delete existing records; bulk changes.") +
    row("Never", "Give its own ✓ / ✗ approval; clear quality or export holds; enter or generate certificate numbers, NSNs, CAGE codes or export classifications.") +
    "</tbody></table>" +
    '<p class="small-note" style="margin-top:10px;">It will act with your permissions, never more, and every change will be logged as "by assistant for (you)" and be undoable.</p></div>' +
    '<p style="margin-top:16px;"><a class="links-a" href="https://claude.ai/new" target="_blank" rel="noopener noreferrer">Open Claude ↗</a> <span class="small-note">Until then, the header\'s Claude button opens claude.ai. Don\'t paste government client data, contract details or supplier pricing into it.</span></p>';
}
function renderDepartment() {
  var group = deptGroup(activeDept), groupLabel = group === "admin" ? "Administration" : "Departments";
  var depts = activeDept ? deptsIn(group) : visibleDepartments();
  if (activeDept) lastDeptIn[group] = activeDept;
  var opsHere = depts.filter(function (d) { return OPS_DEPTS.indexOf(d) !== -1; });
  if (!activeDept) return '<div class="empty">Your login has no departments yet. Ask an admin to add one.</div>';
  var dept = activeDept;
  var views = pentagonViewsFor(dept);
  var subs = [];
  if (dept === "Accounting & Finance" && canSeeFinance()) subs.push({ id: "finance", label: "Finance" });
  if (dept === "Business Development" && (activeCompany === "SOI Aviation" || (activeCompany === ALL && hasSOI()))) subs.push({ id: "analytics", label: "Analytics" });
  // Warehouse opens on Insights (the first tab is where a department lands).
  if (dept === "Warehouse" && (me.leadership || me.fullAccess || me.departments.indexOf("Warehouse") !== -1)) subs.push({ id: "insights", label: "Insights" });
  // The AOG board: first on Procurement and Purchasing, after Insights on Warehouse.
  if (BOARD_DEPTS.indexOf(dept) !== -1 && canSeeBoardUi()) subs.push({ id: "board", label: "Board" });
  // IT opens on Requests.
  if (dept === "IT" && canSeeItRequests()) subs.push({ id: "requests", label: "Requests" });
  subs.push({ id: "tasks", label: "Tasks" });
  subs.push({ id: "projects", label: "Projects" });
  if (dept === "IT" && me.itNotebook) subs.push({ id: "resolved", label: "Resolved" });
  subs.push({ id: "sops", label: "SOPs" });
  views.forEach(function (v) { subs.push({ id: v.id, label: v.label }); });
  var sub = subView[dept];
  if (!sub || !subs.some(function (s) { return s.id === sub; })) sub = subView[dept] = subs[0].id;

  var totalOpen = depts.reduce(function (s, d) { return s + openCount(d); }, 0);
  setBreadcrumb([groupLabel, shortCo(activeCompany), shortDept(dept)]);

  var links = (DEPARTMENT_RESOURCES[dept] || []).slice();
  if (claudeProjects[dept]) {
    links = links.filter(function (l) { return l.label !== "Claude"; });
    links.push({ label: "Claude project", url: claudeProjects[dept] });
  }
  var linkHtml = links.length ? '<div class="links">' + links.map(function (l) {
    var href = safeLink(l.url);
    return href ? '<a href="' + E(href) + '" target="_blank" rel="noopener noreferrer">' + E(l.label) + " ↗</a>" : "";
  }).join("") + "</div>" : "";

  var head =
    '<div class="intro"><div><div class="eyebrow">' + E(groupLabel) + " / " + E(shortCo(activeCompany)) + "</div>" +
    "<h1>" + E(dept) + " · " + E(shortCo(activeCompany)) + "</h1>" +
    "<p>" + E(DEPT_TAGLINE[dept] || "Projects, sub-tasks and who's responsible for each.") + "</p>" +
    '<p class="small-note">' + (isManager()
      ? "You're a manager: you can assign anything and tick things off."
      : "You can add your own rows. Only a manager ticks things off; anything a manager gave you is read-only.") +
    " · Saved to the SOI server</p>" + linkHtml + "</div>" +
    companySwitcher(totalOpen) + "</div>" +
    '<div class="tabs" role="tablist">' + deptTabs(depts, opsHere, dept) + "</div>" +
    (subs.length > 1 || opsHere.length > 1 ? '<div class="subbar"><div class="seg">' + subs.map(function (s) {
      return '<button type="button" data-sub="' + E(s.id) + '" class="' + (s.id === sub ? "active" : "") + '">' + E(s.label) + "</button>";
    }).join("") + "</div>" +
    // Inside the shared tab: which department's tasks, projects and lists
    // (the board is the same for all three).
    (opsHere.length > 1 && OPS_DEPTS.indexOf(dept) !== -1 && sub !== "board" ? '<div class="seg ops-switch" aria-label="Department">' + opsHere.map(function (d) {
      return '<button type="button" data-ops-dept="' + E(d) + '" class="' + (d === dept ? "active" : "") + '">' + E(shortDept(d)) + "</button>";
    }).join("") + "</div>" : "") + "</div>" : "");

  var body;
  if (sub === "finance") body = renderFinance();
  else if (sub === "analytics") body = renderBdAnalytics();
  else if (sub === "requests") body = renderItRequests();
  else if (sub === "resolved") body = renderNotebook();
  else if (sub === "sops") body = renderSops(dept);
  else if (sub === "insights") body = renderWarehouseInsights();
  else if (sub === "board") body = renderBoard(dept);
  else if (sub === "tasks") body = isOps(dept) ? renderOpsTable(dept) : renderTaskTable(dept);
  else if (sub === "projects") body = renderProjectTable(dept);
  else {
    var view = views.filter(function (v) { return v.id === sub; })[0];
    body = view ? renderPentagonListShell(view) : "";
  }
  return head + body;
}

// Source / person filters shared by both table layouts.
function filtered(list) {
  return list.filter(function (t) {
    if (showSource === "tasks" && isCard(t)) return false;
    if (showSource !== "all" && showSource !== "tasks" && t.view !== showSource) return false;
    if (showPerson && !sameUser(t.owner, showPerson) && !sameUser(t.createdBy, showPerson)) return false;
    return true;
  });
}
function sortRows(list) {
  return list.slice().sort(function (a, b) {
    return Number(isDone(a)) - Number(isDone(b)) ||
      String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")) ||
      (b.createdAt || 0) - (a.createdAt || 0);
  });
}

// ---- Column filters ----
// "+ Filter" → pick a column → pick one of the values actually in it
// (with counts). Filters stack (all must match) and show as chips.
// Each table passes its fields: { key, label, get(row) -> text }.
var colFilters = {}, filterPick = {};
function dueBucket(d) {
  d = String(d || "").slice(0, 10);
  if (!d) return "No due date";
  if (d < today) return "Overdue";
  if (d === today) return "Today";
  var wk = new Date(today + "T00:00:00"); wk.setDate(wk.getDate() + 7);
  return d <= ymdLocal(wk) ? "Next 7 days" : "Later";
}
function ymdLocal(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function fval(f, row) { var v = f.get(row); v = v == null ? "" : String(v).trim(); return v || "—"; }
function applyColFilters(scope, fields, rows) {
  var list = colFilters[scope] || [];
  if (!list.length) return rows;
  var byKey = {}; fields.forEach(function (f) { byKey[f.key] = f; });
  return rows.filter(function (r) {
    return list.every(function (c) { var f = byKey[c.key]; return !f || fval(f, r) === c.value; });
  });
}
function filterUi(scope, fields, rows, shown) {
  var list = (colFilters[scope] = (colFilters[scope] || []).filter(function (c) { return fields.some(function (f) { return f.key === c.key; }); }));
  var byKey = {}; fields.forEach(function (f) { byKey[f.key] = f; });
  var chips = list.map(function (c, i) {
    return '<span class="fchip">' + E(byKey[c.key].label) + ": <b>" + E(c.value) + '</b><button type="button" data-fdel="' + E(scope) + '" data-i="' + i + '" aria-label="Remove filter">✕</button></span>';
  }).join("");
  var pick = filterPick[scope] && byKey[filterPick[scope]];
  var html = '<div class="filter-row">' + chips;
  if (pick) {
    // Values among rows that match the other filters, most common first.
    var base = applyColFilters(scope, fields, rows), counts = {};
    base.forEach(function (r) { var v = fval(pick, r); counts[v] = (counts[v] || 0) + 1; });
    var vals = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b, undefined, { numeric: true }); }).slice(0, 300);
    html += '<select data-fadd-value="' + E(scope) + '" aria-label="' + E(pick.label) + ' is"><option value="">' + E(pick.label) + " is…</option>" +
      vals.map(function (v) { return '<option value="' + E(v) + '">' + E(v.length > 60 ? v.slice(0, 60) + "…" : v) + " (" + counts[v] + ")</option>"; }).join("") + "</select>" +
      '<button type="button" class="text-button" data-fcancel="' + E(scope) + '">Cancel</button>';
  } else {
    html += '<select data-fadd-field="' + E(scope) + '" aria-label="Add a filter"><option value="">+ Filter</option>' +
      fields.map(function (f) { return '<option value="' + E(f.key) + '">' + E(f.label) + "</option>"; }).join("") + "</select>";
  }
  if (list.length) html += '<span class="fcount">' + shown + " of " + rows.length + ' shown</span><button type="button" class="text-button" data-fclear="' + E(scope) + '">Clear filters</button>';
  return html + "</div>";
}
function redrawFor(scope) { if (scope.indexOf("doc:") === 0) drawDocTable(); else render(); }
document.addEventListener("change", function (e) {
  var t = e.target, sc;
  if ((sc = t.dataset && t.dataset.faddField) !== undefined && sc) { filterPick[sc] = t.value; redrawFor(sc); var n = document.querySelector('[data-fadd-value="' + sc + '"]'); if (n) n.focus(); return; }
  if ((sc = t.dataset && t.dataset.faddValue) !== undefined && sc && t.value) {
    (colFilters[sc] = colFilters[sc] || []).push({ key: filterPick[sc], value: t.value });
    filterPick[sc] = ""; redrawFor(sc);
  }
});
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-fdel],[data-fclear],[data-fcancel]");
  if (!t) return;
  var ds = t.dataset;
  if (ds.fdel) { colFilters[ds.fdel].splice(+ds.i, 1); redrawFor(ds.fdel); }
  else if (ds.fclear) { colFilters[ds.fclear] = []; filterPick[ds.fclear] = ""; redrawFor(ds.fclear); }
  else if (ds.fcancel) { filterPick[ds.fcancel] = ""; redrawFor(ds.fcancel); }
});
function personOf(t) { return t.owner || (isCard(t) ? t.assignee : "") || "Unassigned"; }
function taskFields(dept, ops) {
  var f = [];
  if (ops) f.push({ key: "type", label: "Type", get: function (t) { return isCard(t) ? t.docLabel || "Pentagon" : "Task"; } });
  f.push({ key: "owner", label: "Responsible", get: personOf });
  f.push({ key: "status", label: "Status", get: function (t) { return isDone(t) ? "Done" : isOverdue(t) ? "Overdue" : "Open"; } });
  f.push({ key: "due", label: "Due", get: function (t) { return dueBucket(t.dueDate); } });
  if (ops) {
    f.push({ key: "part", label: "Part number", get: function (t) { return t.part; } });
    f.push({ key: "platform", label: "Platform", get: function (t) { return t.platform; } });
    f.push({ key: "customer", label: "Customer", get: function (t) { return t.customer || t.party; } });
    f.push({ key: "obsolete", label: "Obsolete", get: function (t) { return isCard(t) ? "" : t.obsolete || "No"; } });
  } else {
    f.push({ key: "src", label: "Came from", get: function (t) { return t.source === "form" ? (String(t.formResponseId || "").indexOf("manual-") === 0 ? "IT ticket" : "IT form") : "Added here"; } });
  }
  f.push({ key: "by", label: "Added by", get: function (t) { return isCard(t) ? "Pentagon" : t.createdBy; } });
  if (activeCompany === ALL) f.push({ key: "co", label: "Company", get: function (t) { return shortCo(t.company || "SOI Aviation"); } });
  return f;
}

function deptToolbar(dept, addLabel, kind) {
  var views = pentagonViewsFor(dept).filter(function (v) { return v.tasks; });
  var sources = [{ id: "all", label: "All" }, { id: "tasks", label: "Tasks" }].concat(views.map(function (v) { return { id: v.id, label: v.label }; }));
  if (!sources.some(function (s) { return s.id === showSource; })) showSource = "all";
  var html = '<div class="table-toolbar">';
  if (sources.length > 2) {
    html += '<div class="seg">' + sources.map(function (s) {
      return '<button type="button" data-source="' + E(s.id) + '" class="' + (s.id === showSource ? "active" : "") + '">' + E(s.label) + "</button>";
    }).join("") + "</div>";
  }
  if (dept === "IT" && isManager()) {
    html += '<div class="seg">' + [["mine", "Mine"], ["all", "Everyone's"]].map(function (x) {
      return '<button type="button" data-it-scope="' + x[0] + '" class="' + (itScope === x[0] ? "active" : "") + '">' + x[1] + "</button>";
    }).join("") + "</div>";
  }
  if (isManager() && !(dept === "IT" && itScope === "mine")) {
    var people = {};
    deptItems(dept).forEach(function (t) { if (t.owner) people[t.owner] = 1; if (t.createdBy && !isCard(t)) people[t.createdBy] = 1; });
    var names = Object.keys(people).sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
    if (showPerson && names.indexOf(showPerson) === -1) names.unshift(showPerson);
    html += '<select id="personFilter" aria-label="Show one person"><option value="">Everyone</option>' + names.map(function (n) {
      return '<option value="' + E(n) + '"' + (n === showPerson ? " selected" : "") + ">" + E(n) + "</option>";
    }).join("") + "</select>";
  }
  if (activeCompany === ALL) {
    if (!addCompany) addCompany = myCompanies()[0];
    html += '<select id="addCompany" aria-label="Add rows to">' + myCompanies().map(function (c) {
      return '<option value="' + E(c) + '"' + (c === addCompany ? " selected" : "") + ">Add to " + E(shortCo(c)) + "</option>";
    }).join("") + "</select>";
  }
  if (pentagonErrors.length && views.length) html += '<span class="small-note" title="' + E(pentagonErrors.join("; ")) + '">Some Pentagon rows couldn\'t load.</span>';
  html += '<button type="button" class="primary" data-add="' + E(dept + "|" + (kind || "task")) + '">+ ' + E(addLabel) + "</button></div>";
  return html;
}

// ---- inline controls ----
function input(t, key, val, type, placeholder, enabled) {
  var attrs = ' data-id="' + E(t.id) + '" data-key="' + key + '"' + (enabled ? "" : " disabled");
  if (type === "textarea") return '<textarea class="fb-in fb-notes" rows="1"' + attrs + ' placeholder="' + (enabled ? "Notes…" : "") + '">' + E(val) + "</textarea>";
  if (type === "obsolete") {
    return '<select class="fb-in"' + attrs + ">" + ["No", "Yes"].map(function (o) {
      return '<option value="' + o + '"' + ((val || "No") === o ? " selected" : "") + ">" + o + "</option>";
    }).join("") + "</select>";
  }
  return '<input class="fb-in" type="' + (type || "text") + '"' + attrs + ' value="' + E(val) + '" placeholder="' + (enabled ? E(placeholder || "") : "") + '">';
}
function staticCell(v, cls) { return '<span class="static ' + (cls || "") + '">' + (v ? E(v) : '<span class="dim">—</span>') + "</span>"; }
function doneToggle(t) {
  var done = isDone(t);
  var can = isManager() && !t.draft;
  return '<button type="button" class="toggle ' + (done ? "yes" : "no") + '" data-toggle="' + E(t.id) + '"' + (can ? "" : " disabled") +
    ' title="' + (done ? "Done" : "Not done") + (can ? " — click to change" : " — only a manager can change this") + '" aria-label="' + (done ? "Done" : "Not done") + '">' + (done ? "✓" : "✗") + "</button>";
}
function responsibleCell(t) {
  var company = t.company || activeCompany;
  var current = isCard(t) ? t.assignee : t.owner;
  if (!isManager()) return t.draft ? staticCell(deptDefaults[t.department] ? deptDefaults[t.department] + " (department default)" : "You") : staticCell(t.owner);
  var users = usersFor(company).slice();
  if (current && !users.some(function (u) { return sameUser(u, current); })) users.unshift(current);
  var none = isCard(t) && t.pentagonUser ? "Unassigned (" + t.pentagonUser + ")" : "Unassigned";
  return '<select class="fb-in" data-id="' + E(t.id) + '" data-key="owner" aria-label="Responsible"><option value="">' + E(none) + "</option>" +
    users.map(function (u) { return '<option value="' + E(u) + '"' + (sameUser(u, current) ? " selected" : "") + ">" + E(u) + "</option>"; }).join("") + "</select>";
}
function delButton(t) {
  if (t.draft) return '<button type="button" class="del" data-cancel="' + E(t.id) + '" title="Discard" aria-label="Discard new row">×</button>';
  if (isCard(t) || !canEditTask(t)) return "";
  return '<button type="button" class="del" data-del="' + E(t.id) + '" title="Delete" aria-label="Delete">×</button>';
}
function coNote(t) { return activeCompany === ALL && t.company ? '<span class="co-note">' + E(shortCo(t.company)) + "</span>" : ""; }
function metric(label, n, note, alert) {
  return '<div class="metric' + (alert ? " alert" : "") + '"><div class="eyebrow">' + E(label) + "</div><strong>" + E(n) + "</strong><small>" + E(note) + "</small></div>";
}
function legend() {
  return '<p class="small-note" style="margin-top:12px;">Click a cell to edit; changes save when you leave the field. ✓ done · ✗ not done' +
    (isManager() ? " — click to change." : " — only a manager can change it.") +
    " Pentagon rows come straight from Pentagon; their assignee, ✓ and notes are kept here.</p>";
}
function setQuickAdd(label, target) {
  var b = $("#quickAdd");
  b.style.display = "";
  b.textContent = "+ " + label;
  b.dataset.add = target;
}

// ---- Procurement / Purchasing / Warehouse ----
function opsRow(t) {
  var card = isCard(t);
  var ed = t.draft || (!card && canEditTask(t));
  var cls = (isDone(t) ? "done " : "") + (isOverdue(t) ? "overdue " : "") + (t.draft ? "draft" : "");
  var nameCell = card
    ? '<span class="static"><strong>' + E(t.docLabel + " " + t.docNo) + '</strong><span class="src">PENTAGON</span></span>'
    : input(t, "title", t.title, "text", "Task", ed);
  return '<tr class="' + cls + '">' +
    "<td>" + nameCell + coNote(t) + addedNote(t) + "</td>" +
    "<td>" + (card ? staticCell(t.part) : input(t, "part", t.part, "text", "Part number", ed)) + "</td>" +
    "<td>" + (card ? staticCell("") : input(t, "platform", t.platform, "text", "Aircraft", ed)) + "</td>" +
    "<td>" + (card ? staticCell(t.party) : input(t, "customer", t.customer, "text", "Customer", ed)) + "</td>" +
    "<td>" + (card ? staticCell("") : input(t, "obsolete", t.obsolete, "obsolete", "", ed)) + "</td>" +
    "<td>" + (card ? '<span class="static due-static">' + (t.dueDate ? E(fmtDate(t.dueDate)) : '<span class="dim">—</span>') + "</span>" : input(t, "dueDate", t.dueDate, "date", "", ed)) + "</td>" +
    "<td>" + responsibleCell(t) + "</td>" +
    '<td class="center">' + doneToggle(t) + "</td>" +
    '<td class="notes-cell">' + input(t, "notes", t.notes, "textarea", "", card ? isManager() : ed) + "</td>" +
    "<td>" + delButton(t) + "</td></tr>";
}
function renderOpsTable(dept) {
  var all = deptItems(dept).filter(function (t) { return itemKind(t) === "task"; });
  var fields = taskFields(dept, true), scope = "ops:" + dept;
  var pre = filtered(all), list = sortRows(applyColFilters(scope, fields, pre));
  var ds = drafts.filter(function (d) { return d.department === dept && !d.parentId && d.kind !== "project"; });
  var open = all.filter(function (t) { return !isDone(t); }).length;
  var late = all.filter(isOverdue).length;
  setQuickAdd("Add task", dept + "|task");
  return '<div class="summary-cards">' +
    metric("Open", open, "of " + all.length + " item" + (all.length === 1 ? "" : "s")) +
    metric("Overdue", late, "Past due and not done", late > 0) +
    metric("Obsolete", all.filter(function (t) { return t.obsolete === "Yes"; }).length, "Flagged obsolete") + "</div>" +
    deptToolbar(dept, "Add task", "task") + filterUi(scope, fields, pre, list.length) +
    '<div class="table-wrap"><table class="wide"><thead><tr><th>Task</th><th>Part number</th><th>Platform (aircraft)</th><th>Customer</th><th>Obsolete</th><th>Due date</th><th>Responsible</th><th>Done</th><th>Notes</th><th></th></tr></thead><tbody>' +
    (ds.length || list.length ? ds.map(opsRow).join("") + list.map(opsRow).join("") : '<tr><td colspan="10" class="empty">Nothing here yet. Add a row above.</td></tr>') +
    "</tbody></table></div>" + legend();
}

// ---- Projects with sub-tasks (IT, Admin, HR and the rest) ----
function projectRow(p, subs) {
  var ed = p.draft || canEditTask(p);
  var doneSubs = subs.filter(isDone).length;
  var cls = "project " + (isDone(p) ? "done " : "") + (isOverdue(p) ? "overdue " : "") + (p.draft ? "draft" : "");
  var tools = (!p.draft && ed ? '<button type="button" class="text-button" data-add-sub="' + E(p.id) + '">+ Sub-task</button>' : "") + delButton(p);
  return '<tr class="' + cls + '"><td>' + input(p, "title", p.title, "text", "Project name", ed) +
    '<span class="co-note">' + (subs.length ? doneSubs + "/" + subs.length + " sub-tasks done" : "No sub-tasks yet") + (activeCompany === ALL && p.company ? " · " + E(shortCo(p.company)) : "") + "</span>" + addedNote(p) + "</td>" +
    "<td>" + responsibleCell(p) + "</td><td>" + input(p, "dueDate", p.dueDate, "date", "", ed) + "</td>" +
    '<td class="center">' + doneToggle(p) + '</td><td class="notes-cell">' + input(p, "notes", p.notes, "textarea", "", ed) + "</td>" +
    '<td class="row-tools">' + tools + "</td></tr>";
}
function subRow(s) {
  var ed = s.draft || canEditTask(s);
  var cls = (isDone(s) ? "done " : "") + (isOverdue(s) ? "overdue " : "") + (s.draft ? "draft" : "");
  return '<tr class="' + cls + '"><td><div class="name-cell"><span class="indent">↳</span>' + input(s, "title", s.title, "text", "Sub-task", ed) + "</div>" + addedNote(s) + "</td>" +
    "<td>" + responsibleCell(s) + "</td><td>" + input(s, "dueDate", s.dueDate, "date", "", ed) + "</td>" +
    '<td class="center">' + doneToggle(s) + '</td><td class="notes-cell">' + input(s, "notes", s.notes, "textarea", "", ed) + "</td>" +
    '<td class="row-tools">' + delButton(s) + "</td></tr>";
}
function renderProjectTable(dept) {
  var all = deptTasks(dept).filter(function (t) { return itemKind(t) !== "task"; });
  var ids = {};
  all.forEach(function (t) { ids[t.id] = true; });
  var tops = all.filter(function (t) { return !t.parentId || !ids[t.parentId]; });
  var subsOf = function (p) {
    return all.filter(function (s) { return s.parentId === p.id; })
      .concat(drafts.filter(function (d) { return d.parentId === p.id; }))
      .sort(function (a, b) { return (a.createdAt || 9e15) - (b.createdAt || 9e15); });
  };
  var pfields = [
    { key: "owner", label: "Responsible", get: personOf },
    { key: "status", label: "Status", get: function (t) { return isDone(t) ? "Done" : isOverdue(t) ? "Overdue" : "Open"; } },
    { key: "due", label: "Due", get: function (t) { return dueBucket(t.dueDate); } },
    { key: "subs", label: "Sub-tasks", get: function (p) { var n = all.filter(function (x) { return x.parentId === p.id; }); return !n.length ? "None" : n.every(isDone) ? "All done" : "Some open"; } },
    { key: "by", label: "Added by", get: function (t) { return t.createdBy; } }
  ];
  if (activeCompany === ALL) pfields.push({ key: "co", label: "Company", get: function (t) { return shortCo(t.company || "SOI Aviation"); } });
  var pscope = "proj:" + dept;
  var preTops = filtered(tops);
  var shown = sortRows(applyColFilters(pscope, pfields, preTops));
  // A project also shows when one of its sub-tasks belongs to the chosen person.
  if (showPerson) {
    tops.forEach(function (p) {
      if (shown.indexOf(p) === -1 && filtered(subsOf(p).filter(function (s) { return !s.draft; })).length) shown.push(p);
    });
  }
  var ds = drafts.filter(function (d) { return d.department === dept && !d.parentId && d.kind === "project"; });
  var open = all.filter(function (t) { return !isDone(t); }).length;
  var late = all.filter(isOverdue).length;
  setQuickAdd("Add project", dept + "|project");
  var rows = ds.map(function (d) { return projectRow(d, []); }).join("") +
    shown.map(function (p) { var subs = subsOf(p); return projectRow(p, subs.filter(function (s) { return !s.draft; })) + subs.map(subRow).join(""); }).join("");
  return '<div class="summary-cards">' +
    metric("Projects", tops.length, tops.filter(function (p) { return !isDone(p); }).length + " still open") +
    metric("Open items", open, "Projects and sub-tasks not done") +
    metric("Overdue", late, "Past due and not done", late > 0) + "</div>" +
    deptToolbar(dept, "Add project", "project") + filterUi(pscope, pfields, preTops, shown.length) +
    '<div class="table-wrap"><table class="wide"><thead><tr><th>Project / sub-task</th><th>Person responsible</th><th>Due date</th><th>Done</th><th>Notes</th><th></th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="6" class="empty">No projects yet. Projects are longer-term work with sub-tasks — add one above.</td></tr>') +
    "</tbody></table></div>" + legend();
}

// ---- Tasks (quick, one-off) for IT, Admin, HR and the rest ----
function srcNote(t) {
  var bits = [];
  if (t.source === "form") bits.push((String(t.formResponseId || "").indexOf("manual-") === 0 ? "IT ticket" : "From the IT form") + (t.requester ? " · " + t.requester : ""));
  if (activeCompany === ALL && t.company) bits.push(shortCo(t.company));
  return bits.length ? '<span class="co-note">' + E(bits.join(" · ")) + "</span>" : "";
}
function taskRow(t) {
  var ed = t.draft || canEditTask(t);
  var cls = (isDone(t) ? "done " : "") + (isOverdue(t) ? "overdue " : "") + (t.draft ? "draft" : "");
  return '<tr class="' + cls + '"><td>' + input(t, "title", t.title, "text", "Task", ed) + srcNote(t) + addedNote(t) + "</td>" +
    "<td>" + responsibleCell(t) + "</td><td>" + input(t, "dueDate", t.dueDate, "date", "", ed) + "</td>" +
    '<td class="center">' + doneToggle(t) + '</td><td class="notes-cell">' + input(t, "notes", t.notes, "textarea", "", ed) + "</td>" +
    '<td class="row-tools">' + delButton(t) + "</td></tr>";
}
function renderTaskTable(dept) {
  var all = deptTasks(dept).filter(function (t) { return itemKind(t) === "task"; });
  var fields = taskFields(dept, false), scope = "tasks:" + dept;
  var pre = filtered(all), list = sortRows(applyColFilters(scope, fields, pre));
  var ds = drafts.filter(function (d) { return d.department === dept && !d.parentId && d.kind !== "project"; });
  var open = all.filter(function (t) { return !isDone(t); }).length;
  var late = all.filter(isOverdue).length;
  setQuickAdd("Add task", dept + "|task");
  return '<div class="summary-cards">' +
    metric("Open", open, "of " + all.length + " task" + (all.length === 1 ? "" : "s")) +
    metric("Overdue", late, "Past due and not done", late > 0) +
    metric("Done", all.filter(isDone).length, "Ticked off") + "</div>" +
    deptToolbar(dept, "Add task", "task") + filterUi(scope, fields, pre, list.length) +
    '<div class="table-wrap"><table class="wide"><thead><tr><th>Task</th><th>Person responsible</th><th>Due date</th><th>Done</th><th>Notes</th><th></th></tr></thead><tbody>' +
    (ds.length || list.length ? ds.map(taskRow).join("") + list.map(taskRow).join("") : '<tr><td colspan="6" class="empty">No tasks yet. Tasks are quick, one-off items — add one above. Longer work goes under Projects.</td></tr>') +
    "</tbody></table></div>" + legend();
}

// ---- Business Development analytics (Pentagon) ----
// Number tiles plus customer and by-person tables. Charts live on the
// Overview tab only, so department pages stay tables and numbers.
var bdDays = 30, bdData = null, bdLoading = false;
function renderBdAnalytics() {
  setQuickAdd("Add project", "Business Development");
  if (!bdData || bdData.days !== bdDays) {
    if (!bdLoading) {
      bdLoading = true;
      api("/api/analytics/business-development?days=" + bdDays).then(function (d) { bdData = d; bdLoading = false; requestRender(); })
        .catch(function (err) { bdData = { days: bdDays, error: err.message }; bdLoading = false; requestRender(); });
    }
    return '<div class="empty">Loading analytics…</div>';
  }
  if (bdData.error) return '<div class="banner">' + E(bdData.error) + "</div>";
  var d = bdData;
  var byId = {};
  d.summary.forEach(function (x) { byId[x.id] = x; });
  var tile = function (id, label) {
    var x = byId[id] || { count: 0, value: 0 };
    var note = x.error ? x.error : x.hasValue ? money(x.value) + " total" : "No value column";
    return metric(label, x.error ? "—" : x.count, note);
  };
  var errors = d.summary.filter(function (x) { return x.error; });
  var capped = d.summary.filter(function (x) { return x.capped; });
  return '<div class="table-toolbar" style="margin-top:16px;"><span class="small-note">Last</span><div class="seg">' + [30, 90].map(function (n) {
      return '<button type="button" data-bd-days="' + n + '" class="' + (n === bdDays ? "active" : "") + '">' + n + " days</button>";
    }).join("") + '</div><span class="small-note">From Pentagon, refreshed every 5 minutes</span></div>' +
    (errors.length ? '<div class="banner">Not available yet: ' + E(errors.map(function (x) { return x.label + " (" + x.error + ")"; }).join(" · ")) + ".</div>" : "") +
    (capped.length ? '<div class="banner">' + E(capped.map(function (x) { return x.label; }).join(", ")) + " hit the query's 200-row limit, so totals may be low for this range. Raise <b>TOP 200</b> in those queries to see everything.</div>" : "") +
    '<div class="summary-cards four">' + tile("rfqs", "RFQs received") + tile("quotes", "Quotes") + tile("sales_orders", "Sales orders") + tile("purchase_orders", "Purchase orders") + "</div>" +
    '<div class="grid-2">' +
    '<div class="table-wrap"><table class="plain"><thead><tr><th>Customer</th><th>RFQs</th><th>Quotes</th><th>Sales orders</th><th>SO value</th></tr></thead><tbody>' +
    (d.topCustomers.length ? d.topCustomers.map(function (c) {
      var g = function (id) { return (c.data[id] || {}).count || 0; };
      return "<tr><td>" + E(c.name) + "</td><td>" + g("rfqs") + "</td><td>" + g("quotes") + "</td><td>" + g("sales_orders") + "</td><td>" + E(c.soValue ? money(c.soValue) : "—") + "</td></tr>";
    }).join("") : '<tr><td colspan="5" class="empty">No customer activity in this range.</td></tr>') + "</tbody></table></div>" +
    '<div class="table-wrap"><table class="plain"><thead><tr><th>Person (Pentagon contact)</th><th>RFQs</th><th>Quotes</th><th>SOs</th><th>POs</th></tr></thead><tbody>' +
    (d.byPerson.length ? d.byPerson.map(function (p) {
      var g = function (id) { return p.data[id] || 0; };
      return "<tr><td>" + E(p.name) + "</td><td>" + g("rfqs") + "</td><td>" + g("quotes") + "</td><td>" + g("sales_orders") + "</td><td>" + g("purchase_orders") + "</td></tr>";
    }).join("") : '<tr><td colspan="5" class="empty">No Pentagon contacts in this range.</td></tr>') + "</tbody></table></div></div>" +
    '<p class="small-note" style="margin-top:12px;">People are matched by the Pentagon code on their login and only counted in their own department\'s lists (RFQs and quotes for Procurement, sales and purchase orders for Purchasing). Business Development projects are under <b>Projects</b>.</p>';
}
document.addEventListener("click", function (e) {
  var b = e.target.closest && e.target.closest("[data-bd-days]");
  if (!b) return;
  bdDays = +b.dataset.bdDays;
  render();
});

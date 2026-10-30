"use strict";
// Constants, state, helpers, permissions, sign-in, data loading, routing and the main render.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---------- Constants ----------
var TOKEN_KEY = "soi_tracker_token";
var REMEMBER_KEY = "soi_tracker_remember_user";
var COMPANY_KEY = "soi_tracker_company";
var ALL = "AOG"; // "All companies" (full-access accounts with more than one company)
var COMPANY_ORDER = ["SOI Aviation", "CAS", "RedSun Aviation", "NanoTech Aviation"];
var COMPANY_SHORT = { "SOI Aviation": "SOI", "CAS": "CAS", "RedSun Aviation": "RedSun", "NanoTech Aviation": "Nano" };
// Tab order follows the design; anything else the server lists comes after.
var DEPT_ORDER = ["Procurement", "Purchasing", "Warehouse", "IT", "Administrative", "HR", "Accounting & Finance", "Business Development", "US Government"];
var DEPT_SHORT = { "Administrative": "Admin", "Accounting & Finance": "Finance", "Business Development": "Business Dev" };
var DEPT_TAGLINE = {
  "Business Development": "Pipeline analytics from Pentagon — RFQs, quotes and orders — plus business development projects.",
  "Procurement": "Parts, platforms and customers, plus RFQs and quotes from Pentagon.",
  "Purchasing": "Parts, platforms and customers, plus sales and purchase orders from Pentagon.",
  "Warehouse": "Parts, platforms and customers moving through the warehouse.",
  "Accounting & Finance": "Bank balances, payments to approve, expected receipts and tasks."
};
// Procurement / Purchasing / Warehouse use part rows; everything else is projects with sub-tasks.
var OPS_DEPTS = ["Procurement", "Purchasing", "Warehouse"];
// Sidebar groups: IT, Admin, HR and Finance live under Administration;
// everything else under Departments, where Procurement, Purchasing and
// Warehouse share one tab (and one board).
var ADMIN_DEPTS = ["IT", "Administrative", "HR", "Accounting & Finance"];
var lastDeptIn = {}; // group -> last department opened there
function deptGroup(d) { return ADMIN_DEPTS.indexOf(d) !== -1 ? "admin" : "main"; }
function deptsIn(group) { return visibleDepartments().filter(function (d) { return deptGroup(d) === group; }); }
function groupHome(group) {
  var list = deptsIn(group), last = lastDeptIn[group];
  return last && list.indexOf(last) !== -1 ? last : list[0] || "";
}
var DEPARTMENTS_FALLBACK = ["Procurement", "Purchasing", "IT", "HR", "Business Development", "US Government", "Warehouse", "Administrative", "Accounting & Finance"];

// Quick links per department. The department's Claude project (set in
// /admin.html) is added automatically.
var DEPARTMENT_RESOURCES = {
  "Procurement": [
    { label: "ILS", url: "https://www.ilsmart.com" },
    { label: "PartsBase", url: "https://www.partsbase.com" },
    { label: "Claude", url: "https://claude.ai" }
  ]
};

// Fallback copy of the Pentagon views; the real list comes from
// /api/pentagon-views (pentagonViews.js on the server).
var PENTAGON_VIEWS = {
  "Procurement": [
    { id: "rfqs", label: "RFQs", docLabel: "RFQ", queryName: "dashboards.rfq", layout: "doc", tasks: true,
      fields: { key: "RFQ_NO", part: "PN", party: "ACCOUNT_NAME", partyLabel: "Customer", person: "OURCONTACT", due: "DUE_DATE", notes: "NOTES" } },
    { id: "quotes", label: "Quotes", docLabel: "Quote", queryName: "dashboards.quotes", layout: "doc", tasks: true,
      fields: { key: "QUOTE_NO", part: "PN", party: "ACCOUNT_NAME", partyLabel: "Customer", person: "OURCONTACT", due: "DUE_DATE", notes: "NOTES" } }
  ],
  "Purchasing": [
    { id: "sales_orders", label: "Sales Orders", docLabel: "SO", queryName: "dashboards.so", layout: "doc", tasks: true,
      fields: { key: "SO_NO", part: "PN", party: "ACCOUNT_NAME", partyLabel: "Customer", person: "OURCONTACT", due: "DUE_DATE", notes: "NOTES" } },
    { id: "purchase_orders", label: "Purchase Orders", docLabel: "PO", queryName: "dashboards.po", layout: "doc", tasks: true,
      fields: { key: "PO_NO", part: "PN", party: "ACCOUNT_NAME", partyLabel: "Vendor", person: "OURCONTACT", due: "DUE_DATE", notes: "NOTES" } }
  ],
  "Accounting & Finance": [
    { id: "invoices", label: "Invoices", docLabel: "Invoice", queryName: "dashboards.invoice_search", layout: "raw" }
  ]
};
var FIELD_GUESSES = {
  key: [["RFQ_NO", "QUOTE_NO", "QT_NO", "PO_NO", "SO_NO", "DOC_NO", "RFQ_NUMBER", "DOC_NUMBER"], ["_NO", "NUMBER"]],
  part: [["PN", "PART_NUMBER", "PART_NO", "PARTNO"], ["PART"]],
  party: [["ACCOUNT_NAME", "CUSTOMER", "CUSTOMER_NAME", "VENDOR", "VENDOR_NAME", "COMPANY_NAME"], ["ACCOUNT_NAME", "CUSTOMER", "VENDOR", "COMPANY"]],
  person: [["OURCONTACT", "BUYER", "SALESPERSON", "ENTERED_BY"], ["OURCONTACT", "BUYER", "SALES", "ENTERED_BY"]],
  due: [["DUE_DATE", "DATE_DUE", "REQUIRED_DATE"], ["DUE"]],
  notes: [["NOTES", "REMARKS", "COMMENTS"], ["NOTE", "REMARK", "COMMENT"]]
};

// ---------- State ----------
var me = null;
var DEPARTMENTS = [];
var activeCompany = null;
var page = "departments";        // departments | overview | mentions | inbox | calendar | global
var activeDept = null;
var subView = {};                // dept -> "tasks" | "projects" | "finance" | … | Pentagon view id
var tasks = [];                  // tasks made in the tracker
var cards = [];                  // Pentagon rows as task-shaped cards
var pentagonErrors = [];
var drafts = [];                 // new rows not saved yet (need a name or part number first)
var showSource = "all";          // all | tasks | <Pentagon view id>
var showPerson = "";
var addCompany = null;           // which company "+ Add row" uses on the All view
var claudeProjects = {};
var deptDefaults = {};           // department -> default person (set in /admin.html)
var usersByCompany = {};         // company -> [usernames] (managers only)
var finance = null;              // { company, data } or { company, error }
var loadedOnce = false;
var pollTimer = null;
var renderPending = false;
var focusAfter = null;
var charts = [];
// Local date (not UTC), so "today" and "overdue" don't flip early in the evening.
var today = (function (d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })(new Date());

// ---------- Helpers ----------
function $(s) { return document.querySelector(s); }
function E(s) {
  return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function sameUser(a, b) { return String(a || "").toLowerCase() === String(b || "").toLowerCase(); }
// "Remember me" keeps the sign-in in localStorage (30 days, survives
// closing the browser); otherwise it's in sessionStorage and ends when the
// browser closes.
function token() {
  try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
}
function setToken(t, remember) {
  try {
    clearToken();
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, t);
  } catch (e) {}
}
function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
}
function fmtDate(s) {
  if (!s) return "";
  var d = new Date(String(s).slice(0, 10) + "T00:00:00");
  return isNaN(d) ? String(s) : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function fmtTime(s) {
  if (!s) return "";
  var d = new Date(s);
  return isNaN(d) ? String(s) : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function money(n) { n = Number(n); return isNaN(n) ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" }); }
function sum(arr, k) { return arr.reduce(function (s, r) { return s + (Number(r[k]) || 0); }, 0); }
function isDone(t) { return t.status === "done"; }
function isOverdue(t) { return !!t.dueDate && !isDone(t) && t.dueDate < today; }
function shortCo(c) { return c === ALL ? "All" : (COMPANY_SHORT[c] || c); }
function shortDept(d) { return DEPT_SHORT[d] || d; }
function isOps(d) { return OPS_DEPTS.indexOf(d) !== -1; }
function isCard(t) { return t.source === "pentagon"; }
// "Added by alice · Oct 19, 2026, 2:15 PM" under a task's name.
function addedNote(t) {
  if (t.draft || isCard(t) || !(t.createdAt > 1e11)) return "";
  var by = t.createdBy && t.createdBy !== "IT request form" ? t.createdBy : "";
  var d = new Date(t.createdAt);
  return '<span class="co-note" title="' + E(d.toLocaleString()) + '">Added ' + (by ? "by " + E(by) + " · " : "") +
    E(d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })) + "</span>";
}
// Tasks are quick one-off items; projects are long-term and hold sub-tasks.
// Older rows have no kind: Procurement / Purchasing / Warehouse rows and
// IT form tickets are tasks, everything else was a project.
function itemKind(t) {
  if (t.parentId) return "sub";
  if (t.kind === "task" || t.kind === "project") return t.kind;
  if (isCard(t) || t.source === "form" || isOps(t.department)) return "task";
  return "project";
}
function safeLink(url) {
  try { var u = new URL(url); return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null; } catch (e) { return null; }
}
function cellText(v) { return v === null || v === undefined ? "" : String(v); }

var toastTimer = null;
function toast(msg, isError) {
  var el = $("#toast");
  el.textContent = msg;
  el.className = (isError ? "error " : "") + "show";
  clearTimeout(toastTimer);
  // Long messages and problems stay up long enough to read.
  toastTimer = setTimeout(function () { el.className = ""; }, Math.min(15000, Math.max(isError ? 8000 : 3400, String(msg).length * 55)));
}
function setSync(state, text) {
  $("#syncDot").className = "live-dot" + (state === "off" ? " off" : state === "busy" ? " busy" : "");
  $("#syncText").textContent = text;
}

function api(path, options) {
  options = options || {};
  var headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  var t = token();
  if (t) headers.Authorization = "Bearer " + t;
  return fetch(path, Object.assign({}, options, { headers: headers })).then(function (res) {
    if (res.status === 401) { signOut(); throw new Error("Session expired"); }
    if (res.status === 204) return null;
    return res.json().then(function (data) {
      if (!res.ok) throw new Error(data.error || "Request failed");
      return data;
    });
  });
}

// ---------- Who can do what (the server enforces all of this) ----------
function isManager() { return !!(me && (me.fullAccess || me.manager)); }
function canEditTask(t) {
  if (isCard(t)) return isManager();
  return isManager() || sameUser(t.createdBy, me.username);
}
function visibleDepartments() {
  var list = me.fullAccess ? DEPARTMENTS.slice() : me.departments.slice();
  return list.sort(function (a, b) {
    var ia = DEPT_ORDER.indexOf(a), ib = DEPT_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}
function myCompanies() {
  return me.companies.slice().sort(function (a, b) {
    var ia = COMPANY_ORDER.indexOf(a), ib = COMPANY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}
function canUseAll() { return me.fullAccess && me.companies.length > 1; }
function hasSOI() { return me.companies.indexOf("SOI Aviation") !== -1; }
function canSeeFinance() {
  return activeCompany !== ALL && (me.fullAccess || me.departments.indexOf("Accounting & Finance") !== -1);
}
function pentagonViewsFor(dept) {
  var soi = activeCompany === "SOI Aviation" || (activeCompany === ALL && hasSOI());
  return soi ? (PENTAGON_VIEWS[dept] || []) : [];
}

// ---------- Sign in / out ----------
function showLogin() {
  $("#loginScreen").style.display = "flex";
  $("#app").classList.add("app-hidden");
  // Fill in the remembered username and keep "Remember me" ticked.
  var saved = ""; try { saved = localStorage.getItem(REMEMBER_KEY) || ""; } catch (x) {}
  if (saved) {
    $("#li-remember").checked = true;
    if (!$("#li-user").value) { $("#li-user").value = saved; setTimeout(function () { $("#li-pass").focus(); }, 0); }
  }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
function signOut() { clearToken(); me = null; showLogin(); }
$("#logoutBtn").addEventListener("click", signOut);
// Light / Dark look (remembered on this device; dark is the default).
function applyTheme() {
  var dark = document.documentElement.dataset.theme !== "light";
  $("#themeBtn").textContent = dark ? "☀ Light" : "☾ Dark";
  if (window.Chart) { Chart.defaults.color = dark ? "#a9afba" : "#666"; Chart.defaults.borderColor = dark ? "#2b2f37" : "rgba(0,0,0,0.1)"; }
}
$("#themeBtn").addEventListener("click", function () {
  var next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("soi_tracker_theme", next); } catch (e) {}
  applyTheme();
  if (me) render();
});
applyTheme();

$("#loginForm").addEventListener("submit", function (e) {
  e.preventDefault();
  var msg = $("#loginMsg");
  msg.textContent = "";
  fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: $("#li-user").value.trim(), password: $("#li-pass").value, remember: $("#li-remember").checked })
  }).then(function (res) {
    return res.json().then(function (data) { if (!res.ok) throw new Error(data.error || "Sign-in failed"); return data; });
  }).then(function (data) {
    var remember = $("#li-remember").checked;
    setToken(data.token, remember);
    // Remember the username (never the password) for next time.
    try { if (remember) localStorage.setItem(REMEMBER_KEY, $("#li-user").value.trim()); else localStorage.removeItem(REMEMBER_KEY); } catch (x) {}
    me = data;
    $("#li-pass").value = "";
    onSignedIn();
  }).catch(function (err) { msg.textContent = err.message; });
});

function onSignedIn() {
  me.departments = me.departments || [];
  if (me.performance) setTimeout(loadPerf, 1500);
  var saved = null;
  try { saved = localStorage.getItem(COMPANY_KEY); } catch (e) {}
  var ok = saved && ((saved === ALL && canUseAll()) || me.companies.indexOf(saved) !== -1);
  activeCompany = ok ? saved : myCompanies()[0];
  $("#whoName").textContent = me.username;
  $("#whoRole").textContent = (me.fullAccess ? "Full access" : me.departments.join(", ")) + (isManager() ? " · Manager" : "");
  $("#loginScreen").style.display = "none";
  $("#app").classList.remove("app-hidden");
  api("/api/departments").then(function (d) { DEPARTMENTS = d; }).catch(function () { DEPARTMENTS = DEPARTMENTS_FALLBACK; }).then(function () {
    var depts = visibleDepartments();
    if (!activeDept || depts.indexOf(activeDept) === -1) activeDept = depts[0] || null;
    readHash();
    render();
    refresh();
    if (!pollTimer) pollTimer = setInterval(function () { if (!document.hidden) refresh(); }, POLL_MS);
  });
  api("/api/pentagon-views").then(function (cfg) {
    if (cfg && cfg.views) PENTAGON_VIEWS = cfg.views;
    if (cfg && cfg.guesses) FIELD_GUESSES = cfg.guesses;
    requestRender();
  }).catch(function () {});
  api("/api/claude-projects").then(function (p) { claudeProjects = p || {}; requestRender(); }).catch(function () {});
  api("/api/department-defaults").then(function (d) { deptDefaults = d || {}; requestRender(); }).catch(function () {});
  loadInbox(true);
}

// ---------- Data ----------
// Background sync: every 30 seconds, paused while the tab is hidden, and it
// only redraws when something actually changed — and only on pages built
// from that data. Calendar, Mentions you, Global and Pentagon load their
// own data once and are left alone, so (for example) the HR calendar
// doesn't reload under you.
var POLL_MS = 30000;
var lastSnapshot = "";
function pageUsesLiveData() {
  if (page === "overview") return true;
  if (page !== "departments") return false;
  var sub = subView[activeDept];
  return !sub || sub === "tasks" || sub === "projects" || sub === "finance";
}
document.addEventListener("visibilitychange", function () { if (!document.hidden && me) refresh(); });

function refresh() {
  if (!me) return;
  setSync("busy", "Syncing…");
  var url = activeCompany === ALL ? "/api/tasks" : "/api/tasks?company=" + encodeURIComponent(activeCompany);
  var wantCards = activeCompany === "SOI Aviation" || (activeCompany === ALL && hasSOI());
  var pentagon = wantCards
    ? api("/api/pentagon-tasks").catch(function () { return { cards: [], errors: ["Couldn't load Pentagon rows."] }; })
    : Promise.resolve({ cards: [], errors: [] });
  var fin = page === "departments" && activeDept === "Accounting & Finance" && canSeeFinance() ? loadFinance() : Promise.resolve();
  loadMineCount().catch(function () {});
  return Promise.all([api(url), pentagon, fin]).then(function (r) {
    // IT requests live on IT → Requests, not as tasks (older ones were
    // also added as IT tasks; those stay hidden).
    tasks = r[0].filter(function (t) { return t.source !== "form"; });
    cards = r[1].cards || [];
    pentagonErrors = r[1].errors || [];
    setSync("on", "Live");
    var snapshot = JSON.stringify([activeCompany, tasks, cards, pentagonErrors, finance]);
    var changed = snapshot !== lastSnapshot;
    lastSnapshot = snapshot;
    var first = !loadedOnce;
    loadedOnce = true;
    if (first || (changed && pageUsesLiveData())) requestRender();
    else renderNav();
  }).catch(function (err) {
    if (err.message === "Session expired") return;
    setSync("off", "Sync error");
    if (!loadedOnce) setTimeout(refresh, 2000);
  });
}

function loadFinance() {
  var co = activeCompany;
  return api("/api/finance?company=" + encodeURIComponent(co)).then(function (data) {
    finance = { company: co, data: data };
  }).catch(function (err) { finance = { company: co, error: err.message }; });
}

// Responsible / Assigned to lists (managers only — everyone else can't assign).
function usersFor(company) {
  if (!isManager()) return [];
  if (usersByCompany[company]) return usersByCompany[company];
  usersByCompany[company] = [];
  api("/api/users?company=" + encodeURIComponent(company)).then(function (users) {
    usersByCompany[company] = users.map(function (u) { return u.username; }).sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
    requestRender();
  }).catch(function () {});
  return usersByCompany[company];
}

// Don't redraw under someone's cursor: wait until they leave the field.
function isEditing() {
  var a = document.activeElement;
  return !!(a && $("#view").contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "checkbox");
}
function requestRender() {
  if (isEditing()) { renderPending = true; return; }
  render();
}
document.addEventListener("focusout", function () {
  setTimeout(function () { if (renderPending && !isEditing()) { renderPending = false; render(); } }, 60);
});

// ---------- Routing ----------
function navItems() {
  var items = [];
  if (deptsIn("main").length) items.push({ id: "departments", ic: "▣", label: "Departments" });
  if (deptsIn("admin").length) items.push({ id: "administration", ic: "▤", label: "Administration" });
  if (items.length) items[0].group = "WORK";
  items.push({ group: "YOU", id: "mentions", ic: "@", label: "Mentions you", badge: mineOpen });
  items.push({ id: "inbox", ic: "✉", label: "Work inbox", badge: inboxNeeds });
  var tools = [];
  tools.push({ id: "calendar", ic: "▦", label: "Calendar" });
  if (me.fullAccess || me.departments.length > 1) tools.push({ id: "overview", ic: "◷", label: "Overview" });
  if (me.performance) tools.push({ id: "performance", ic: "◐", label: "Performance", badge: perfFlagged });
  if (canUseAll()) tools.push({ id: "global", ic: "◎", label: "Global" });
  tools.push({ id: "chat", ic: "✳", label: "Master Chat" });
  if (tools.length) { tools[0].group = "TOOLS"; items = items.concat(tools); }
  return items;
}
function readHash() {
  var h = decodeURIComponent((location.hash || "").replace(/^#/, ""));
  var parts = h.split("/");
  if (parts[0] === "dept" && parts[1] && visibleDepartments().indexOf(parts[1]) !== -1) { page = "departments"; activeDept = parts[1]; }
  else if (parts[0] === "administration" && groupHome("admin")) { page = "departments"; activeDept = groupHome("admin"); }
  else if (parts[0] !== "departments" && parts[0] !== "dept" && navItems().some(function (n) { return n.id === parts[0]; })) page = parts[0];
  else page = "departments";
}
window.addEventListener("hashchange", function () { if (!me) return; readHash(); render(); if (page === "departments") refresh(); });
function go(hash) { if (location.hash === "#" + hash) { readHash(); render(); } else location.hash = hash; }

// ---------- Render ----------
function renderNav() {
  $("#nav").innerHTML = navItems().map(function (n) {
    var grp = n.id === "departments" ? "main" : n.id === "administration" ? "admin" : "";
    var href = grp ? "dept/" + encodeURIComponent(page === "departments" && deptGroup(activeDept) === grp ? activeDept : groupHome(grp)) : n.id;
    var on = grp ? page === "departments" && deptGroup(activeDept) === grp : n.id === page;
    return (n.group ? '<div class="nav-group">' + n.group + "</div>" : "") +
      '<a href="#' + href + '" class="' + (on ? "active" : "") + '"><span class="ic">' + n.ic + "</span>" + E(n.label) +
      (n.badge ? '<span class="badge">' + n.badge + "</span>" : "") + "</a>";
  }).join("");
}

function render() {
  if (!me) return;
  charts.concat(mnCharts).forEach(function (c) { try { c.destroy(); } catch (e) {} });
  charts = [];
  mnCharts = [];
  renderNav();
  $("#quickAdd").style.display = "none";
  var html;
  try {
    if (page === "overview") html = renderOverview();
    else if (page === "mentions") html = renderMentionsShell();
    else if (page === "calendar") html = renderCalendar();
    else if (page === "inbox") html = renderInbox();
    else if (page === "performance") html = renderPerformance();
    else if (page === "global") html = renderGlobalShell();
    else if (page === "chat") html = renderMasterChat();
    else html = renderDepartment();
  } catch (e) {
    console.error(e);
    html = '<div class="empty">Something went wrong drawing this page. Reload to try again.</div>';
  }
  $("#view").innerHTML = html;
  autosize();
  afterRender();
}

function setBreadcrumb(parts) { $("#breadcrumb").textContent = parts.filter(Boolean).join(" / ").toUpperCase(); }

function companySwitcher(count) {
  var cos = myCompanies();
  if (canUseAll()) cos.push(ALL);
  if (cos.length <= 1) return "";
  return '<div class="co-wrap"><div class="eyebrow">Company</div><div class="cos" role="radiogroup" aria-label="Company">' +
    cos.map(function (c) {
      var on = c === activeCompany;
      var n = on ? count : 0;
      return '<button type="button" role="radio" aria-checked="' + on + '" class="co ' + (on ? "active" : "") + '" data-co="' + E(c) + '">' +
        E(shortCo(c)) + (n ? '<span class="badge">' + n + "</span>" : "") + "</button>";
    }).join("") + "</div></div>";
}

// On IT, Tasks and Projects show your own: ones you're responsible for or
// added. Managers can switch to everyone's.
var itScope = "mine";
function isMine(t) { return sameUser(t.owner, me.username) || sameUser(t.createdBy, me.username); }
function deptTasks(dept) {
  return tasks.filter(function (t) {
    if (t.department !== dept) return false;
    if (dept === "IT" && (itScope === "mine" || !isManager())) {
      if (isMine(t)) return true;
      // Sub-tasks under your own project.
      if (t.parentId && tasks.some(function (p) { return p.id === t.parentId && isMine(p); })) return true;
      // A project shows when one of your sub-tasks is under it.
      return tasks.some(function (s) { return s.parentId === t.id && isMine(s); });
    }
    return true;
  });
}
// Everything on a department: tracker tasks and Pentagon cards.
function deptItems(dept) {
  return deptTasks(dept).concat(cards.filter(function (c) { return c.department === dept; }));
}
function openCount(dept) {
  return deptItems(dept).filter(function (t) { return !isDone(t); }).length;
}

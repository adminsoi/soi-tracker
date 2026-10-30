"use strict";
// After-render hooks, writes, page-wide event listeners and start-up. Loads last.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---------- After each render: charts and focus ----------
function afterRender() {
  if (page === "overview") drawOverviewCharts();
  if (focusAfter) {
    var el = document.querySelector('#view [data-id="' + focusAfter.id + '"][data-key="' + focusAfter.key + '"]');
    if (el) el.focus();
    focusAfter = null;
  }
}
function autosize() {
  document.querySelectorAll("#view .fb-notes").forEach(function (t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight + 2, 440) + "px"; });
}

// ---------- Writes ----------
function findItem(id) {
  return tasks.filter(function (t) { return t.id === id; })[0] ||
    cards.filter(function (t) { return t.id === id; })[0] ||
    drafts.filter(function (t) { return t.id === id; })[0] || null;
}
function replaceTask(t) {
  var i = tasks.findIndex(function (x) { return x.id === t.id; });
  if (i === -1) tasks.unshift(t); else tasks[i] = t;
}
function patchTask(t, change) {
  setSync("busy", "Saving…");
  return api("/api/tasks/" + encodeURIComponent(t.id), { method: "PATCH", body: JSON.stringify(change) })
    .then(function (updated) { setSync("on", "Live"); replaceTask(updated); requestRender(); })
    .catch(function (err) { setSync("on", "Live"); if (err.message !== "Session expired") toast(err.message, true); refresh(); });
}
function cardChange(t, change) {
  return saveMark(t.view, t.markKey, { label: t.docLabel, docNo: t.docNo, party: t.party, dueDate: t.dueDate, pentagonUser: t.pentagonUser }, change)
    .then(function () { refresh(); }).catch(function () { refresh(); });
}
function newDraft(dept, parentId, kind) {
  var co = activeCompany === ALL ? (addCompany || myCompanies()[0]) : activeCompany;
  if (parentId) { var parent = findItem(parentId); if (parent && parent.company) co = parent.company; }
  var d = {
    id: "draft-" + Date.now() + "-" + Math.random().toString(16).slice(2, 6), draft: true, company: co, department: dept,
    title: "", part: "", platform: "", customer: "", obsolete: "No", dueDate: "", notes: "", owner: deptDefaults[dept] || "", status: "todo"
  };
  if (parentId) d.parentId = parentId; else d.kind = kind === "project" ? "project" : "task";
  drafts.unshift(d);
  focusAfter = { id: d.id, key: "title" };
  render();
}
// A draft becomes a real row once it has a name or a part number.
function saveDraft(d) {
  if (d.saving || (!String(d.title).trim() && !String(d.part).trim())) return;
  d.saving = true;
  var body = { company: d.company, department: d.department, title: d.title, part: d.part, platform: d.platform, customer: d.customer, obsolete: d.obsolete, dueDate: d.dueDate, notes: d.notes };
  if (d.parentId) body.parentId = d.parentId; else body.kind = d.kind;
  if (isManager()) body.owner = d.owner;
  setSync("busy", "Saving…");
  api("/api/tasks", { method: "POST", body: JSON.stringify(body) }).then(function (t) {
    setSync("on", "Live");
    drafts = drafts.filter(function (x) { return x !== d; });
    replaceTask(t);
    toast("Saved.");
    requestRender();
  }).catch(function (err) {
    d.saving = false;
    setSync("on", "Live");
    toast(err.message, true);
  });
}
function addFor(target) {
  if (!target) return;
  if (target.indexOf("fin:") === 0) {
    var list = target.slice(4);
    financeOp({ op: "add", list: list, fields: financeDefaults(list) }, "Row added.");
    return;
  }
  var parts = target.split("|"); // "IT|task" or "IT|project"
  newDraft(parts[0], null, parts[1]);
}
$("#quickAdd").addEventListener("click", function () { addFor(this.dataset.add); });

document.addEventListener("click", function (e) {
  if (!me) return;
  var mineLink = e.target.closest("[data-mine-co]");
  if (mineLink && mineLink.dataset.mineCo !== activeCompany && me.companies.indexOf(mineLink.dataset.mineCo) !== -1) {
    activeCompany = mineLink.dataset.mineCo;
    try { localStorage.setItem(COMPANY_KEY, activeCompany); } catch (x) {}
    tasks = []; cards = []; drafts = []; finance = null;
  }
  var cd = e.target.closest("[data-cal-days]");
  if (cd && $("#view").contains(cd)) { calDays = +cd.dataset.calDays; render(); return; }
  var ct = e.target.closest("[data-cal-tab]");
  if (ct && $("#view").contains(ct)) { calTab = ct.dataset.calTab; render(); return; }
  var cm = e.target.closest("[data-cal-mode]");
  if (cm && $("#view").contains(cm)) { calMode = cm.dataset.calMode; render(); return; }
  var cmo = e.target.closest("[data-cal-month]");
  if (cmo && $("#view").contains(cmo)) { var dm = +cmo.dataset.calMonth; calMonth = dm ? shiftMonths(calMonth, dm) : today.slice(0, 7) + "-01"; render(); return; }
  var ww = e.target.closest("[data-who-week]");
  if (ww && $("#view").contains(ww)) { var dw = +ww.dataset.whoWeek; whoWeek = dw ? shiftDays(whoWeek, dw) : today; render(); return; }
  var sc = e.target.closest("[data-it-scope]");
  if (sc && $("#view").contains(sc)) { itScope = sc.dataset.itScope; showPerson = ""; render(); return; }
  var t = e.target.closest("[data-co],[data-dept],[data-ops-dept],[data-sub],[data-source],[data-add],[data-add-sub],[data-del],[data-cancel],[data-toggle],[data-fin-del]");
  if (!t || !$("#view").contains(t)) return;
  var d = t.dataset;
  if (d.co) {
    if (d.co === activeCompany) return;
    activeCompany = d.co;
    try { localStorage.setItem(COMPANY_KEY, activeCompany); } catch (x) {}
    tasks = []; cards = []; drafts = []; finance = null; showPerson = ""; breakdown.at = 0;
    render(); refresh();
  } else if (d.dept) {
    showPerson = ""; showSource = "all";
    go("dept/" + encodeURIComponent(d.dept));
  } else if (d.opsDept) {
    // Same view in the other department, when it has it.
    subView[d.opsDept] = subView[activeDept] || subView[d.opsDept];
    showPerson = ""; showSource = "all";
    go("dept/" + encodeURIComponent(d.opsDept));
  } else if (d.sub) {
    subView[activeDept] = d.sub;
    render();
    if (d.sub === "finance") refresh();
  } else if (d.source) {
    showSource = d.source; render();
  } else if (d.add) {
    addFor(d.add);
  } else if (d.addSub) {
    newDraft(activeDept, d.addSub);
  } else if (d.cancel) {
    drafts = drafts.filter(function (x) { return x.id !== d.cancel; }); render();
  } else if (d.del) {
    var item = findItem(d.del);
    if (!item) return;
    var subs = tasks.filter(function (x) { return x.parentId === item.id; }).length;
    if (!confirm("Delete " + (item.title || item.part || "this row") + "?" + (subs ? " Its " + subs + " sub-task" + (subs === 1 ? "" : "s") + " will go too." : ""))) return;
    api("/api/tasks/" + encodeURIComponent(item.id), { method: "DELETE" }).then(function () {
      tasks = tasks.filter(function (x) { return x.id !== item.id && x.parentId !== item.id; });
      toast("Deleted."); render();
    }).catch(function (err) { toast(err.message, true); refresh(); });
  } else if (d.toggle) {
    var it = findItem(d.toggle);
    if (!it || !isManager()) return;
    var next = isDone(it) ? "todo" : "done";
    if (isCard(it)) cardChange(it, { status: next });
    else patchTask(it, { status: next });
  } else if (d.finDel) {
    if (!confirm("Delete this row?")) return;
    financeOp({ op: "delete", list: d.finDel, id: d.fid }, "Row removed.");
  }
});

document.addEventListener("change", function (e) {
  if (!me) return;
  var el = e.target;
  if (!$("#view").contains(el)) return;
  if (el.id === "personFilter") { showPerson = el.value; render(); return; }
  if (el.id === "addCompany") { addCompany = el.value; return; }
  if (el.dataset.approve) { financeOp({ op: "approve", list: "dailyPayments", id: el.dataset.approve }, "Approved to pay. Nothing has been sent."); return; }
  if (el.dataset.unapprove) { financeOp({ op: "unapprove", list: "approvedToPay", id: el.dataset.unapprove }, "Approval removed."); return; }
  if (el.dataset.finTick) { var tf = {}; tf[el.dataset.key] = el.checked; financeOp({ op: "update", list: el.dataset.finTick, id: el.dataset.fid, fields: tf }); return; }
  if (el.dataset.fin) {
    var ff = {}; ff[el.dataset.key] = el.type === "number" ? (el.value === "" ? 0 : Number(el.value)) : el.value;
    financeOp({ op: "update", list: el.dataset.fin, id: el.dataset.fid, fields: ff });
    return;
  }
  if (!el.dataset.id || !el.dataset.key) return;
  var item = findItem(el.dataset.id);
  if (!item) return;
  var key = el.dataset.key, value = el.value;
  if (item.draft) { item[key] = value; saveDraft(item); return; }
  if (isCard(item)) {
    if (key === "owner") cardChange(item, { assignee: value });
    else if (key === "notes") cardChange(item, { notes: value });
    return;
  }
  var change = {}; change[key] = value;
  item[key] = value;
  patchTask(item, change);
});

document.addEventListener("input", function (e) {
  if (e.target.classList && e.target.classList.contains("fb-notes")) {
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight + 2, 440) + "px";
  }
});

var fitTimer = null;
window.addEventListener("resize", function () { clearTimeout(fitTimer); fitTimer = setTimeout(autosize, 150); });

// ---------- Init ----------
function init() {
  if (!token()) { showLogin(); return; }
  api("/api/me").then(function (data) { me = data; onSignedIn(); }).catch(function () { clearToken(); showLogin(); });
}
init();

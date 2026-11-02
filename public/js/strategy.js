"use strict";
// Company → Strategy Meeting: the weekly meeting's agenda.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- Strategy Meeting ----
// Leadership only (the server checks every request). One meeting a week,
// each an agenda of items: topic, owner, minutes, notes, decisions and
// action items. A new meeting is dated a week after the last and carries
// over the items not marked discussed. Each action item shows on its
// person's Mentions of You until it's ticked done.
var st = { data: null, at: 0, loading: false, error: "", sel: "", draft: null, dirty: false, adding: false, newDate: "", carry: true };
function loadStrategy() {
  if (st.loading) return;
  st.loading = true;
  api("/api/strategy").then(function (d) { st.data = d; st.error = ""; stPick(st.sel); }, function (err) { st.error = err.message; })
    .then(function () { st.loading = false; st.at = Date.now(); requestRender(); });
}
// Show a meeting (the newest when none is picked); unsaved changes are kept
// only for the meeting being edited.
function stPick(id) {
  var list = st.data.meetings;
  var m = list.filter(function (x) { return x.id === id; })[0] || list[0] || null;
  if (st.dirty && st.draft && m && m.id === st.draft.id) return;
  st.sel = m ? m.id : "";
  st.draft = m ? JSON.parse(JSON.stringify(m)) : null;
  st.dirty = false;
}
function stLoginOpts(sel, none) {
  var l = st.data.logins;
  return '<option value="">' + E(none) + "</option>" + (sel && l.indexOf(sel) === -1 ? [sel] : []).concat(l).map(function (u) {
    return '<option value="' + E(u) + '"' + (sameUser(u, sel) ? " selected" : "") + ">" + E(u) + "</option>";
  }).join("");
}
function stDateLabel(d) {
  var t = new Date(d + "T12:00:00");
  return isNaN(t) ? d : t.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function renderStrategy() {
  setBreadcrumb(["Company", "Strategy Meeting"]);
  var head = '<div class="intro"><div><div class="eyebrow">Company</div><h1>Strategy Meeting</h1>' +
    "<p>The weekly meeting's agenda: each item's owner, time, notes, decisions and action items. Action items show on the person's Mentions of You until they're done.</p></div></div>";
  if (!me.leadership) return head + '<div class="empty">The Strategy Meeting is for Leadership logins.</div>';
  if (!st.loading && (st.error ? Date.now() - st.at > 15000 : !st.data || (!st.dirty && Date.now() - st.at > 60000))) loadStrategy();
  if (st.error && !st.data) return head + '<div class="banner">' + E(st.error) + "</div>";
  if (!st.data) return head + '<div class="empty">Loading meetings…</div>';
  var d = st.data, m = st.draft;
  var bar = '<div class="table-toolbar">' +
    (d.meetings.length ? '<label class="small-note" for="stPick">Meeting</label><select id="stPick">' + d.meetings.map(function (x) {
      return '<option value="' + E(x.id) + '"' + (x.id === st.sel ? " selected" : "") + ">" + E(stDateLabel(x.date) + (x.title ? " · " + x.title : "")) + "</option>";
    }).join("") + "</select>" : "") +
    '<span class="grow" style="flex:1"></span><button type="button" class="primary" data-st-new>+ New meeting</button></div>';
  var add = st.adding ? '<div class="card" style="padding:16px 18px;margin-bottom:14px;"><div class="card-label">New meeting</div>' +
    '<div class="grid-2" style="gap:0 16px;"><div class="nb-field"><label for="stNewDate">Date</label><input type="date" id="stNewDate" value="' + E(st.newDate || d.nextDate) + '"></div>' +
    '<div class="nb-field"><label><input type="checkbox" id="stCarry"' + (st.carry ? " checked" : "") + "> Carry over items not marked discussed at the last meeting</label></div></div>" +
    '<div class="nb-foot"><button type="button" class="primary" data-st-create>Create</button><button type="button" class="text-button" data-st-cancel>Cancel</button></div></div>' : "";
  if (!m) return head + bar + add + '<div class="empty">No meetings yet. Start one with + New meeting.</div>';
  var total = m.items.reduce(function (s, it) { return s + (+it.minutes || 0); }, 0);
  var open = 0;
  m.items.forEach(function (it) { it.actions.forEach(function (a) { if (!a.done) open++; }); });
  return head + bar + add +
    '<div class="card" style="padding:16px 18px;margin-bottom:14px;"><div class="grid-2" style="gap:0 16px;">' +
    '<div class="nb-field"><label for="stDate">Date</label><input type="date" id="stDate" data-st-m="date" value="' + E(m.date) + '"></div>' +
    '<div class="nb-field"><label for="stTitle">Title (optional)</label><input id="stTitle" data-st-m="title" value="' + E(m.title || "") + '" placeholder="e.g. Q1 planning" autocomplete="off"></div></div>' +
    '<p class="small-note" style="margin:0;">' + m.items.length + " item" + (m.items.length === 1 ? "" : "s") + " · " + total + " minutes · " + open + " open action item" + (open === 1 ? "" : "s") +
    (m.updatedBy ? " · Last saved by " + E(m.updatedBy) + " " + E(new Date(m.updatedAt).toLocaleString()) : " · Started by " + E(m.createdBy || "")) + "</p></div>" +
    (m.items.length ? m.items.map(stItem).join("") : '<div class="empty">No agenda items yet.</div>') +
    '<div class="nb-foot" style="margin-top:12px;"><button type="button" data-st-additem>+ Agenda item</button><span class="grow" style="flex:1"></span>' +
    '<span class="small-note" id="stDirty">' + (st.dirty ? "Unsaved changes" : "") + "</span>" +
    '<button type="button" class="primary" data-st-save>Save agenda</button><button type="button" class="text-button" data-st-revert>Undo changes</button>' +
    '<button type="button" class="text-button danger" data-st-del>Delete meeting</button></div>' +
    '<p class="small-note">Write notes and decisions in plain words. Don\'t put government client details, contract terms or supplier prices here.</p>';
}
function stItem(it, i) {
  var p = "items." + i + ".";
  return '<div class="card st-item" style="padding:14px 16px;margin-bottom:10px;">' +
    '<div class="st-row"><span class="st-num">' + (i + 1) + "</span>" +
    '<input class="st-topic" data-st-f="' + p + 'topic" value="' + E(it.topic) + '" placeholder="Topic" aria-label="Topic of item ' + (i + 1) + '" autocomplete="off">' +
    '<select data-st-f="' + p + 'owner" aria-label="Owner of item ' + (i + 1) + '">' + stLoginOpts(it.owner, "Owner…") + "</select>" +
    '<input type="number" min="0" max="600" class="st-min" data-st-f="' + p + 'minutes" value="' + E(it.minutes || "") + '" placeholder="min" aria-label="Minutes for item ' + (i + 1) + '">' +
    '<label class="small-note"><input type="checkbox" data-st-f="' + p + 'discussed"' + (it.discussed ? " checked" : "") + "> Discussed</label>" +
    '<button type="button" class="text-button" data-st-up="' + i + '" aria-label="Move item ' + (i + 1) + ' up"' + (i ? "" : " disabled") + ">↑</button>" +
    '<button type="button" class="text-button danger" data-st-rmitem="' + i + '">Remove</button></div>' +
    (it.carriedFrom ? '<p class="small-note" style="margin:4px 0 0 30px;">Carried over from ' + E(stDateLabel(it.carriedFrom)) + "</p>" : "") +
    '<div class="grid-2" style="gap:0 16px;margin-top:8px;"><div class="nb-field"><label>Notes</label><textarea rows="3" data-st-f="' + p + 'notes">' + E(it.notes || "") + "</textarea></div>" +
    '<div class="nb-field"><label>Decisions</label><textarea rows="3" data-st-f="' + p + 'decisions">' + E(it.decisions || "") + "</textarea></div></div>" +
    '<div class="card-label" style="margin-top:4px;">Action items</div>' +
    (it.actions.length ? '<table class="plain st-actions"><thead><tr><th>Done</th><th>Action</th><th>Who</th><th>Due</th><th></th></tr></thead><tbody>' + it.actions.map(function (a, j) {
      var q = p + "actions." + j + ".";
      return '<tr class="' + (a.done ? "st-done" : "") + '"><td>' + (a.id ? '<input type="checkbox" data-st-done="' + E(a.id) + '"' + (a.done ? " checked" : "") + ' aria-label="Done">' : '<span class="small-note" title="Save the agenda first">—</span>') + "</td>" +
        '<td><input data-st-f="' + q + 'text" value="' + E(a.text) + '" placeholder="What needs doing" autocomplete="off"></td>' +
        '<td><select data-st-f="' + q + 'person">' + stLoginOpts(a.person, "Who…") + "</select></td>" +
        '<td><input type="date" data-st-f="' + q + 'due" value="' + E(a.due || "") + '"></td>' +
        '<td><button type="button" class="text-button danger" data-st-rmact="' + i + "." + j + '">Remove</button>' + (a.done && a.doneBy ? '<span class="small-note"> ✓ ' + E(a.doneBy) + "</span>" : "") + "</td></tr>";
    }).join("") + "</tbody></table>" : "") +
    '<button type="button" class="text-button" data-st-addact="' + i + '">+ Action item</button></div>';
}
function stSet(path, v) {
  var keys = path.split("."), o = st.draft;
  for (var i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  var k = keys[keys.length - 1];
  o[k] = k === "discussed" ? !!v : k === "minutes" ? (+v || 0) : v;
  st.dirty = true;
  var el = $("#stDirty"); if (el) el.textContent = "Unsaved changes";
}
function stSave() {
  var m = st.draft;
  api("/api/strategy/meetings/" + encodeURIComponent(m.id), { method: "PUT", body: JSON.stringify(m) }).then(function (saved) {
    st.data.meetings = st.data.meetings.map(function (x) { return x.id === saved.id ? saved : x; });
    st.draft = JSON.parse(JSON.stringify(saved)); st.dirty = false;
    toast("Agenda saved."); loadMineCount(); render();
  }, function (err) {
    toast(err.message, true);
    if (/reloaded/.test(err.message)) { st.dirty = false; st.at = 0; render(); }
  });
}
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-st-new],[data-st-create],[data-st-cancel],[data-st-additem],[data-st-rmitem],[data-st-up],[data-st-addact],[data-st-rmact],[data-st-save],[data-st-revert],[data-st-del]");
  if (!t || !$("#view").contains(t)) return;
  var ds = t.dataset, m = st.draft;
  if ("stNew" in ds) { st.adding = true; st.newDate = ""; render(); return; }
  if ("stCancel" in ds) { st.adding = false; render(); return; }
  if ("stCreate" in ds) {
    if (st.dirty && !confirm("The meeting on screen has unsaved changes. Create the new one anyway (the changes are lost)?")) return;
    var date = ($("#stNewDate") || {}).value;
    api("/api/strategy/meetings", { method: "POST", body: JSON.stringify({ date: date, carry: st.carry }) }).then(function (nm) {
      st.adding = false; st.dirty = false; st.sel = nm.id; st.at = 0;
      toast("Meeting created" + (nm.items.length ? " with " + nm.items.length + " item" + (nm.items.length === 1 ? "" : "s") + " carried over." : "."));
      render();
    }, function (err) { toast(err.message, true); });
    return;
  }
  if ("stAdditem" in ds) { m.items.push({ topic: "", owner: "", minutes: 0, notes: "", decisions: "", discussed: false, actions: [] }); st.dirty = true; render(); var ins = document.querySelectorAll(".st-topic"); if (ins.length) ins[ins.length - 1].focus(); return; }
  if (ds.stRmitem) { if (!confirm("Remove this agenda item and its action items?")) return; m.items.splice(+ds.stRmitem, 1); st.dirty = true; render(); return; }
  if (ds.stUp) { var u = +ds.stUp; m.items.splice(u - 1, 0, m.items.splice(u, 1)[0]); st.dirty = true; render(); return; }
  if (ds.stAddact) { m.items[+ds.stAddact].actions.push({ text: "", person: "", due: "", done: false }); st.dirty = true; render(); return; }
  if (ds.stRmact) { var ij = ds.stRmact.split("."); m.items[+ij[0]].actions.splice(+ij[1], 1); st.dirty = true; render(); return; }
  if ("stSave" in ds) { stSave(); return; }
  if ("stRevert" in ds) { st.dirty = false; stPick(st.sel); render(); return; }
  if ("stDel" in ds) {
    if (!confirm("Delete the meeting on " + stDateLabel(m.date) + "? Its action items leave everyone's Mentions of You too.")) return;
    api("/api/strategy/meetings/" + encodeURIComponent(m.id), { method: "DELETE" }).then(function () {
      st.dirty = false; st.sel = ""; st.at = 0; toast("Meeting deleted."); loadMineCount(); render();
    }, function (err) { toast(err.message, true); });
  }
});
document.addEventListener("input", function (e) {
  var t = e.target;
  if (t.dataset && (t.dataset.stF || t.dataset.stM) && t.type !== "checkbox") stSet(t.dataset.stF || t.dataset.stM, t.value);
});
document.addEventListener("change", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (t.id === "stPick") {
    if (st.dirty && !confirm("Leave this meeting without saving your changes?")) { t.value = st.sel; return; }
    st.dirty = false; stPick(t.value); render(); return;
  }
  if (t.id === "stCarry") { st.carry = t.checked; return; }
  if (t.id === "stNewDate") { st.newDate = t.value; return; }
  if (ds.stF || ds.stM) { stSet(ds.stF || ds.stM, t.type === "checkbox" ? t.checked : t.value); return; }
  if (ds.stDone) { stTick(ds.stDone, t.checked); }
});

// ---- Ticking an action item done (here and on Mentions of You) ----
function stTick(id, done) {
  api("/api/strategy/actions/" + encodeURIComponent(id) + "/done", { method: "POST", body: JSON.stringify({ done: done }) }).then(function () {
    if (st.data) {
      [st.data.meetings, st.draft ? [st.draft] : []].forEach(function (list) {
        list.forEach(function (m) { m.items.forEach(function (it) { it.actions.forEach(function (a) { if (a.id === id) { a.done = done; a.doneBy = done ? me.username : ""; } }); }); });
      });
    }
    stMine.items = (stMine.items || []).filter(function (x) { return x.id !== id || !done; });
    toast(done ? "Marked done." : "Marked not done."); loadMineCount(); requestRender();
  }, function (err) { toast(err.message, true); });
}
var stMine = { items: null, at: 0 };
function loadStrategyMine() {
  // `at` is set even on failure, so a failing request isn't retried on every redraw.
  stMine.at = Date.now();
  return api("/api/strategy/mine").then(function (d) { stMine.items = d.items; stMine.at = Date.now(); return d.items; }, function () { stMine.items = stMine.items || []; return stMine.items; });
}
// The block on Mentions of You (mentions.js); empty when there's nothing open.
function strategyActions() {
  if (!stMine.items || Date.now() - stMine.at > 60000) loadStrategyMine().then(function () { if (page === "mentions") requestRender(); });
  var items = stMine.items || [], today = new Date().toISOString().slice(0, 10);
  if (!items.length) return "";
  return '<div class="card" style="padding:16px 18px;margin-bottom:16px;"><div class="card-label">Strategy Meeting action items for you</div><ul class="lg-due-list">' +
    items.map(function (x) {
      var late = x.due && x.due < today;
      return '<li class="' + (late ? "lg-row-expired" : "") + '"><label><input type="checkbox" data-st-done="' + E(x.id) + '"> ' + E(x.text) + "</label> " +
        '<span class="small-note">' + E(x.topic) + " · meeting " + E(stDateLabel(x.meetingDate)) + "</span> " +
        (x.due ? '<span class="lg-pill ' + (late ? "lg-expired" : "lg-soon") + '">' + (late ? "Overdue · " : "Due ") + E(x.due) + "</span>" : "") + "</li>";
    }).join("") + "</ul></div>";
}

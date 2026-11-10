"use strict";
// Company → Strategy Meeting: one table of topics for the weekly meeting.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- Strategy Meeting ----
// Leadership only (the server checks every request). Each row is a topic
// with an owner, a date to discuss it and a status, plus a running log of
// notes and decisions like a board file's notes. A note can be for someone
// with a due date: it becomes a task for them (Mentions of You). Writing
// #strategymeeting or @strategymeeting in any note in the tracker adds a
// row here, dated for the next meeting.
var sm = { data: null, at: 0, loading: false, error: "", date: "next", status: "active", q: "", open: {}, adding: false, form: {}, entry: {} };
function loadStrategy() {
  if (sm.loading) return;
  sm.loading = true;
  api("/api/strategy").then(function (d) { sm.data = d; sm.error = ""; }, function (err) { sm.error = err.message; })
    .then(function () { sm.loading = false; sm.at = Date.now(); requestRender(); });
}
function smReload() { sm.at = 0; loadStrategy(); }
function smDateLabel(d) {
  if (!d) return "No date yet";
  var t = new Date(d + "T12:00:00");
  return isNaN(t) ? d : t.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
// Owner and "for" pick from the Strategy Meeting's people (Greg, Nyssa,
// Ramin, Alexis, Melissa); someone already picked stays in the list.
function smLoginOpts(sel, none) {
  var l = (sm.data.people && sm.data.people.length) ? sm.data.people : sm.data.logins;
  return '<option value="">' + E(none) + "</option>" + (sel && l.indexOf(sel) === -1 ? [sel] : []).concat(l).map(function (u) {
    return '<option value="' + E(u) + '"' + (sameUser(u, sel) ? " selected" : "") + ">" + E(u) + "</option>";
  }).join("");
}
// A topic's meeting: one of the meeting dates (every Monday until the end of
// the year, for now), or none yet.
function smDateOpts(sel) {
  var l = sm.data.dates || [];
  return '<option value="">No date yet</option>' + (sel && l.indexOf(sel) === -1 ? [sel] : []).concat(l).map(function (x) {
    return '<option value="' + E(x) + '"' + (x === sel ? " selected" : "") + ">" + E(smDateLabel(x)) + (x === sm.data.nextDate ? " · next" : "") + "</option>";
  }).join("");
}
var SM_STATUS = [["open", "Open"], ["decided", "Decided"], ["closed", "Closed"]];
var SM_SHOW = [["active", "Open + decided"], ["open", "Open"], ["decided", "Decided"], ["closed", "Closed"], ["all", "All"]];

function renderStrategy() {
  setBreadcrumb(["Company", "Strategy Meeting"]);
  var head = '<div class="intro"><div><div class="eyebrow">Company</div><h1>Strategy Meeting</h1>' +
    "<p>Every topic for the weekly meeting in one table, with a date to discuss it and a running log of notes and decisions. " +
    "Write <b>#strategymeeting</b> or <b>@strategymeeting</b> in a note anywhere in the tracker to add it here for the next meeting.</p></div></div>";
  if (!me.leadership) return head + '<div class="empty">The Strategy Meeting is for Leadership logins.</div>';
  if (!sm.loading && (sm.error ? Date.now() - sm.at > 15000 : !sm.data || Date.now() - sm.at > 60000)) loadStrategy();
  if (sm.error && !sm.data) return head + '<div class="banner">' + E(sm.error) + "</div>";
  if (!sm.data) return head + '<div class="empty">Loading the Strategy Meeting…</div>';
  var d = sm.data;
  // Every meeting (each Monday to the end of the year, plus any date a topic
  // uses), with how many topics are on it.
  var dates = (d.dates || []).slice(), per = {};
  d.topics.forEach(function (t) { if (t.discussOn) { per[t.discussOn] = (per[t.discussOn] || 0) + 1; if (dates.indexOf(t.discussOn) === -1) dates.push(t.discussOn); } });
  dates.sort();
  if (sm.date !== "next" && sm.date !== "all" && sm.date !== "none" && dates.indexOf(sm.date) === -1) sm.date = "next";
  var want = sm.date === "next" ? d.nextDate : sm.date;
  var q = sm.q.trim().toLowerCase();
  var rows = d.topics.filter(function (t) {
    if (sm.date === "none" ? t.discussOn : sm.date !== "all" && t.discussOn !== want) return false;
    if (sm.status === "active" ? t.status === "closed" : sm.status !== "all" && t.status !== sm.status) return false;
    return !q || [t.topic, t.owner, t.source || ""].concat(t.log.map(function (e) { return e.text; })).join(" ").toLowerCase().indexOf(q) !== -1;
  }).sort(function (a, b) { return (a.discussOn || "9999").localeCompare(b.discussOn || "9999") || a.at - b.at; });
  var undated = d.topics.filter(function (t) { return !t.discussOn && t.status !== "closed"; }).length;
  var bar = '<div class="table-toolbar">' +
    '<label class="small-note" for="smDate">Date to discuss</label><select id="smDate">' +
    '<option value="next"' + (sm.date === "next" ? " selected" : "") + ">Next meeting · " + E(smDateLabel(d.nextDate)) + "</option>" +
    '<option value="all"' + (sm.date === "all" ? " selected" : "") + ">All dates</option>" +
    '<option value="none"' + (sm.date === "none" ? " selected" : "") + ">No date yet (" + undated + ")</option>" +
    dates.map(function (x) { return '<option value="' + E(x) + '"' + (sm.date === x ? " selected" : "") + ">" + E(smDateLabel(x)) + (per[x] ? " (" + per[x] + ")" : "") + "</option>"; }).join("") + "</select>" +
    '<div class="seg" aria-label="Status">' + SM_SHOW.map(function (x) {
      return '<button type="button" data-sm-show="' + x[0] + '" class="' + (sm.status === x[0] ? "active" : "") + '">' + E(x[1]) + "</button>";
    }).join("") + "</div>" +
    '<input type="search" id="smFind" placeholder="Search topics and notes" value="' + E(sm.q) + '" aria-label="Search topics and notes">' +
    '<span class="grow" style="flex:1"></span><button type="button" class="primary" data-sm-add>+ Add row</button></div>';
  var add = sm.adding ? '<div class="card" style="padding:16px 18px;margin-bottom:14px;"><div class="card-label">New row</div>' +
    '<div class="nb-field"><label for="smNewTopic">Topic</label><input id="smNewTopic" data-sm-new="topic" value="' + E(sm.form.topic || "") + '" autocomplete="off"></div>' +
    '<div class="grid-2" style="gap:0 16px;"><div class="nb-field"><label for="smNewOwner">Owner</label><select id="smNewOwner" data-sm-new="owner">' + smLoginOpts(sm.form.owner, "Nobody yet") + "</select></div>" +
    '<div class="nb-field"><label for="smNewDate">Meeting</label><select id="smNewDate" data-sm-new="discussOn">' + smDateOpts("discussOn" in sm.form ? sm.form.discussOn : d.nextDate) + "</select></div></div>" +
    '<div class="nb-field"><label for="smNewNote">First note (optional)</label><textarea id="smNewNote" rows="3" data-sm-new="note">' + E(sm.form.note || "") + "</textarea></div>" +
    '<div class="nb-foot"><button type="button" class="primary" data-sm-create>Add row</button><button type="button" class="text-button" data-sm-cancel>Cancel</button></div></div>' : "";
  var table = rows.length ? '<div class="table-wrap"><table class="wide sm-table"><thead><tr><th>Topic</th><th>Owner</th><th>Date to discuss</th><th>Status</th><th>Latest</th><th></th></tr></thead><tbody>' +
    rows.map(smRow).join("") + "</tbody></table></div>"
    : '<div class="card empty">' + (d.topics.length ? "Nothing matches. Try All dates or another status." : "No topics yet. Add a row, or write #strategymeeting in a note anywhere in the tracker.") + "</div>";
  return head + bar + add + table +
    '<p class="small-note">Decisions mark a row Decided. A note for someone becomes a task for them (their Mentions of You, and their department\'s Tasks). Don\'t type government client details, contract terms or supplier prices here.</p>';
}
function smRow(t) {
  var last = t.log[t.log.length - 1], open = !!sm.open[t.id];
  var html = '<tr class="' + (t.status === "closed" ? "sm-closed" : "") + '">' +
    '<td><input class="sm-topic" data-sm-edit="topic" data-id="' + E(t.id) + '" value="' + E(t.topic) + '" aria-label="Topic">' +
    (t.source ? '<span class="co-note">From ' + E(t.source) + " · " + E(t.raisedBy || "") + "</span>" : "") + "</td>" +
    '<td><select data-sm-edit="owner" data-id="' + E(t.id) + '" aria-label="Owner of ' + E(t.topic) + '">' + smLoginOpts(t.owner, "Nobody") + "</select></td>" +
    '<td><select data-sm-edit="discussOn" data-id="' + E(t.id) + '" aria-label="Meeting for ' + E(t.topic) + '">' + smDateOpts(t.discussOn || "") + "</select></td>" +
    '<td><select data-sm-edit="status" data-id="' + E(t.id) + '" aria-label="Status of ' + E(t.topic) + '">' + SM_STATUS.map(function (s) {
      return '<option value="' + s[0] + '"' + (t.status === s[0] ? " selected" : "") + ">" + s[1] + "</option>";
    }).join("") + "</select></td>" +
    '<td class="sm-latest">' + (last ? (last.kind === "decision" ? '<span class="lg-pill sop-ok">Decision</span> ' : "") + E(last.text.split("\n")[0].slice(0, 120)) +
      '<span class="co-note">' + E(last.by) + " · " + E(new Date(last.at).toLocaleDateString()) + "</span>" : '<span class="small-note">No notes yet</span>') + "</td>" +
    '<td style="white-space:nowrap;"><button type="button" data-sm-open="' + E(t.id) + '" aria-expanded="' + open + '">' + (open ? "Close" : "Notes (" + t.log.length + ")") + "</button></td></tr>";
  if (open) html += '<tr class="sm-log-row"><td colspan="6">' + smLog(t) + "</td></tr>";
  return html;
}
// The running log and the form to add to it.
function smLog(t) {
  var f = sm.entry[t.id] || (sm.entry[t.id] = { kind: "note" });
  var log = t.log.length ? '<ul class="sm-log">' + t.log.map(function (e) {
    return '<li class="' + (e.kind === "decision" ? "sm-decision" : "") + '">' +
      '<div class="sm-log-head">' + (e.kind === "decision" ? '<span class="lg-pill sop-ok">Decision</span>' : "") +
      "<b>" + E(e.by) + '</b><span class="small-note">' + E(new Date(e.at).toLocaleString()) + (e.source ? " · from " + E(e.source) : "") + "</span>" +
      (e.for ? '<span class="lg-pill ' + (e.taskDone ? "sop-ok" : "lg-soon") + '">For ' + E(e.for) + (e.due ? " · due " + E(e.due) : "") + (e.taskDone ? " · done" : e.taskGone ? " · task removed" : "") + "</span>" : "") +
      '</div><div class="nb-read">' + nbFormat(e.text) + "</div></li>";
  }).join("") + "</ul>" : '<p class="small-note">No notes yet.</p>';
  return log + '<div class="sm-add">' +
    '<div class="seg"><button type="button" data-sm-kind="note|' + E(t.id) + '" class="' + (f.kind === "note" ? "active" : "") + '">Note</button>' +
    '<button type="button" data-sm-kind="decision|' + E(t.id) + '" class="' + (f.kind === "decision" ? "active" : "") + '">Decision</button></div>' +
    '<textarea rows="3" data-sm-entry="text" data-id="' + E(t.id) + '" placeholder="' + (f.kind === "decision" ? "What was decided" : "Add a note") + '" aria-label="New note">' + E(f.text || "") + "</textarea>" +
    '<div class="sm-add-row"><label class="small-note">For <select data-sm-entry="for" data-id="' + E(t.id) + '">' + smLoginOpts(f.for, "Nobody (just a note)") + "</select></label>" +
    '<label class="small-note">Due <input type="date" data-sm-entry="due" data-id="' + E(t.id) + '" value="' + E(f.due || "") + '"></label>' +
    '<span class="grow" style="flex:1"></span><button type="button" class="primary" data-sm-log="' + E(t.id) + '">Add ' + (f.kind === "decision" ? "decision" : "note") + "</button>" +
    '<button type="button" class="text-button danger" data-sm-del="' + E(t.id) + '">Delete row</button></div></div>';
}
function smPut(row) {
  sm.data.topics = sm.data.topics.map(function (x) { return x.id === row.id ? row : x; });
}
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-sm-show],[data-sm-add],[data-sm-cancel],[data-sm-create],[data-sm-open],[data-sm-kind],[data-sm-log],[data-sm-del]");
  if (!t || !$("#view").contains(t)) return;
  var ds = t.dataset;
  if (ds.smShow) { sm.status = ds.smShow; render(); return; }
  if ("smAdd" in ds) { sm.adding = true; sm.form = {}; render(); var el = $("#smNewTopic"); if (el) el.focus(); return; }
  if ("smCancel" in ds) { sm.adding = false; render(); return; }
  if ("smCreate" in ds) {
    var f = Object.assign({ discussOn: sm.data.nextDate }, sm.form);
    if (!String(f.topic || "").trim()) { toast("Write the topic first.", true); return; }
    api("/api/strategy/topics", { method: "POST", body: JSON.stringify(f) }).then(function (row) {
      sm.data.topics.push(row); sm.adding = false; sm.form = {};
      if (sm.date !== "all" && row.discussOn !== (sm.date === "next" ? sm.data.nextDate : sm.date)) sm.date = "all";
      toast("Row added."); smReload(); render();
    }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.smOpen) { sm.open[ds.smOpen] = !sm.open[ds.smOpen]; render(); return; }
  if (ds.smKind) { var p = ds.smKind.split("|"); sm.entry[p[1]].kind = p[0]; render(); return; }
  if (ds.smLog) {
    var id = ds.smLog, en = sm.entry[id] || {};
    if (!String(en.text || "").trim()) { toast("Write the note first.", true); return; }
    if (en.due && !en.for) { toast("Pick who it's for, or clear the due date.", true); return; }
    api("/api/strategy/topics/" + encodeURIComponent(id) + "/log", { method: "POST", body: JSON.stringify({ text: en.text, kind: en.kind, for: en.for || "", due: en.due || "" }) }).then(function (row) {
      smPut(row); sm.entry[id] = { kind: "note" };
      toast(en.for ? "Added, and sent to " + en.for + " as a task." : en.kind === "decision" ? "Decision added." : "Note added."); render();
    }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.smDel) {
    var row = sm.data.topics.filter(function (x) { return x.id === ds.smDel; })[0];
    if (!row || !confirm("Delete “" + row.topic + "” and its notes? Tasks already sent to people stay with them.")) return;
    api("/api/strategy/topics/" + encodeURIComponent(row.id), { method: "DELETE" }).then(function () {
      sm.data.topics = sm.data.topics.filter(function (x) { return x.id !== row.id; }); toast("Row deleted."); render();
    }, function (err) { toast(err.message, true); });
  }
});
document.addEventListener("input", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (t.id === "smFind") { sm.q = t.value; var pos = t.selectionStart; render(); var el = $("#smFind"); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (x) {} } return; }
  if (ds.smNew) { sm.form[ds.smNew] = t.value; return; }
  if (ds.smEntry) { (sm.entry[ds.id] = sm.entry[ds.id] || { kind: "note" })[ds.smEntry] = t.value; }
});
document.addEventListener("change", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (t.id === "smDate") { sm.date = t.value; render(); return; }
  if (ds.smNew) { sm.form[ds.smNew] = t.value; return; }
  if (ds.smEntry) { (sm.entry[ds.id] = sm.entry[ds.id] || { kind: "note" })[ds.smEntry] = t.value; return; }
  if (ds.smEdit) {
    var ch = {}; ch[ds.smEdit] = t.value;
    api("/api/strategy/topics/" + encodeURIComponent(ds.id), { method: "PATCH", body: JSON.stringify(ch) }).then(function (row) {
      smPut(row); toast("Saved."); requestRender();
    }, function (err) { toast(err.message, true); smReload(); });
  }
});

// ---- Mentions of You: Strategy Meeting topics you own ----
// Open topics whose owner is you (notes assigned to you arrive as tasks).
var smMine = { items: null, at: 0, loading: false };
function loadStrategyMine() {
  if (smMine.loading || (smMine.items && Date.now() - smMine.at < 60000)) return Promise.resolve(smMine.items || []);
  smMine.loading = true;
  return api("/api/strategy/mine").then(function (x) {
    var changed = JSON.stringify(x.items) !== JSON.stringify(smMine.items);
    smMine.items = x.items || []; smMine.at = Date.now();
    if (changed && page === "mentions") requestRender();
    return smMine.items;
  }, function () { smMine.items = smMine.items || []; return smMine.items; }).then(function (v) { smMine.loading = false; return v; });
}
function strategyNotices() {
  loadStrategyMine();
  var list = smMine.items || [];
  if (!list.length) return "";
  return '<div class="card" style="padding:16px 18px;margin-bottom:16px;"><div class="card-label">Strategy Meeting — yours</div><ul class="lg-due-list">' +
    list.map(function (x) {
      return "<li>" + (me.leadership ? '<button type="button" class="text-button" data-sm-goto="' + E(x.id) + '|' + E(x.discussOn) + '">' + E(x.topic) + "</button>" : "<b>" + E(x.topic) + "</b>") +
        ' <span class="small-note">' + E(x.discussOn ? smDateLabel(x.discussOn) : "No meeting date yet") + " · " + E(x.status === "decided" ? "Decided" : "Open") + "</span></li>";
    }).join("") + "</ul></div>";
}
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-sm-goto]");
  if (!t) return;
  var p = t.dataset.smGoto.split("|");
  sm.date = p[1] || "all"; sm.status = "all"; sm.open[p[0]] = true; sm.at = 0;
  go("strategy");
});

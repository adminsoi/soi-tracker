"use strict";
// Company → On/offboarding.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- On/offboarding ----
// One checklist per person joining or leaving: IT and Admin sections,
// copied from the standard items (which anyone here can add to). Ticking
// the last IT item emails the admin person (Melissa) that it's over to
// them. HR, IT and the named people only; the server checks every request.
var ob = { data: null, at: 0, loading: false, error: "", show: "open", open: {}, adding: false, form: { kind: "offboarding" }, std: false, stdKind: "offboarding", newItem: {} };
function loadOnboarding() {
  if (ob.loading) return;
  ob.loading = true;
  api("/api/onboarding").then(function (d) { ob.data = d; ob.error = ""; }, function (err) { ob.error = err.message; })
    .then(function () { ob.loading = false; ob.at = Date.now(); requestRender(); });
}
function obPut(l) {
  var i = ob.data.lists.findIndex(function (x) { return x.id === l.id; });
  if (i === -1) ob.data.lists.unshift(l); else ob.data.lists[i] = l;
  obMine.at = 0;
  render();
}
function obName(u) { u = String(u || ""); return u.charAt(0).toUpperCase() + u.slice(1); }
function obWhen(t) { return t ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""; }

function renderOnboarding() {
  setBreadcrumb(["Company", "On/offboarding"]);
  var head = '<div class="intro"><div><div class="eyebrow">Company</div><h1>On/offboarding</h1>' +
    "<p>A checklist for everyone joining or leaving: the <b>IT</b> side (server login, Duo, email…) and the <b>Admin</b> side (keys, badge, building access…). " +
    "When the last IT item is ticked, " + E(ob.data ? obName(ob.data.admin) : "the admin person") + " gets an email that it's over to them.</p></div></div>";
  if (!me.onboarding) return head + '<div class="empty">On/offboarding is for full access, HR, IT and the people named for it.</div>';
  if (!ob.loading && (ob.error ? Date.now() - ob.at > 15000 : !ob.data || Date.now() - ob.at > 60000)) loadOnboarding();
  if (ob.error && !ob.data) return head + '<div class="banner">' + E(ob.error) + "</div>";
  if (!ob.data) return head + '<div class="empty">Loading…</div>';
  var d = ob.data;
  var lists = d.lists.filter(function (l) { return ob.show === "open" ? !l.closedAt : !!l.closedAt; });
  var bar = '<div class="table-toolbar"><div class="seg">' + [["open", "Open"], ["done", "Closed"]].map(function (x) {
      var n = d.lists.filter(function (l) { return x[0] === "open" ? !l.closedAt : !!l.closedAt; }).length;
      return '<button type="button" data-ob-show="' + x[0] + '" class="' + (ob.show === x[0] ? "active" : "") + '">' + x[1] + ' <span class="ib-n">' + n + "</span></button>";
    }).join("") + "</div>" +
    '<span class="grow" style="flex:1"></span><button type="button" data-ob-std>' + (ob.std ? "Hide standard items" : "Standard items") + '</button><button type="button" class="primary" data-ob-new>+ New checklist</button></div>';
  return head + bar + (ob.adding ? obNewForm() : "") + (ob.std ? obStdEditor() : "") +
    (lists.length ? lists.map(obCard).join("") : '<div class="card empty">' + (ob.show === "open" ? "No open checklists. Start one with + New checklist." : "No closed checklists yet.") + "</div>") +
    '<p class="small-note">Keep it to names and tasks: no passwords, ID numbers or pay here.</p>';
}
function obNewForm() {
  var f = ob.form;
  return '<div class="card" style="padding:18px 20px;margin-bottom:14px;"><div class="card-label">New checklist</div>' +
    '<div class="seg" style="margin-bottom:12px;">' + [["onboarding", "Onboarding (joining)"], ["offboarding", "Offboarding (leaving)"]].map(function (x) {
      return '<button type="button" data-ob-kind="' + x[0] + '" class="' + (f.kind === x[0] ? "active" : "") + '">' + x[1] + "</button>";
    }).join("") + "</div>" +
    '<div class="grid-2" style="gap:0 16px;">' +
    '<div class="nb-field"><label for="obPerson">Person</label><input id="obPerson" data-ob-f="person" value="' + E(f.person || "") + '" autocomplete="off" placeholder="Their name"></div>' +
    '<div class="nb-field"><label for="obCo">Company</label><select id="obCo" data-ob-f="company">' + myCompanies().map(function (c) { return '<option value="' + E(c) + '"' + ((f.company || myCompanies()[0]) === c ? " selected" : "") + ">" + E(shortCo(c)) + "</option>"; }).join("") + "</select></div>" +
    '<div class="nb-field"><label for="obDate">' + (f.kind === "onboarding" ? "Start date" : "Last day") + '</label><input id="obDate" type="date" data-ob-f="date" value="' + E(f.date || "") + '"></div>' +
    '<div class="nb-field"><label for="obNotes">Notes (optional)</label><input id="obNotes" data-ob-f="notes" value="' + E(f.notes || "") + '" autocomplete="off"></div></div>' +
    '<p class="small-note">It starts with the standard ' + (f.kind === "onboarding" ? "onboarding" : "offboarding") + " items; add more on the checklist.</p>" +
    '<div class="nb-foot"><button type="button" class="primary" data-ob-create>Start checklist</button><button type="button" class="text-button" data-ob-cancel>Cancel</button></div></div>';
}
function obCard(l) {
  var d = ob.data, open = !!ob.open[l.id], p = l.progress;
  var pct = p.total ? Math.round(100 * p.done / p.total) : 0;
  var hand = l.handoffAt ? '<span class="lg-pill sop-ok">IT done' + (l.handoffEmailed ? " · emailed " + E(obName(d.admin)) : "") + " · " + E(obWhen(l.handoffAt)) + "</span>" : "";
  var html = '<div class="card ob-card' + (l.closedAt ? " ob-closed" : "") + '">' +
    '<button type="button" class="ob-head" data-ob-open="' + E(l.id) + '" aria-expanded="' + open + '">' +
      '<span class="lg-pill ' + (l.kind === "offboarding" ? "lg-soon" : "sop-ok") + '">' + E(d.kinds[l.kind]) + "</span>" +
      '<span class="ob-person">' + E(l.person) + "</span>" +
      '<span class="small-note">' + E([l.company ? shortCo(l.company) : "", l.date ? (l.kind === "onboarding" ? "starts " : "last day ") + fmtDate(l.date) : ""].filter(Boolean).join(" · ")) + "</span>" +
      '<span class="grow" style="flex:1"></span>' + hand +
      '<span class="ob-bar" title="' + p.done + " of " + p.total + ' done"><span style="width:' + pct + '%"></span></span><span class="small-note">' + p.done + "/" + p.total + "</span></button>";
  if (open) {
    html += '<div class="ob-body"><div class="ob-cols">' + Object.keys(d.sections).map(function (s) {
      var items = l.sections[s] || [], left = items.filter(function (x) { return !x.done; }).length;
      return '<div class="ob-col"><div class="card-label">' + E(d.sections[s]) + ' <span class="small-note">' + (left ? left + " to do" : "all done") + "</span></div>" +
        items.map(function (x) {
          return '<label class="ob-item' + (x.done ? " done" : "") + '"><input type="checkbox" class="check" data-ob-tick="' + E(l.id) + "|" + E(x.id) + '"' + (x.done ? " checked" : "") + (l.closedAt ? " disabled" : "") + ">" +
            '<span class="ob-label"><span class="ob-text">' + E(x.label) + "</span>" + (x.done ? '<span class="small-note"> · ' + E(x.by) + " " + E(obWhen(x.at)) + "</span>" : "") + "</span>" +
            (l.closedAt ? "" : '<button type="button" class="text-button" data-ob-rm="' + E(l.id) + "|" + E(x.id) + '" title="Remove this item" aria-label="Remove ' + E(x.label) + '">×</button>') + "</label>";
        }).join("") +
        (l.closedAt ? "" : '<div class="ob-add"><input data-ob-add-text="' + E(l.id) + "|" + s + '" placeholder="Add an item for ' + E(d.sections[s]) + '" value="' + E(ob.newItem[l.id + "|" + s] || "") + '"><button type="button" data-ob-add="' + E(l.id) + "|" + s + '">Add</button></div>') + "</div>";
    }).join("") + "</div>" +
    (l.notes ? '<p class="small-note">Notes: ' + E(l.notes) + "</p>" : "") +
    '<details class="ob-log"><summary>History (' + (l.log || []).length + ")</summary>" + (l.log || []).slice().reverse().map(function (h) { return '<div class="small-note">' + E(new Date(h.at).toLocaleString()) + " · <b>" + E(h.by) + "</b> · " + E(h.what) + "</div>"; }).join("") + "</details>" +
    '<div class="nb-foot"><span class="grow"></span>' + (l.closedAt ? '<button type="button" data-ob-close="' + E(l.id) + '|0">Reopen</button>' : '<button type="button" data-ob-close="' + E(l.id) + '|1">' + (l.allDone ? "Close checklist" : "Close (not all ticked)") + "</button>") + "</div></div>";
  }
  return html + "</div>";
}
// The standard items each new checklist starts from.
function obStdEditor() {
  var d = ob.data, k = ob.stdKind, t = d.templates[k];
  return '<div class="card" style="padding:18px 20px;margin-bottom:14px;"><div class="card-label">Standard items</div>' +
    '<div class="seg" style="margin-bottom:12px;">' + Object.keys(d.kinds).map(function (x) {
      return '<button type="button" data-ob-stdkind="' + x + '" class="' + (k === x ? "active" : "") + '">' + E(d.kinds[x]) + "</button>";
    }).join("") + "</div>" +
    '<div class="ob-cols">' + Object.keys(d.sections).map(function (s) {
      return '<div class="ob-col"><div class="card-label">' + E(d.sections[s]) + "</div>" +
        t[s].map(function (label, i) { return '<div class="ob-item"><span class="ob-label">' + E(label) + '</span><button type="button" class="text-button" data-ob-stdrm="' + s + "|" + i + '" aria-label="Remove ' + E(label) + '">×</button></div>'; }).join("") +
        '<div class="ob-add"><input data-ob-stdtext="' + s + '" placeholder="Add a standard ' + E(d.sections[s]) + ' item" value="' + E(ob.newItem["std|" + s] || "") + '"><button type="button" data-ob-stdadd="' + s + '">Add</button></div></div>';
    }).join("") + "</div>" +
    '<p class="small-note">Changes apply to checklists started from now on; checklists already started keep their own items.</p></div>';
}
function obSaveStd(section, items) {
  var k = ob.stdKind;
  api("/api/onboarding/templates", { method: "PUT", body: JSON.stringify({ kind: k, section: section, items: items }) })
    .then(function (t) { ob.data.templates = t; toast("Standard items saved."); render(); }, function (err) { toast(err.message, true); });
}
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-ob-show],[data-ob-new],[data-ob-cancel],[data-ob-create],[data-ob-kind],[data-ob-open],[data-ob-rm],[data-ob-add],[data-ob-close],[data-ob-std],[data-ob-stdkind],[data-ob-stdrm],[data-ob-stdadd],[data-ob-goto]");
  if (!t || !$("#view").contains(t)) return;
  var ds = t.dataset;
  if (ds.obShow) { ob.show = ds.obShow; render(); return; }
  if ("obNew" in ds) { ob.adding = true; ob.form = { kind: "offboarding" }; render(); var el = $("#obPerson"); if (el) el.focus(); return; }
  if ("obCancel" in ds) { ob.adding = false; render(); return; }
  if (ds.obKind) { ob.form.kind = ds.obKind; render(); return; }
  if ("obCreate" in ds) {
    var f = Object.assign({ company: myCompanies()[0] }, ob.form);
    if (!String(f.person || "").trim()) { toast("Who is it for?", true); return; }
    api("/api/onboarding/lists", { method: "POST", body: JSON.stringify(f) }).then(function (l) {
      ob.adding = false; ob.open[l.id] = true; ob.show = "open"; obPut(l);
    }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.obOpen) { ob.open[ds.obOpen] = !ob.open[ds.obOpen]; render(); return; }
  if (ds.obRm) {
    var r = ds.obRm.split("|");
    if (!confirm("Remove this item from the checklist?")) return;
    api("/api/onboarding/lists/" + encodeURIComponent(r[0]) + "/items/" + encodeURIComponent(r[1]), { method: "PATCH", body: JSON.stringify({ remove: true }) }).then(obPut, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.obAdd) {
    var a = ds.obAdd.split("|"), label = (ob.newItem[ds.obAdd] || "").trim();
    if (!label) { toast("Write the item first.", true); return; }
    api("/api/onboarding/lists/" + encodeURIComponent(a[0]) + "/items", { method: "POST", body: JSON.stringify({ section: a[1], label: label }) })
      .then(function (l) { ob.newItem[ds.obAdd] = ""; obPut(l); }, function (err) { toast(err.message, true); });
    return;
  }
  if (ds.obClose) {
    var c = ds.obClose.split("|");
    api("/api/onboarding/lists/" + encodeURIComponent(c[0]), { method: "PATCH", body: JSON.stringify({ closed: c[1] === "1" }) }).then(obPut, function (err) { toast(err.message, true); });
    return;
  }
  if ("obStd" in ds) { ob.std = !ob.std; render(); return; }
  if (ds.obStdkind) { ob.stdKind = ds.obStdkind; render(); return; }
  if (ds.obStdrm) { var sr = ds.obStdrm.split("|"), list = ob.data.templates[ob.stdKind][sr[0]].slice(); list.splice(+sr[1], 1); obSaveStd(sr[0], list); return; }
  if (ds.obStdadd) {
    var lab = (ob.newItem["std|" + ds.obStdadd] || "").trim();
    if (!lab) { toast("Write the item first.", true); return; }
    ob.newItem["std|" + ds.obStdadd] = "";
    obSaveStd(ds.obStdadd, ob.data.templates[ob.stdKind][ds.obStdadd].concat([lab]));
  }
});
document.addEventListener("input", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (ds.obF) ob.form[ds.obF] = t.value;
  if (ds.obAddText) ob.newItem[ds.obAddText] = t.value;
  if (ds.obStdtext) ob.newItem["std|" + ds.obStdtext] = t.value;
});
document.addEventListener("change", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (ds.obF) { ob.form[ds.obF] = t.value; return; }
  if (ds.obTick) {
    var p = ds.obTick.split("|");
    api("/api/onboarding/lists/" + encodeURIComponent(p[0]) + "/items/" + encodeURIComponent(p[1]), { method: "PATCH", body: JSON.stringify({ done: t.checked }) })
      .then(function (l) {
        var was = (ob.data.lists.filter(function (x) { return x.id === l.id; })[0] || {}).handoffAt;
        obPut(l);
        if (l.handoffAt && !was) toast(l.handoffEmailed ? "IT side done — emailed " + obName(ob.data.admin) + " to take over." : "IT side done (no email could be sent).");
      }, function (err) { toast(err.message, true); t.checked = !t.checked; });
  }
});
document.addEventListener("keydown", function (e) {
  var t = e.target, ds = (t && t.dataset) || {};
  if (e.key !== "Enter") return;
  var b = ds.obAddText ? $('[data-ob-add="' + ds.obAddText + '"]') : ds.obStdtext ? $('[data-ob-stdadd="' + ds.obStdtext + '"]') : null;
  if (b) { e.preventDefault(); b.click(); }
});

// ---- Mentions of You: checklists waiting on you ----
// IT: open IT items. The admin person: the Admin side once IT is done.
var obMine = { items: null, at: 0, loading: false };
function loadOnboardingMine() {
  if (!me || !me.onboarding) return Promise.resolve([]);
  if (obMine.loading || (obMine.items && Date.now() - obMine.at < 60000)) return Promise.resolve(obMine.items || []);
  obMine.loading = true;
  return api("/api/onboarding/mine").then(function (x) {
    var changed = JSON.stringify(x.items) !== JSON.stringify(obMine.items);
    obMine.items = x.items || []; obMine.at = Date.now();
    if (changed && page === "mentions") requestRender();
    return obMine.items;
  }, function () { obMine.items = obMine.items || []; return obMine.items; }).then(function (v) { obMine.loading = false; return v; });
}
function onboardingNotices() {
  loadOnboardingMine();
  var list = obMine.items || [];
  if (!list.length) return "";
  return '<div class="card" style="padding:16px 18px;margin-bottom:16px;"><div class="card-label">On/offboarding</div><ul class="lg-due-list">' +
    list.map(function (x) {
      return '<li><button type="button" class="text-button" data-ob-goto="' + E(x.id) + '">' + E(x.person) + " — " + E(x.kind === "onboarding" ? "onboarding" : "offboarding") + "</button> " +
        '<span class="small-note">' + E(x.side) + ": " + x.left + " to do" + (x.date ? " · " + E(fmtDate(x.date)) : "") + "</span></li>";
    }).join("") + "</ul></div>";
}
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-ob-goto]");
  if (!t || $("#view").contains(t) && page === "onboarding") return;
  ob.open[t.dataset.obGoto] = true; ob.show = "open"; ob.at = 0;
  go("onboarding");
});

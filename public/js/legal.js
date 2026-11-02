"use strict";
// Administration → Legal: contracts, insurance and vendor documents with
// their expiry dates, notes and person responsible.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- Legal ----
// Leadership plus the named staff (the server checks every request). One tab
// per section; each lists the documents in that section's Documents folder
// (Documents → Legal), where they're added. Expiry date, notes and the
// person responsible are typed here; anything expiring within 60 days shows
// on that person's Mentions of You, and expired rows are red.
var LG_SECTIONS = [["usgov", "US Government Contracts"], ["bd", "Business Development"], ["insurance", "Insurance"], ["vendors", "Vendors"]];
var lg = { data: null, at: 0, loading: false, error: "", tab: "", q: "", show: "all", notes: {}, addMember: "" };
function loadLegal() {
  if (lg.loading) return;
  lg.loading = true;
  api("/api/legal").then(function (d) { lg.data = d; lg.error = ""; }, function (err) { lg.error = err.message; })
    .then(function () { lg.loading = false; lg.at = Date.now(); requestRender(); });
}
function lgCompanyOk(c) { return activeCompany === ALL || c === activeCompany; }
function lgStatus(r, soon) {
  if (r.status === "expired") return '<span class="lg-pill lg-expired">Expired ' + (-r.daysLeft === 1 ? "yesterday" : -r.daysLeft + " days ago") + "</span>";
  if (r.status === "soon") return '<span class="lg-pill lg-soon">' + (r.daysLeft === 0 ? "Expires today" : "Expires in " + r.daysLeft + " day" + (r.daysLeft === 1 ? "" : "s")) + "</span>";
  if (r.status === "ok") return '<span class="small-note">' + r.daysLeft + " days left</span>";
  return '<span class="small-note">No expiry date</span>';
}

// Called by renderDepartment (departments.js) for the Legal tab; head is
// the Administration header with the department tabs.
function renderLegal(head) {
  if (!me.legal) return head + '<div class="empty">Legal is for Leadership and the people they add.</div>';
  if (!lg.loading && (lg.error ? Date.now() - lg.at > 15000 : !lg.data || Date.now() - lg.at > 60000)) loadLegal();
  if (lg.error && !lg.data) return head + '<div class="banner">' + E(lg.error) + "</div>";
  if (!lg.data) return head + '<div class="empty">Loading Legal…</div>';
  var d = lg.data;
  var secs = d.sections.filter(function (s) { return lgCompanyOk(s.company); });
  var tabs = LG_SECTIONS.filter(function (t) { return secs.some(function (s) { return s.id === t[0]; }); });
  if (!tabs.length) return head + '<div class="empty">Legal has no folders for this company.</div>';
  if (!tabs.some(function (t) { return t[0] === lg.tab; })) lg.tab = tabs[0][0];
  var here = secs.filter(function (s) { return s.id === lg.tab; });
  var all = d.rows.filter(function (r) { return r.section === lg.tab && lgCompanyOk(r.company); });
  var q = lg.q.trim().toLowerCase();
  var rows = all.filter(function (r) {
    if (lg.show === "expired" && r.status !== "expired") return false;
    if (lg.show === "soon" && r.status !== "soon" && r.status !== "expired") return false;
    if (lg.show === "nodate" && r.expiry) return false;
    return !q || [r.name, r.path, r.notes, r.owner].join(" ").toLowerCase().indexOf(q) !== -1;
  }).sort(function (a, b) { return (a.expiry || "9999") < (b.expiry || "9999") ? -1 : (a.expiry || "9999") > (b.expiry || "9999") ? 1 : a.name.localeCompare(b.name); });
  var expired = all.filter(function (r) { return r.status === "expired"; }).length, soon = all.filter(function (r) { return r.status === "soon"; }).length;
  var multi = activeCompany === ALL;
  var people = d.people;
  var table = rows.length ? '<div class="table-wrap"><table class="wide lg-table"><thead><tr><th>Document</th>' + (multi ? "<th>Company</th>" : "") +
    "<th>Expiry (renewal) date</th><th>Status</th><th>Person responsible</th><th>Notes</th><th>Added</th></tr></thead><tbody>" +
    rows.map(function (r) {
      var opts = ['<option value="">Nobody</option>'].concat((r.owner && people.indexOf(r.owner) === -1 ? [r.owner] : []).concat(people).map(function (p) {
        return '<option value="' + E(p) + '"' + (sameUser(p, r.owner) ? " selected" : "") + ">" + E(p) + "</option>";
      }));
      return '<tr class="' + (r.status === "expired" ? "lg-row-expired" : "") + '">' +
        '<td><button type="button" class="dc-name" data-lg-view="' + E(r.id) + '">📄 ' + E(r.name) + "</button>" + (r.path ? '<span class="co-note">' + E(r.path) + "</span>" : "") + "</td>" +
        (multi ? "<td>" + E(shortCo(r.company)) + "</td>" : "") +
        '<td><input type="date" data-lg-expiry="' + E(r.id) + '" value="' + E(r.expiry) + '" aria-label="Expiry date for ' + E(r.name) + '"></td>' +
        "<td>" + lgStatus(r) + "</td>" +
        '<td><select data-lg-owner="' + E(r.id) + '" aria-label="Person responsible for ' + E(r.name) + '">' + opts.join("") + "</select></td>" +
        '<td class="notes-cell"><textarea class="fb-in fb-notes" rows="1" data-lg-notes="' + E(r.id) + '" placeholder="Notes…" aria-label="Notes for ' + E(r.name) + '">' + E(r.id in lg.notes ? lg.notes[r.id] : r.notes) + "</textarea></td>" +
        '<td><span class="small-note">' + E(r.by || "") + " · " + E(new Date(r.at).toLocaleDateString()) + "</span></td></tr>";
    }).join("") + "</tbody></table></div>"
    : '<div class="card empty">' + (all.length ? "Nothing matches." : "No documents in this folder yet. Add them in Documents → Legal → " + E(LG_SECTIONS.filter(function (t) { return t[0] === lg.tab; })[0][1]) + ".") + "</div>";
  return head +
    '<div class="subbar"><div class="seg" role="tablist" aria-label="Legal sections">' + tabs.map(function (t) {
      return '<button type="button" role="tab" data-lg-tab="' + E(t[0]) + '" aria-selected="' + (t[0] === lg.tab) + '" class="' + (t[0] === lg.tab ? "active" : "") + '">' + E(t[1]) + "</button>";
    }).join("") + "</div></div>" +
    '<div class="summary-cards">' + metric("Documents", all.length, "In this section's folder") +
    metric("Expiring soon", soon, "Within " + d.soonDays + " days") + metric("Expired", expired, "Past the expiry date", expired > 0) + "</div>" +
    '<div class="table-toolbar"><input type="search" id="lgSearch" placeholder="Search name, folder, notes or person" value="' + E(lg.q) + '" aria-label="Search Legal documents">' +
    '<div class="seg" aria-label="Show">' + [["all", "All"], ["soon", "Due within " + d.soonDays + " days"], ["expired", "Expired"], ["nodate", "No date"]].map(function (x) {
      return '<button type="button" data-lg-show="' + x[0] + '" class="' + (x[0] === lg.show ? "active" : "") + '">' + E(x[1]) + "</button>";
    }).join("") + "</div>" +
    here.map(function (s) { return '<button type="button" data-lg-open="' + E(s.space + "|" + s.folder) + '">' + (multi ? E(shortCo(s.company)) + ": " : "") + (s.canEdit ? "Add documents in Documents" : "Open folder in Documents") + "</button>"; }).join("") + "</div>" +
    table +
    '<p class="small-note">Documents are added, versioned and archived in Documents (Legal folders, read-only until IT grants edit access) and open view-only here. Type expiry dates and notes by hand from the signed documents; don\'t enter contract prices here. Anything expiring within ' + d.soonDays + " days shows on the person responsible's Mentions of You.</p>" +
    (d.members ? renderLegalMembers(d) : "");
}
// Leadership: who else has Legal.
function renderLegalMembers(d) {
  var avail = d.logins.filter(function (u) { return d.members.indexOf(u) === -1; });
  return '<div class="card" style="padding:16px 18px;margin-top:16px;"><div class="card-label">People with Legal (besides Leadership)</div>' +
    (d.members.length ? '<div class="lg-members">' + d.members.map(function (m) {
      return '<span class="lg-member">' + E(m) + ' <button type="button" class="text-button danger" data-lg-rm="' + E(m) + '" aria-label="Remove ' + E(m) + ' from Legal">Remove</button></span>';
    }).join("") + "</div>" : '<p class="small-note">Only Leadership has Legal right now.</p>') +
    '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;"><select id="lgAdd" aria-label="Login to add"><option value="">Add a person…</option>' +
    avail.map(function (u) { return '<option value="' + E(u) + '"' + (u === lg.addMember ? " selected" : "") + ">" + E(u) + "</option>"; }).join("") +
    '</select><button type="button" data-lg-add>Add</button></div>' +
    '<p class="small-note">They see Legal and the Legal folders in Documents, and can set expiry dates, notes and who\'s responsible.</p></div>';
}

function lgSave(id, change) {
  api("/api/legal/records/" + encodeURIComponent(id), { method: "PUT", body: JSON.stringify(change) }).then(function (row) {
    lg.data.rows = lg.data.rows.map(function (r) { return r.id === id ? row : r; });
    if ("notes" in change) delete lg.notes[id];
    requestRender();
  }, function (err) { toast(err.message, true); lg.at = 0; requestRender(); });
}
function lgMembers(list) {
  api("/api/legal/members", { method: "PUT", body: JSON.stringify({ members: list }) }).then(function (x) {
    lg.data.members = x.members; lg.addMember = ""; lg.at = 0; toast("Saved."); render();
  }, function (err) { toast(err.message, true); });
}
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-lg-tab],[data-lg-show],[data-lg-view],[data-lg-open],[data-lg-rm],[data-lg-add]");
  if (!t || !$("#view").contains(t)) return;
  var ds = t.dataset;
  if (ds.lgTab) { lg.tab = ds.lgTab; lg.q = ""; render(); return; }
  if (ds.lgShow) { lg.show = ds.lgShow; render(); return; }
  if (ds.lgView) {
    var r = lg.data.rows.filter(function (x) { return x.id === ds.lgView; })[0];
    if (r) viewDocument("/api/documents/view?space=" + encodeURIComponent(r.space) + "&folder=" + encodeURIComponent(r.folder) + "&file=" + encodeURIComponent(r.id), r.name, r.type);
    return;
  }
  if (ds.lgOpen) { var p = ds.lgOpen.split("|"); dcs.tab = "browse"; dcs.space = p[0]; dcs.folder = p[1]; dcs.list = null; go("documents"); return; }
  if (ds.lgRm) { if (confirm("Remove " + ds.lgRm + " from Legal?")) lgMembers(lg.data.members.filter(function (m) { return m !== ds.lgRm; })); return; }
  if ("lgAdd" in ds) { if (!lg.addMember) { toast("Pick a person to add.", true); return; } lgMembers(lg.data.members.concat([lg.addMember])); }
});
document.addEventListener("input", function (e) {
  var t = e.target;
  if (t.id === "lgSearch") { lg.q = t.value; var pos = t.selectionStart; render(); var el = $("#lgSearch"); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (x) {} } return; }
  if (t.dataset && t.dataset.lgNotes) lg.notes[t.dataset.lgNotes] = t.value;
});
document.addEventListener("change", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (ds.lgExpiry) { lgSave(ds.lgExpiry, { expiry: t.value }); return; }
  if (ds.lgOwner) { lgSave(ds.lgOwner, { owner: t.value }); return; }
  if (ds.lgNotes) { lgSave(ds.lgNotes, { notes: t.value }); return; }
  if (t.id === "lgAdd") lg.addMember = t.value;
});

// ---- Mentions of You: Legal renewals ----
var lgMine = { items: null, at: 0 };
function loadLegalMine() {
  if (!me.legal) { lgMine.items = []; return Promise.resolve([]); }
  return api("/api/legal/mine").then(function (d) { lgMine.items = d.items; lgMine.at = Date.now(); return d.items; }, function () { return lgMine.items || []; });
}
// The block on Mentions of You (mentions.js); empty when nothing is due.
function legalReminders() {
  if (!me.legal) return "";
  if (!lgMine.items || Date.now() - lgMine.at > 60000) loadLegalMine().then(function () { if (page === "mentions") requestRender(); });
  var items = lgMine.items || [];
  if (!items.length) return "";
  return '<div class="card lg-due" style="padding:16px 18px;margin-bottom:16px;"><div class="card-label">Legal renewals you\'re responsible for</div><ul class="lg-due-list">' +
    items.map(function (x) {
      return '<li class="' + (x.status === "expired" ? "lg-row-expired" : "") + '"><button type="button" class="text-button" data-lg-goto="' + E(x.section) + '">' + E(x.name) + "</button> " +
        '<span class="small-note">' + E(x.sectionLabel) + " · " + E(shortCo(x.company)) + " · " + E(x.expiry) + "</span> " +
        lgStatus(x) + "</li>";
    }).join("") + "</ul></div>";
}
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-lg-goto]");
  if (!t || !$("#view").contains(t)) return;
  lg.tab = t.dataset.lgGoto; lg.show = "soon";
  go("dept/Legal");
});

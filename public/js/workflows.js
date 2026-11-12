"use strict";
// Company → Strategy Meeting → Workflows.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- Workflows ----
// Big plans mapped out two ways over the same boxes: a Flowchart (drag
// boxes around, draw arrows between them, decisions with yes/no branches)
// and a Roadmap (a column per phase, a card per box). Each box has a phase
// and a status. Leadership only (the server checks every request). Every
// change saves on its own a moment later; if someone else saved in between,
// their version is shown instead.
var WF_SHAPES = [["step", "Step"], ["decision", "Decision"], ["start", "Start"], ["end", "End"], ["note", "Note"]];
var WF_STATUS = [["todo", "To do"], ["doing", "In progress"], ["done", "Done"], ["blocked", "Blocked"]];
var WF_STATUS_LABEL = { todo: "To do", doing: "In progress", done: "Done", blocked: "Blocked" };
var wf = {
  data: null, at: 0, rev: 0, loading: false, error: "", cur: "", sel: null, connect: "", zoom: 1, drag: null,
  dirty: false, saving: false, timer: null, savedAt: 0, adding: false, newTitle: "", archived: false, scroll: {},
  view: (function () { try { return localStorage.getItem("soi_tracker_wf_view") || "flow"; } catch (e) { return "flow"; } })()
};
// A refresh that comes back after an edit was made (or while one is being
// saved) is dropped, so it never replaces unsaved changes.
function loadWorkflows(force) {
  if (wf.loading || (!force && (wf.dirty || wf.saving))) return;
  wf.loading = true;
  var rev = wf.rev;
  api("/api/strategy/workflows").then(function (d) {
    if (rev !== wf.rev || ((wf.dirty || wf.saving) && !force)) return;
    wf.data = d; wf.error = "";
  }, function (err) { wf.error = err.message; })
    .then(function () { wf.loading = false; wf.at = Date.now(); if (!wf.drag) requestRender(); });
}
function wfCur() {
  if (!wf.data) return null;
  var list = wf.data.workflows;
  return list.filter(function (w) { return w.id === wf.cur; })[0] || list.filter(function (w) { return !w.archived; })[0] || null;
}
function wfNode(w, id) { return w.nodes.filter(function (n) { return n.id === id; })[0] || null; }
function wfEdge(w, id) { return w.edges.filter(function (e) { return e.id === id; })[0] || null; }
function wfPhaseName(w, id) { var p = w.phases.filter(function (x) { return x.id === id; })[0]; return p ? p.name : ""; }
function wfId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// ---- Saving: a moment after each change, the whole workflow ----
function wfChange(fn, redraw) {
  var w = wfCur();
  if (!w) return;
  fn(w);
  wf.rev++;
  wf.dirty = true;
  clearTimeout(wf.timer);
  wf.timer = setTimeout(wfSave, 700);
  wfSavedNote();
  if (redraw !== false) render();
}
function wfSave() {
  var w = wfCur();
  if (!w || !wf.dirty) return;
  if (wf.saving) { clearTimeout(wf.timer); wf.timer = setTimeout(wfSave, 400); return; }
  wf.saving = true; wf.dirty = false;
  var body = { title: w.title, notes: w.notes, phases: w.phases, nodes: w.nodes, edges: w.edges, base: w.updatedAt };
  api("/api/strategy/workflows/" + encodeURIComponent(w.id), { method: "PUT", body: JSON.stringify(body) }).then(function (r) {
    // Update the copy on the page now (not one a refresh may have replaced).
    var live = wf.data.workflows.filter(function (x) { return x.id === r.id; })[0] || w;
    live.updatedAt = r.updatedAt; live.updatedBy = r.updatedBy;
    wf.saving = false; wf.savedAt = Date.now(); wfSavedNote();
    if (wf.dirty) { clearTimeout(wf.timer); wf.timer = setTimeout(wfSave, 300); }
  }, function (err) {
    wf.saving = false; wf.dirty = false; wf.rev++;
    toast(err.message, true);
    loadWorkflows(true);
  });
}
function wfSavedNote() {
  var el = $("#wfSaved");
  if (el) el.textContent = wfSavedText();
}
function wfSavedText() {
  if (wf.saving || wf.dirty) return "Saving…";
  var w = wfCur();
  if (wf.savedAt) return "Saved";
  return w && w.updatedAt ? "Last saved by " + w.updatedBy + " · " + new Date(w.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
}
window.addEventListener("beforeunload", function (e) { if (wf.dirty || wf.saving) { wfSave(); e.preventDefault(); e.returnValue = ""; } });

// ---- Box geometry ----
function wfLines(label, per, max) {
  var words = String(label || "").split(/\s+/).filter(Boolean), lines = [], cur = "";
  words.forEach(function (w) {
    while (w.length > per) { if (cur) { lines.push(cur); cur = ""; } lines.push(w.slice(0, per)); w = w.slice(per); }
    if (!cur) cur = w; else if ((cur + " " + w).length <= per) cur += " " + w; else { lines.push(cur); cur = w; }
  });
  if (cur) lines.push(cur);
  if (!lines.length) lines = ["(no label)"];
  if (lines.length > max) { lines = lines.slice(0, max); lines[max - 1] = lines[max - 1].slice(0, per - 1) + "…"; }
  return lines;
}
function wfBox(n) {
  if (n.shape === "decision") { var dl = wfLines(n.label, 16, 3); return { w: 200, h: 120, lines: dl }; }
  if (n.shape === "start" || n.shape === "end") { return { w: 150, h: 46, lines: wfLines(n.label, 18, 1) }; }
  var l = wfLines(n.label, 22, 4);
  return { w: 190, h: 30 + l.length * 17 + (n.shape === "note" ? 0 : 16), lines: l };
}
// Where an arrow from the centre of a box towards (tx, ty) leaves its edge.
function wfClip(n, tx, ty) {
  var b = wfBox(n), cx = n.x + b.w / 2, cy = n.y + b.h / 2, dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  var t = n.shape === "decision" ? 1 / (Math.abs(dx) / (b.w / 2) + Math.abs(dy) / (b.h / 2))
    : Math.min(dx ? (b.w / 2) / Math.abs(dx) : Infinity, dy ? (b.h / 2) / Math.abs(dy) : Infinity);
  return [cx + dx * t, cy + dy * t];
}
function wfEdgeGeom(w, e) {
  var a = wfNode(w, e.from), b = wfNode(w, e.to);
  if (!a || !b) return null;
  var ba = wfBox(a), bb = wfBox(b);
  var p = wfClip(a, b.x + bb.w / 2, b.y + bb.h / 2), q = wfClip(b, a.x + ba.w / 2, a.y + ba.h / 2);
  return { d: "M" + p[0].toFixed(1) + "," + p[1].toFixed(1) + " L" + q[0].toFixed(1) + "," + q[1].toFixed(1), mx: (p[0] + q[0]) / 2, my: (p[1] + q[1]) / 2 };
}
function wfCanvasSize(w) {
  var W = 1600, H = 900;
  w.nodes.forEach(function (n) { var b = wfBox(n); W = Math.max(W, n.x + b.w + 400); H = Math.max(H, n.y + b.h + 300); });
  return { W: W, H: H };
}

// ---- The tab ----
function renderWorkflows() {
  if (!wf.loading && (wf.error ? Date.now() - wf.at > 15000 : !wf.data || Date.now() - wf.at > 60000)) loadWorkflows();
  if (wf.error && !wf.data) return '<div class="banner">' + E(wf.error) + "</div>";
  if (!wf.data) return '<div class="empty">Loading workflows…</div>';
  var w = wfCur();
  if (w) wf.cur = w.id;
  var live = wf.data.workflows.filter(function (x) { return !x.archived; }), old = wf.data.workflows.filter(function (x) { return x.archived; });
  var pick = '<select id="wfPick" aria-label="Workflow">' + live.map(function (x) { return '<option value="' + E(x.id) + '"' + (w && x.id === w.id ? " selected" : "") + ">" + E(x.title) + "</option>"; }).join("") +
    (old.length ? '<optgroup label="Archived">' + old.map(function (x) { return '<option value="' + E(x.id) + '"' + (w && x.id === w.id ? " selected" : "") + ">" + E(x.title) + "</option>"; }).join("") + "</optgroup>" : "") + "</select>";
  var newForm = wf.adding || !wf.data.workflows.length ? '<div class="card" style="padding:16px 18px;margin-bottom:14px;"><div class="card-label">New workflow</div>' +
    '<div class="wf-new"><input id="wfNewTitle" data-wf-newtitle placeholder="Name it, e.g. 2027 growth plan" value="' + E(wf.newTitle) + '" autocomplete="off"><button type="button" class="primary" data-wf-create>Create</button>' +
    (wf.data.workflows.length ? '<button type="button" class="text-button" data-wf-cancelnew>Cancel</button>' : "") + "</div>" +
    '<p class="small-note">It starts with three phases and a Start box. Add steps, decisions and arrows on the Flowchart; see the same boxes by phase on the Roadmap.</p></div>' : "";
  if (!w) return newForm;
  var bar = '<div class="table-toolbar wf-bar">' + (wf.data.workflows.length > 1 ? pick : '<b class="wf-title-static">' + E(w.title) + "</b>") +
    '<div class="seg" aria-label="View"><button type="button" data-wf-view="flow" class="' + (wf.view === "flow" ? "active" : "") + '">Flowchart</button><button type="button" data-wf-view="road" class="' + (wf.view === "road" ? "active" : "") + '">Roadmap</button></div>' +
    (w.archived ? "" : '<div class="wf-adds">' + WF_SHAPES.filter(function (s) { return wf.view === "flow" || s[0] !== "note"; }).map(function (s) { return '<button type="button" data-wf-add="' + s[0] + '">+ ' + s[1] + "</button>"; }).join("") + "</div>") +
    (wf.view === "flow" ? '<div class="wf-zoom"><button type="button" data-wf-zoom="-1" aria-label="Zoom out">−</button><span>' + Math.round(wf.zoom * 100) + '%</span><button type="button" data-wf-zoom="1" aria-label="Zoom in">+</button>' +
      (w.archived ? "" : '<button type="button" data-wf-tidy title="Line the boxes up in a column per phase">Tidy by phase</button>') + "</div>" : "") +
    '<span class="grow" style="flex:1"></span><span class="small-note" id="wfSaved">' + E(wfSavedText()) + "</span>" +
    '<button type="button" class="primary" data-wf-new>+ New workflow</button></div>';
  var banner = w.archived ? '<div class="banner">This workflow is archived. <button type="button" class="text-button" data-wf-archive="0">Restore it</button> to edit, or <button type="button" class="text-button" data-wf-delete>delete it for good</button>.</div>' : "";
  var connectNote = wf.connect ? '<div class="banner wf-connecting">Click the box that <b>' + E((wfNode(w, wf.connect) || {}).label || "this") + "</b> leads to. <button type=\"button\" class=\"text-button\" data-wf-connect-cancel>Cancel</button> (or press Esc)</div>" : "";
  var main = wf.view === "flow" ? wfFlow(w) : wfRoad(w);
  setTimeout(wfAfterRender, 0);
  return newForm + bar + banner + connectNote + '<div class="wf-layout"><div class="wf-main">' + main + "</div>" + wfPanel(w) + "</div>" +
    '<p class="small-note">' + (wf.view === "flow" ? "Drag a box to move it; drag the small dot on its right edge onto another box to draw an arrow. Double-click empty space to add a step. Click a box or arrow to edit it; Delete removes it."
      : "Drag a card to another phase to move it. Click a card to edit it. The order follows the Flowchart, top to bottom.") +
    " Don't type government client details, contract terms or supplier prices here.</p>";
}
function wfAfterRender() {
  var sc = $("#wfScroll"), s = wf.scroll[wf.cur];
  if (sc && s) { sc.scrollLeft = s[0]; sc.scrollTop = s[1]; }
}

// Flowchart: an SVG canvas.
function wfFlow(w) {
  var size = wfCanvasSize(w), z = wf.zoom, sel = wf.sel || {};
  var edges = w.edges.map(function (e) {
    var g = wfEdgeGeom(w, e);
    if (!g) return "";
    var on = sel.type === "edge" && sel.id === e.id;
    var lab = e.label ? '<g class="wf-elabel" data-wf-elabel="' + E(e.id) + '" transform="translate(' + g.mx.toFixed(1) + "," + g.my.toFixed(1) + ')"><rect x="' + (-(e.label.length * 3.4 + 8)).toFixed(1) + '" y="-10" width="' + (e.label.length * 6.8 + 16).toFixed(1) + '" height="20" rx="10"></rect><text text-anchor="middle" y="4">' + E(e.label) + "</text></g>" : "";
    return '<g class="wf-edge' + (on ? " on" : "") + '" data-wf-edge="' + E(e.id) + '"><path class="wf-ehit" d="' + g.d + '"></path><path class="wf-eline" d="' + g.d + '" marker-end="url(#wfArrow)"></path>' + lab + "</g>";
  }).join("");
  var nodes = w.nodes.map(function (n) {
    var b = wfBox(n), on = sel.type === "node" && sel.id === n.id, body;
    if (n.shape === "decision") body = '<polygon class="wf-shape" points="' + b.w / 2 + ",0 " + b.w + "," + b.h / 2 + " " + b.w / 2 + "," + b.h + " 0," + b.h / 2 + '"></polygon>';
    else if (n.shape === "start" || n.shape === "end") body = '<rect class="wf-shape" width="' + b.w + '" height="' + b.h + '" rx="' + b.h / 2 + '"></rect>';
    else body = '<rect class="wf-shape" width="' + b.w + '" height="' + b.h + '" rx="' + (n.shape === "note" ? 3 : 10) + '"></rect>';
    var top = n.shape === "decision" ? b.h / 2 - (b.lines.length - 1) * 8.5 + 4 : n.shape === "start" || n.shape === "end" ? b.h / 2 + 5 : 24;
    var text = b.lines.map(function (l, i) { return '<text class="wf-label" x="' + b.w / 2 + '" y="' + (top + i * 17) + '" text-anchor="middle">' + E(l) + "</text>"; }).join("");
    var status = n.shape === "step" ? '<text class="wf-stxt" x="' + b.w / 2 + '" y="' + (b.h - 11) + '" text-anchor="middle">' + E(WF_STATUS_LABEL[n.status]) + "</text>" : "";
    var phase = n.phase && n.shape !== "note" ? '<text class="wf-ptxt" x="' + b.w / 2 + '" y="-7" text-anchor="middle">' + E(wfPhaseName(w, n.phase)) + "</text>" : "";
    var handle = w.archived ? "" : '<circle class="wf-handle" data-wf-handle="' + E(n.id) + '" cx="' + b.w + '" cy="' + b.h / 2 + '" r="7"><title>Drag onto another box to draw an arrow</title></circle>';
    return '<g class="wf-node wf-' + n.shape + " wf-s-" + n.status + (on ? " on" : "") + (wf.connect === n.id ? " from" : "") + '" data-wf-node="' + E(n.id) + '" transform="translate(' + n.x + "," + n.y + ')" tabindex="0" role="button" aria-label="' + E(n.label + " — " + WF_STATUS_LABEL[n.status]) + '">' +
      body + phase + text + status + handle + "</g>";
  }).join("");
  return '<div class="wf-scroll" id="wfScroll"><svg id="wfSvg" class="wf-svg' + (w.archived ? " ro" : "") + '" width="' + Math.round(size.W * z) + '" height="' + Math.round(size.H * z) + '" viewBox="0 0 ' + size.W + " " + size.H + '" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><pattern id="wfGrid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" class="wf-dot"></circle></pattern>' +
    '<marker id="wfArrow" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="wf-arrowhead"></path></marker></defs>' +
    '<rect class="wf-bg" data-wf-bg width="' + size.W + '" height="' + size.H + '" fill="url(#wfGrid)"></rect>' +
    edges + nodes + '<line id="wfTemp" class="wf-temp" x1="0" y1="0" x2="0" y2="0" style="display:none" marker-end="url(#wfArrow)"></line></svg></div>';
}

// Roadmap: a column per phase (and "No phase" when a box has none).
function wfOrder(a, b) { return a.y - b.y || a.x - b.x; }
function wfRoad(w) {
  var cols = w.phases.map(function (p) { return { id: p.id, name: p.name }; });
  var boxes = w.nodes.filter(function (n) { return n.shape !== "note"; });
  if (boxes.some(function (n) { return !n.phase; })) cols.push({ id: "", name: "No phase" });
  var sel = wf.sel || {};
  return '<div class="wf-road" style="grid-template-columns:repeat(' + Math.max(cols.length, 1) + ', minmax(170px, 1fr));">' + cols.map(function (c) {
    var cards = boxes.filter(function (n) { return (n.phase || "") === c.id; }).sort(wfOrder);
    var done = cards.filter(function (n) { return n.status === "done"; }).length;
    return '<section class="tk-col wf-col" data-wf-col="' + E(c.id) + '"><header><b>' + E(c.name) + '</b><span class="ib-n">' + done + "/" + cards.length + "</span></header>" +
      (cards.length ? cards.map(function (n) {
        var after = w.edges.filter(function (e) { return e.to === n.id; }).map(function (e) { var f = wfNode(w, e.from); return f ? f.label + (e.label ? " (" + e.label + ")" : "") : ""; }).filter(Boolean);
        var next = w.edges.filter(function (e) { return e.from === n.id; }).map(function (e) { var t = wfNode(w, e.to); return t ? (e.label ? e.label + " → " : "") + t.label : ""; }).filter(Boolean);
        return '<button type="button" class="tk-card wf-card wf-s-' + n.status + (sel.type === "node" && sel.id === n.id ? " on" : "") + '" data-wf-card="' + E(n.id) + '"' + (w.archived ? "" : ' draggable="true"') + ">" +
          '<span class="wf-card-status">' + E(WF_STATUS_LABEL[n.status]) + (n.shape !== "step" ? ' · <span class="wf-card-kind">' + E(n.shape === "decision" ? "Decision" : n.shape === "start" ? "Start" : "End") + "</span>" : "") + "</span>" +
          '<span class="tk-issue">' + E(n.label || "(no label)") + "</span>" +
          (after.length ? '<span class="tk-who">After: ' + E(after.join(", ")) + "</span>" : "") +
          (next.length ? '<span class="tk-who">Then: ' + E(next.join(", ")) + "</span>" : "") +
          (n.notes ? '<span class="tk-who wf-card-notes">' + E(n.notes.slice(0, 120)) + (n.notes.length > 120 ? "…" : "") + "</span>" : "") + "</button>";
      }).join("") : '<div class="brd-empty">Drop boxes here</div>') + "</section>";
  }).join("") + "</div>";
}

// The side panel: the selected box or arrow, or the workflow itself.
function wfPanel(w) {
  var sel = wf.sel || {}, ro = w.archived ? " disabled" : "";
  var n = sel.type === "node" && wfNode(w, sel.id), e = sel.type === "edge" && wfEdge(w, sel.id);
  var legend = '<div class="wf-legend">' + WF_STATUS.map(function (s) { return '<span class="wf-key wf-s-' + s[0] + '"><i></i>' + E(s[1]) + "</span>"; }).join("") + "</div>";
  if (n) {
    var outs = w.edges.filter(function (x) { return x.from === n.id; }), ins = w.edges.filter(function (x) { return x.to === n.id; });
    var link = function (x, other) { var o = wfNode(w, other); return '<li><button type="button" class="text-button" data-wf-sel-edge="' + E(x.id) + '">' + E((x.label ? x.label + ": " : "") + (o ? o.label : "?")) + "</button></li>"; };
    return '<aside class="card wf-panel"><div class="wf-panel-h"><div class="card-label">' + E(WF_SHAPES.filter(function (s) { return s[0] === n.shape; })[0][1]) + '</div><button type="button" class="text-button" data-wf-desel aria-label="Close">✕</button></div>' +
      '<div class="nb-field"><label for="wfLabel">Label</label><textarea id="wfLabel" rows="2" data-wf-field="label"' + ro + ">" + E(n.label) + "</textarea></div>" +
      (n.shape !== "note" ? '<div class="nb-field"><label>Status</label><div class="seg wf-status-seg">' + WF_STATUS.map(function (s) { return '<button type="button" data-wf-status="' + s[0] + '" class="' + (n.status === s[0] ? "active" : "") + '"' + ro + ">" + E(s[1]) + "</button>"; }).join("") + "</div></div>" : "") +
      '<div class="grid-2" style="gap:0 10px;"><div class="nb-field"><label for="wfShape">Kind</label><select id="wfShape" data-wf-field="shape"' + ro + ">" + WF_SHAPES.map(function (s) { return '<option value="' + s[0] + '"' + (n.shape === s[0] ? " selected" : "") + ">" + E(s[1]) + "</option>"; }).join("") + "</select></div>" +
      '<div class="nb-field"><label for="wfPhase">Phase</label><select id="wfPhase" data-wf-field="phase"' + ro + '><option value="">No phase</option>' + w.phases.map(function (p) { return '<option value="' + E(p.id) + '"' + (n.phase === p.id ? " selected" : "") + ">" + E(p.name) + "</option>"; }).join("") + "</select></div></div>" +
      '<div class="nb-field"><label for="wfNotes">Notes</label><textarea id="wfNotes" rows="3" data-wf-field="notes"' + ro + ">" + E(n.notes) + "</textarea></div>" +
      (outs.length ? '<div class="small-note">Leads to</div><ul class="wf-links">' + outs.map(function (x) { return link(x, x.to); }).join("") + "</ul>" : "") +
      (ins.length ? '<div class="small-note">Comes after</div><ul class="wf-links">' + ins.map(function (x) { return link(x, x.from); }).join("") + "</ul>" : "") +
      (w.archived ? "" : '<div class="nb-foot wf-actions"><button type="button" data-wf-connect="' + E(n.id) + '">→ Connect to…</button><button type="button" data-wf-dup="' + E(n.id) + '">Duplicate</button><button type="button" class="text-button danger" data-wf-rm>Delete</button></div>') + "</aside>";
  }
  if (e) {
    var a = wfNode(w, e.from), b = wfNode(w, e.to);
    return '<aside class="card wf-panel"><div class="wf-panel-h"><div class="card-label">Arrow</div><button type="button" class="text-button" data-wf-desel aria-label="Close">✕</button></div>' +
      '<p class="small-note"><b>' + E(a ? a.label : "?") + "</b> → <b>" + E(b ? b.label : "?") + "</b></p>" +
      '<div class="nb-field"><label for="wfELabel">Label (e.g. Yes / No)</label><input id="wfELabel" data-wf-efield="label" value="' + E(e.label) + '" autocomplete="off"' + ro + "></div>" +
      (w.archived ? "" : '<div class="nb-foot wf-actions"><button type="button" data-wf-reverse>Reverse</button><button type="button" class="text-button danger" data-wf-rm>Delete arrow</button></div>') + "</aside>";
  }
  var count = function (st) { return w.nodes.filter(function (x) { return x.shape !== "note" && x.status === st; }).length; };
  return '<aside class="card wf-panel"><div class="card-label">Workflow</div>' +
    '<div class="nb-field"><label for="wfTitle">Name</label><input id="wfTitle" data-wf-wfield="title" value="' + E(w.title) + '" autocomplete="off"' + ro + "></div>" +
    '<div class="nb-field"><label for="wfWNotes">Notes</label><textarea id="wfWNotes" rows="3" data-wf-wfield="notes"' + ro + ">" + E(w.notes) + "</textarea></div>" +
    '<div class="nb-field"><label>Phases</label>' + w.phases.map(function (p, i) {
      return '<div class="wf-phase"><input data-wf-phase="' + E(p.id) + '" value="' + E(p.name) + '" aria-label="Phase name"' + ro + ">" +
        (w.archived ? "" : '<button type="button" class="text-button" data-wf-pmove="' + E(p.id) + '|-1"' + (i ? "" : " disabled") + ' aria-label="Move earlier">↑</button><button type="button" class="text-button" data-wf-pmove="' + E(p.id) + '|1"' + (i < w.phases.length - 1 ? "" : " disabled") + ' aria-label="Move later">↓</button><button type="button" class="text-button" data-wf-prm="' + E(p.id) + '" aria-label="Remove phase">✕</button>') + "</div>";
    }).join("") + (w.archived ? "" : '<button type="button" class="text-button" data-wf-padd>+ Add a phase</button>') + "</div>" +
    '<div class="nb-field"><label>Status</label>' + legend + '<div class="small-note">' + WF_STATUS.map(function (s) { return count(s[0]) + " " + s[1].toLowerCase(); }).join(" · ") + "</div></div>" +
    (w.archived ? "" : '<div class="nb-foot"><button type="button" class="text-button" data-wf-archive="1">Archive this workflow</button></div>') + "</aside>";
}

// ---- Adding, removing, tidying ----
function wfAdd(shape, x, y) {
  var w = wfCur();
  if (!w || w.archived) return;
  var labels = { step: "New step", decision: "Decision?", start: "Start", end: "End", note: "Note" };
  var sel = wf.sel && wf.sel.type === "node" && wfNode(w, wf.sel.id);
  var phase = sel ? sel.phase : (w.phases[0] ? w.phases[0].id : "");
  if (x == null && wf.view === "road") {
    // Roadmap: at the bottom of its phase, so it shows last in the column.
    var col = Math.max(0, w.phases.findIndex(function (p) { return p.id === phase; }));
    x = 60 + col * 280; y = 60;
    w.nodes.forEach(function (n) { if (n.phase === phase) y = Math.max(y, n.y + wfBox(n).h + 50); });
  } else if (x == null) {
    var sc = $("#wfScroll");
    x = sc ? (sc.scrollLeft + 60) / wf.zoom : 80; y = sc ? (sc.scrollTop + 60) / wf.zoom : 80;
    var tries = 0;
    while (tries++ < 40 && w.nodes.some(function (n) { return Math.abs(n.x - x) < 30 && Math.abs(n.y - y) < 30; })) { x += 30; y += 30; }
  }
  var n = { id: wfId(), label: labels[shape], shape: shape, phase: phase, status: "todo", x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10, notes: "" };
  wfChange(function (w) { w.nodes.push(n); });
  wf.sel = { type: "node", id: n.id };
  render();
  var el = $("#wfLabel"); if (el) { el.focus(); el.select(); }
}
function wfLink(from, to) {
  var w = wfCur();
  if (!w || from === to || w.edges.some(function (e) { return e.from === from && e.to === to; })) return;
  var a = wfNode(w, from), out = w.edges.filter(function (e) { return e.from === from; }).length;
  var e = { id: wfId(), from: from, to: to, label: a && a.shape === "decision" ? (out === 0 ? "Yes" : out === 1 ? "No" : "") : "" };
  wf.sel = { type: "edge", id: e.id };
  wfChange(function (w) { w.edges.push(e); });
}
function wfRemoveSel() {
  var w = wfCur(), sel = wf.sel;
  if (!w || !sel || w.archived) return;
  wf.sel = null;
  wfChange(function (w) {
    if (sel.type === "node") {
      w.nodes = w.nodes.filter(function (n) { return n.id !== sel.id; });
      w.edges = w.edges.filter(function (e) { return e.from !== sel.id && e.to !== sel.id; });
    } else w.edges = w.edges.filter(function (e) { return e.id !== sel.id; });
  });
}
// Line the boxes up: a column per phase, top to bottom in their current order.
function wfTidy() {
  wfChange(function (w) {
    var cols = w.phases.map(function (p) { return p.id; }).concat([""]), col = 0;
    cols.forEach(function (pid) {
      var list = w.nodes.filter(function (n) { return (n.phase || "") === pid; }).sort(wfOrder);
      if (!list.length) return;
      var y = 60;
      list.forEach(function (n) { var b = wfBox(n); n.x = 60 + col * 280 + Math.round((200 - b.w) / 2); n.y = y; y += b.h + 50; });
      col++;
    });
  });
}

// ---- Events ----
function wfPoint(e) {
  var svg = $("#wfSvg"), r = svg.getBoundingClientRect();
  return { x: (e.clientX - r.left) / wf.zoom, y: (e.clientY - r.top) / wf.zoom };
}
// Move a box on screen while it's dragged (the page redraws on release).
function wfMoveLive(w, n) {
  var g = document.querySelector('[data-wf-node="' + n.id + '"]');
  if (g) g.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");
  w.edges.forEach(function (e) {
    if (e.from !== n.id && e.to !== n.id) return;
    var geo = wfEdgeGeom(w, e), eg = document.querySelector('[data-wf-edge="' + e.id + '"]');
    if (!geo || !eg) return;
    eg.querySelectorAll("path").forEach(function (p) { p.setAttribute("d", geo.d); });
    var lab = eg.querySelector("[data-wf-elabel]");
    if (lab) lab.setAttribute("transform", "translate(" + geo.mx.toFixed(1) + "," + geo.my.toFixed(1) + ")");
  });
}
document.addEventListener("pointerdown", function (e) {
  if (page !== "strategy" || !e.target.closest || !e.target.closest("#wfSvg") || e.button !== 0) return;
  var w = wfCur();
  if (!w) return;
  var p = wfPoint(e), h = e.target.closest("[data-wf-handle]"), g = e.target.closest("[data-wf-node]");
  if (h && !w.archived) {
    e.preventDefault();
    var a = wfNode(w, h.dataset.wfHandle), b = wfBox(a);
    wf.drag = { kind: "link", from: a.id, x0: a.x + b.w, y0: a.y + b.h / 2 };
    var t = $("#wfTemp");
    t.setAttribute("x1", wf.drag.x0); t.setAttribute("y1", wf.drag.y0); t.setAttribute("x2", p.x); t.setAttribute("y2", p.y); t.style.display = "";
    return;
  }
  if (g) {
    var n = wfNode(w, g.dataset.wfNode);
    wf.drag = { kind: "move", id: n.id, dx: p.x - n.x, dy: p.y - n.y, sx: e.clientX, sy: e.clientY, moved: false, ox: n.x, oy: n.y };
    e.preventDefault();
    return;
  }
  if (e.target.closest("[data-wf-bg]")) wf.drag = { kind: "bg", sx: e.clientX, sy: e.clientY };
});
document.addEventListener("pointermove", function (e) {
  var d = wf.drag;
  if (!d || d.kind === "bg") return;
  var w = wfCur(), p = wfPoint(e);
  if (d.kind === "link") { var t = $("#wfTemp"); if (t) { t.setAttribute("x2", p.x); t.setAttribute("y2", p.y); } return; }
  if (w.archived) return;
  if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 4) return;
  d.moved = true;
  var n = wfNode(w, d.id);
  n.x = Math.max(0, Math.round((p.x - d.dx) / 10) * 10); n.y = Math.max(10, Math.round((p.y - d.dy) / 10) * 10);
  wfMoveLive(w, n);
});
document.addEventListener("pointerup", function (e) {
  var d = wf.drag;
  if (!d) return;
  wf.drag = null;
  var w = wfCur();
  if (!w) return;
  if (d.kind === "link") {
    var t = $("#wfTemp"); if (t) t.style.display = "none";
    var under = document.elementFromPoint(e.clientX, e.clientY), g = under && under.closest && under.closest("[data-wf-node]");
    if (g && g.dataset.wfNode !== d.from) wfLink(d.from, g.dataset.wfNode);
    return;
  }
  if (d.kind === "move") {
    if (d.moved) {
      wf.sel = { type: "node", id: d.id };
      wfChange(function () {});
      return;
    }
    if (wf.connect && wf.connect !== d.id) { var from = wf.connect; wf.connect = ""; wfLink(from, d.id); return; }
    wf.sel = { type: "node", id: d.id }; render();
    return;
  }
  if (d.kind === "bg" && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 4 && (wf.sel || wf.connect)) { wf.sel = null; wf.connect = ""; render(); }
});
document.addEventListener("dblclick", function (e) {
  if (page !== "strategy" || !e.target.closest || !e.target.closest("[data-wf-bg]")) return;
  var p = wfPoint(e);
  wfAdd("step", p.x - 95, p.y - 30);
});
document.addEventListener("scroll", function (e) {
  if (e.target && e.target.id === "wfScroll") wf.scroll[wf.cur] = [e.target.scrollLeft, e.target.scrollTop];
}, true);
document.addEventListener("click", function (e) {
  if (page !== "strategy" || !e.target.closest) return;
  var t = e.target.closest("[data-wf-edge],[data-wf-card],[data-wf-view],[data-wf-add],[data-wf-zoom],[data-wf-tidy],[data-wf-new],[data-wf-create],[data-wf-cancelnew],[data-wf-desel],[data-wf-status],[data-wf-connect],[data-wf-connect-cancel],[data-wf-dup],[data-wf-rm],[data-wf-reverse],[data-wf-sel-edge],[data-wf-padd],[data-wf-prm],[data-wf-pmove],[data-wf-archive],[data-wf-delete]");
  if (!t || !$("#view").contains(t)) return;
  var ds = t.dataset, w = wfCur();
  if (ds.wfEdge) { if (wf.connect) return; wf.sel = { type: "edge", id: ds.wfEdge }; render(); return; }
  if (ds.wfCard) {
    if (wf.connect && w) { var from = wf.connect; wf.connect = ""; wfLink(from, ds.wfCard); return; }
    wf.sel = { type: "node", id: ds.wfCard }; render(); return;
  }
  if (ds.wfView) { wf.view = ds.wfView; try { localStorage.setItem("soi_tracker_wf_view", wf.view); } catch (err) {} render(); return; }
  if (ds.wfAdd) { wfAdd(ds.wfAdd); return; }
  if (ds.wfZoom) { wf.zoom = Math.min(2, Math.max(0.4, Math.round((wf.zoom + 0.2 * Number(ds.wfZoom)) * 10) / 10)); render(); return; }
  if ("wfTidy" in ds) { wfTidy(); return; }
  if ("wfNew" in ds) { wf.adding = true; wf.newTitle = ""; render(); var i = $("#wfNewTitle"); if (i) i.focus(); return; }
  if ("wfCancelnew" in ds) { wf.adding = false; render(); return; }
  if ("wfCreate" in ds) {
    var title = wf.newTitle.trim();
    if (!title) { toast("Give the workflow a name.", true); return; }
    api("/api/strategy/workflows", { method: "POST", body: JSON.stringify({ title: title }) }).then(function (x) {
      wf.data.workflows.unshift(x); wf.cur = x.id; wf.adding = false; wf.newTitle = ""; wf.sel = null; wf.view = "flow"; render();
    }, function (err) { toast(err.message, true); });
    return;
  }
  if ("wfDesel" in ds) { wf.sel = null; render(); return; }
  if (!w) return;
  if (ds.wfSelEdge) { wf.sel = { type: "edge", id: ds.wfSelEdge }; render(); return; }
  if ("wfConnectCancel" in ds) { wf.connect = ""; render(); return; }
  if (ds.wfArchive) {
    var arch = ds.wfArchive === "1";
    if (arch && !confirm("Archive “" + w.title + "”? It stays under Archived and can be restored.")) return;
    api("/api/strategy/workflows/" + encodeURIComponent(w.id), { method: "PUT", body: JSON.stringify({ archived: arch }) }).then(function (x) {
      Object.assign(w, x); if (arch) { wf.cur = ""; wf.sel = null; } render(); toast(arch ? "Archived." : "Restored.");
    }, function (err) { toast(err.message, true); });
    return;
  }
  if ("wfDelete" in ds) {
    if (!confirm("Delete “" + w.title + "” for good? This can't be undone.")) return;
    api("/api/strategy/workflows/" + encodeURIComponent(w.id), { method: "DELETE" }).then(function () {
      wf.data.workflows = wf.data.workflows.filter(function (x) { return x.id !== w.id; }); wf.cur = ""; wf.sel = null; render(); toast("Deleted.");
    }, function (err) { toast(err.message, true); });
    return;
  }
  if (w.archived) return;
  if (ds.wfStatus) { var sid = wf.sel.id; wfChange(function (w) { wfNode(w, sid).status = ds.wfStatus; }); return; }
  if (ds.wfConnect) { wf.connect = ds.wfConnect; render(); return; }
  if (ds.wfDup) {
    var src = wfNode(w, ds.wfDup), copy = Object.assign({}, src, { id: wfId(), x: src.x + 30, y: src.y + 30 });
    wf.sel = { type: "node", id: copy.id };
    wfChange(function (w) { w.nodes.push(copy); });
    return;
  }
  if ("wfRm" in ds) { wfRemoveSel(); return; }
  if ("wfReverse" in ds) { var eid = wf.sel.id; wfChange(function (w) { var x = wfEdge(w, eid), f = x.from; x.from = x.to; x.to = f; }); return; }
  if ("wfPadd" in ds) { wfChange(function (w) { w.phases.push({ id: wfId(), name: "Phase " + (w.phases.length + 1) }); }); return; }
  if (ds.wfPrm) {
    var p = w.phases.filter(function (x) { return x.id === ds.wfPrm; })[0], used = w.nodes.filter(function (n) { return n.phase === ds.wfPrm; }).length;
    if (used && !confirm("Remove “" + p.name + "”? Its " + used + " box" + (used === 1 ? "" : "es") + " will have no phase.")) return;
    wfChange(function (w) { w.phases = w.phases.filter(function (x) { return x.id !== ds.wfPrm; }); w.nodes.forEach(function (n) { if (n.phase === ds.wfPrm) n.phase = ""; }); });
    return;
  }
  if (ds.wfPmove) {
    var pm = ds.wfPmove.split("|");
    wfChange(function (w) { var i = w.phases.findIndex(function (x) { return x.id === pm[0]; }), j = i + Number(pm[1]); if (i < 0 || j < 0 || j >= w.phases.length) return; var tmp = w.phases[i]; w.phases[i] = w.phases[j]; w.phases[j] = tmp; });
  }
});
// Typing: update as you go without redrawing (so the cursor stays put).
document.addEventListener("input", function (e) {
  var t = e.target, ds = t.dataset || {};
  if ("wfNewtitle" in ds) { wf.newTitle = t.value; return; }
  var w = wfCur();
  if (!w || w.archived || page !== "strategy") return;
  if (ds.wfField === "label" || ds.wfField === "notes") { var id = wf.sel.id; wfChange(function (w) { wfNode(w, id)[ds.wfField] = t.value; }, false); return; }
  if (ds.wfEfield) { var eid = wf.sel.id; wfChange(function (w) { wfEdge(w, eid).label = t.value.slice(0, 60); }, false); return; }
  if (ds.wfWfield) { wfChange(function (w) { w[ds.wfWfield] = t.value; }, false); return; }
  if (ds.wfPhase) { wfChange(function (w) { var p = w.phases.filter(function (x) { return x.id === ds.wfPhase; })[0]; if (p) p.name = t.value.slice(0, 60); }, false); }
});
// Leaving a field (or picking from a list) redraws the canvas.
document.addEventListener("change", function (e) {
  var t = e.target, ds = t.dataset || {};
  if (page !== "strategy") return;
  if (t.id === "wfPick") { wfSave(); wf.cur = t.value; wf.sel = null; wf.connect = ""; render(); return; }
  var w = wfCur();
  if (!w || w.archived) return;
  if (ds.wfField === "shape" || ds.wfField === "phase") { var id = wf.sel.id; wfChange(function (w) { wfNode(w, id)[ds.wfField] = t.value; }); return; }
  if (ds.wfField || ds.wfEfield || ds.wfWfield || ds.wfPhase) render();
});
document.addEventListener("keydown", function (e) {
  if (page !== "strategy" || sm.tab !== "workflows") return;
  var t = e.target, typing = t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
  if (e.key === "Enter" && t && "wfNewtitle" in (t.dataset || {})) { e.preventDefault(); var b = $("[data-wf-create]"); if (b) b.click(); return; }
  if (e.key === "Escape" && (wf.connect || wf.sel) && !typing) { wf.connect = ""; wf.sel = null; render(); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && !typing && wf.sel) { e.preventDefault(); wfRemoveSel(); return; }
  if (e.key === "Enter" && !typing && t && t.dataset && t.dataset.wfNode) { wf.sel = { type: "node", id: t.dataset.wfNode }; render(); }
});
// Roadmap: drag a card to another phase.
document.addEventListener("dragstart", function (e) {
  var c = e.target.closest && e.target.closest("[data-wf-card]");
  if (!c) return;
  e.dataTransfer.setData("text/plain", c.dataset.wfCard); e.dataTransfer.effectAllowed = "move";
  wf.dragCard = c.dataset.wfCard;
});
document.addEventListener("dragover", function (e) {
  var col = wf.dragCard && e.target.closest && e.target.closest("[data-wf-col]");
  if (!col) return;
  e.preventDefault();
  document.querySelectorAll(".wf-col.over").forEach(function (x) { if (x !== col) x.classList.remove("over"); });
  col.classList.add("over");
});
document.addEventListener("drop", function (e) {
  var col = wf.dragCard && e.target.closest && e.target.closest("[data-wf-col]");
  if (!col) return;
  e.preventDefault();
  var id = wf.dragCard, pid = col.dataset.wfCol;
  wf.dragCard = "";
  wfChange(function (w) { var n = wfNode(w, id); if (n) n.phase = pid; });
});
document.addEventListener("dragend", function () { wf.dragCard = ""; document.querySelectorAll(".wf-col.over").forEach(function (x) { x.classList.remove("over"); }); });

"use strict";
// Private IT notebook (IT → Resolved).
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---- Private IT notebook (IT → Resolved) ----
// Only for logins with "Private IT notebook" ticked (the server checks).
// Left: resolved tickets or knowledge base articles. Right: the open one,
// saved as you type. A ticket's write-up can become an article in one click.
var NB_CATEGORIES = ["Hardware", "Software", "Account & access", "Email & Teams", "Network & VPN", "Printer", "Phone", "Other"];
var nb = { data: null, at: 0, loading: false, error: "", view: "tickets", sel: { tickets: "", kb: "" }, show: "all", q: "", edit: {}, timers: {} };
function loadNotebook() {
  if (nb.loading) return;
  nb.loading = true;
  api("/api/it-notebook").then(function (d) { matchPeople(d.resolved); nb.data = d; nb.error = ""; }, function (err) { nb.error = err.message; })
    .then(function () { nb.loading = false; nb.at = Date.now(); requestRender(); });
}
function nbCategories() {
  var seen = {};
  NB_CATEGORIES.concat((nb.data ? nb.data.articles.map(function (a) { return a.category; }).concat(nb.data.resolved.map(function (r) { return r.writeup && r.writeup.category; })) : []))
    .forEach(function (c) { if (c) seen[c] = 1; });
  return '<datalist id="nbCats">' + Object.keys(seen).map(function (c) { return '<option value="' + E(c) + '">'; }).join("") + "</datalist>";
}
function nbTicket(id) { return nb.data.resolved.filter(function (r) { return r.id === id; })[0]; }
function nbArticle(id) { return nb.data.articles.filter(function (a) { return a.id === id; })[0]; }
function nbWhen(ms) { return ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : ""; }

function renderNotebook() {
  if (!nb.data || Date.now() - nb.at > 300000) loadNotebook();
  if (nb.error) return '<div class="banner">' + E(nb.error) + "</div>";
  if (!nb.data) return '<div class="empty">Loading your notebook…</div>';
  var d = nb.data;
  var todo = d.resolved.filter(function (r) { return !(r.writeup && r.writeup.fix); }).length;
  return '<div class="table-toolbar" style="margin-top:16px;"><div class="seg">' +
      '<button type="button" data-nb-view="tickets" class="' + (nb.view === "tickets" ? "active" : "") + '">Resolved tickets (' + d.resolved.length + ")</button>" +
      '<button type="button" data-nb-view="kb" class="' + (nb.view === "kb" ? "active" : "") + '">Knowledge base (' + d.articles.length + ")</button></div>" +
      '<span class="small-note">Private — only you can see this.' + (nb.view === "tickets" && todo ? " " + todo + " still need a write-up." : "") + "</span>" +
      (nb.view === "kb" ? '<button type="button" class="primary" data-nb-new>+ New article</button>' : "") + "</div>" +
    nbCategories() + (nb.view === "kb" ? renderKb() : renderNbTickets());
}

function renderNbTickets() {
  var list = nb.data.resolved.filter(function (r) { return nb.show === "all" || !(r.writeup && r.writeup.fix); });
  if (!nb.sel.tickets || !nbTicket(nb.sel.tickets)) nb.sel.tickets = list.length ? list[0].id : "";
  var items = list.length ? list.map(function (r) {
    var w = r.writeup || {};
    return '<button type="button" class="nb-item' + (r.id === nb.sel.tickets ? " active" : "") + '" data-nb-ticket="' + E(r.id) + '">' +
      "<b>" + E(itrPerson(r)) + "</b>" + '<span class="nb-snip">' + E(r.issue || "—") + "</span>" +
      '<span class="nb-meta">' + E(fmtDate(r.submittedAt)) + " " + (w.fix ? '<span class="nb-chip">' + E(w.category || "Written up") + "</span>" : '<span class="nb-chip todo">Needs write-up</span>') + "</span></button>";
  }).join("") : '<div class="nb-empty">' + (nb.data.resolved.length ? "Everything's written up." : "Requests you mark done on the Requests tab show up here.") + "</div>";
  var head = '<div class="nb-list-head"><div class="seg">' + [["all", "All"], ["todo", "Needs write-up"]].map(function (x) {
    return '<button type="button" data-nb-show="' + x[0] + '" class="' + (nb.show === x[0] ? "active" : "") + '">' + x[1] + "</button>";
  }).join("") + "</div></div>";
  return '<div class="nb-grid"><div class="nb-list">' + head + items + '</div><div class="nb-pane">' + renderNbTicketPane(nbTicket(nb.sel.tickets)) + "</div></div>";
}
function renderNbTicketPane(r) {
  if (!r) return '<div class="nb-empty">Pick a ticket on the left.</div>';
  var w = r.writeup || {};
  var meta = [r.company, r.submittedAt ? "submitted " + fmtDate(r.submittedAt) : "", r.urgency ? "form said " + r.urgency : "", r.priority ? "rated " + r.priority : ""].filter(Boolean).join(" · ");
  var art = w.articleId && nbArticle(w.articleId);
  return "<h3>" + E(itrPerson(r)) + '</h3><div class="nb-sub">' + E(meta) + "</div>" +
    '<div class="nb-quote">' + E(r.issue || "No description.") + (r.notes ? "\n\n" + E(r.notes) : "") + "</div>" +
    '<div class="nb-field"><label for="nb-cat">Category</label><input id="nb-cat" list="nbCats" data-nb-t="category" data-id="' + E(r.id) + '" value="' + E(w.category || "") + '" placeholder="e.g. Hardware" autocomplete="off"></div>' +
    '<div class="nb-field"><label for="nb-fix">What fixed it</label><textarea id="nb-fix" rows="4" data-nb-t="fix" data-id="' + E(r.id) + '" placeholder="Steps you took, so next time is quicker.">' + E(w.fix || "") + "</textarea></div>" +
    '<div class="nb-field"><label for="nb-notes">Private notes</label><textarea id="nb-notes" rows="3" data-nb-t="notes" data-id="' + E(r.id) + '" placeholder="Anything else worth remembering — follow-ups, device details, who helped.">' + E(w.notes || "") + "</textarea></div>" +
    '<div class="nb-foot"><span class="nb-saved" id="nb-saved">' + (w.updatedAt ? "Saved " + E(nbWhen(w.updatedAt)) : "Saves as you type") + '</span><span class="grow"></span>' +
    (art ? '<button type="button" data-nb-open="' + E(art.id) + '">Open article →</button>' : '<button type="button" class="primary" data-nb-promote="' + E(r.id) + '">Turn into article →</button>') + "</div>";
}

function kbNo(a) { return a && a.kb ? "KB-" + String(a.kb).padStart(4, "0") : ""; }

// A title from the article's Problem (or first) line, or a ticket's issue:
// drop greetings and filler, then "Fix: …" for something broken, "How to
// …" for a request, otherwise the sentence itself. Simple rules, no AI.
function suggestTitle(text) {
  var src = String(text || "");
  var m = src.match(/^#+\s*problem\s*\n+([\s\S]*?)(\n#|$)/im);
  src = (m ? m[1] : src.replace(/^#+.*$/gm, "")).replace(/!\[[^\]]*\]\([^)]*\)/g, " ").trim();
  var first = (src.split(/(?<=[.!?])\s|\n/)[0] || "").trim();
  var t = first
    .replace(/^(hi|hello|hey|good (morning|afternoon))\b[^a-z0-9]*/i, "")
    .replace(/^(please|pls|kindly)\s+/i, "")
    .replace(/^(can|could|would) (you|someone|i|we)( please)?\s+/i, "")
    .replace(/^(help( me)?( with)?|i need( help with)?|we need|need( help with)?|i('m| am) having( an issue with| trouble with| issues with)?|having (an )?(issue|problem|trouble)s? with|issue with|problem with|is there a way to)\s+/i, "")
    .replace(/^(my|our|the)\s+/i, "")
    .replace(/\b(my|our)\s+/gi, "")
    .replace(/^access to\b/i, "get access to")
    .replace(/\b(again|anymore|please|asap|thank(s| you))\b/gi, "")
    .replace(/\s{2,}/g, " ").replace(/[\s.!?,;:]+$/, "").trim();
  if (!t) return "";
  var broken = /\b(can'?t|cannot|won'?t|isn'?t|is not|not working|doesn'?t|does not|error|fail(s|ed|ing)?|broken|stuck|keeps|freez(e|es|ing)|crash(es|ing)?|slow|offline|down|jammed|no (sound|internet|signal))\b/i.test(t);
  var how = /^(get access|set ?up|install|add|create|reset|change|connect|request|get|configure|enable|disable|remove|update|map|share|access|order)\b/i.test(t);
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length > 80) t = t.slice(0, 80).replace(/\s+\S*$/, "") + "…";
  return broken ? "Fix: " + t : how ? "How to " + t.charAt(0).toLowerCase() + t.slice(1) : t;
}

// Images (![caption](kb-img:ID)) load with your sign-in, then show inline.
var nbImgs = {};
function nbImgUrl(id) {
  if (!nbImgs[id]) {
    nbImgs[id] = fetch("/api/it-notebook/images/" + encodeURIComponent(id), { headers: { Authorization: "Bearer " + token() } })
      .then(function (r) { if (!r.ok) throw new Error("missing"); return r.blob(); })
      .then(function (b) { return URL.createObjectURL(b); });
    nbImgs[id].catch(function () { delete nbImgs[id]; });
  }
  return nbImgs[id];
}
function nbHydrate(root) {
  var imgs = (root || document).querySelectorAll("img[data-kbimg]:not([src])");
  return Promise.all(Array.prototype.map.call(imgs, function (img) {
    return nbImgUrl(img.dataset.kbimg).then(function (u) { img.src = u; return new Promise(function (ok) { if (img.complete) ok(); else { img.onload = ok; img.onerror = ok; } }); },
      function () { img.alt = "Image not found"; });
  }));
}
function nbImageIds(body) { var out = [], re = /kb-img:([a-z0-9]+)/g, m; while ((m = re.exec(String(body || "")))) out.push(m[1]); return out; }
function nbUpload(files, ta) {
  var list = Array.prototype.filter.call(files || [], function (f) { return /^image\//.test(f.type); });
  if (!list.length) return;
  var saved = $("#nb-saved"); if (saved) saved.textContent = "Uploading " + (list.length === 1 ? "image" : list.length + " images") + "…";
  list.reduce(function (p, f) {
    return p.then(function () {
      return fetch("/api/it-notebook/images", { method: "POST", headers: { Authorization: "Bearer " + token(), "Content-Type": f.type }, body: f })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "Upload failed"); return d; }); })
        .then(function (d) {
          var cap = (f.name && !/^image\.(png|jpe?g)$/i.test(f.name) ? f.name.replace(/\.[a-z0-9]+$/i, "") : "Screenshot").replace(/[\[\]()]/g, "");
          var tag = "![" + cap + "](kb-img:" + d.id + ")";
          var pos = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
          var before = ta.value.slice(0, pos), after = ta.value.slice(pos);
          ta.value = before + (before && !/\n$/.test(before) ? "\n" : "") + tag + "\n" + after;
          ta.selectionStart = ta.selectionEnd = (before + tag).length + 2;
          nbSave("a", ta.dataset.id, "body", ta.value);
        });
    });
  }, Promise.resolve()).then(function () { drawNbThumbs(ta.dataset.id); }, function (err) { toast(err.message, true); var s2 = $("#nb-saved"); if (s2) s2.textContent = "Upload failed"; });
}
function drawNbThumbs(id) {
  var a = nbArticle(id), box = $("#nb-thumbs");
  if (!a || !box) return;
  var ids = nbImageIds(a.body);
  box.innerHTML = ids.map(function (x) { return '<img data-kbimg="' + E(x) + '" alt="Image in this article" title="Click to open">'; }).join("");
  nbHydrate(box);
}
// Download as PDF: a clean print page (choose "Save as PDF" in the dialog).
function nbPrint(a) {
  var box = $("#nbPrint");
  if (!box) { box = document.createElement("div"); box.id = "nbPrint"; document.body.appendChild(box); }
  var when = new Date(a.updatedAt || Date.now()).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  box.innerHTML = '<div class="pk">' + E(kbNo(a)) + " · SOI AVIATION IT</div><h1>" + E(a.title) + '</h1><div class="pm">' +
    E([a.category, "Updated " + when].filter(Boolean).join(" · ")) + "</div>" + nbFormat(a.body) +
    '<div class="pf">' + E(kbNo(a) + " — " + a.title) + " · Printed " + E(new Date().toLocaleDateString()) + " · Internal use</div>";
  var oldTitle = document.title;
  toast("Getting it ready…");
  nbHydrate(box).then(function () {
    document.title = (kbNo(a) + " " + a.title).replace(/[\\/:*?"<>|]+/g, " ").trim();
    document.body.classList.add("nb-printing");
    var done = function () { document.body.classList.remove("nb-printing"); document.title = oldTitle; window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
    setTimeout(done, 1000);
  });
}

function renderKb() {
  var q = nb.q.trim().toLowerCase();
  var list = nb.data.articles.filter(function (a) { return !q || (kbNo(a) + " " + a.title + " " + a.category + " " + a.body).toLowerCase().indexOf(q.replace(/^kb\s*-?\s*(\d+)$/, function (m, n) { return "kb-" + String(n).padStart(4, "0"); })) !== -1; });
  if (!nb.sel.kb || !nbArticle(nb.sel.kb)) nb.sel.kb = list.length ? list[0].id : "";
  var items = list.length ? list.map(function (a) {
    return '<button type="button" class="nb-item' + (a.id === nb.sel.kb ? " active" : "") + '" data-nb-article="' + E(a.id) + '">' +
      '<span class="nb-kb">' + E(kbNo(a)) + "</span><b>" + E(a.title) + "</b>" + '<span class="nb-snip">' + E(a.body.replace(/!\[[^\]]*\]\([^)]*\)/g, "[image]").replace(/^#+\s*/gm, "").slice(0, 160) || "Empty") + "</span>" +
      '<span class="nb-meta">' + (a.category ? '<span class="nb-chip">' + E(a.category) + "</span>" : "") + "Updated " + E(nbWhen(a.updatedAt)) + "</span></button>";
  }).join("") : '<div class="nb-empty">' + (nb.data.articles.length ? "No articles match." : "No articles yet. Start one with + New article, or turn a resolved ticket into one.") + "</div>";
  var head = '<div class="nb-list-head"><input type="text" id="nbFind" placeholder="Find an article or KB number" value="' + E(nb.q) + '" aria-label="Find an article" autocomplete="off"></div>';
  return '<div class="nb-grid"><div class="nb-list">' + head + items + '</div><div class="nb-pane">' + renderKbPane(nbArticle(nb.sel.kb)) + "</div></div>";
}
// Light formatting for reading: "# " headings, "- " bullets, `code`.
function nbFormat(text) {
  var out = "", bullets = [];
  var inline = function (s) { return E(s).replace(/`([^`]+)`/g, "<code>$1</code>"); };
  var flush = function () { if (bullets.length) { out += "<ul>" + bullets.map(function (b) { return "<li>" + inline(b) + "</li>"; }).join("") + "</ul>"; bullets = []; } };
  String(text || "").split(/\n{2,}/).forEach(function (block) {
    block.split("\n").forEach(function (line, i, lines) {
      var im = line.trim().match(/^!\[([^\]]*)\]\(kb-img:([a-z0-9]+)\)$/);
      if (im) { flush(); out += '<figure><img data-kbimg="' + E(im[2]) + '" alt="' + E(im[1] || "Image") + '">' + (im[1] && im[1] !== "Screenshot" ? "<figcaption>" + E(im[1]) + "</figcaption>" : "") + "</figure>"; return; }
      if (/^#+\s/.test(line)) { flush(); out += "<h4>" + inline(line.replace(/^#+\s*/, "")) + "</h4>"; }
      else if (/^\s*[-*]\s/.test(line)) bullets.push(line.replace(/^\s*[-*]\s/, ""));
      else if (line.trim()) { flush(); out += "<p>" + inline(line) + "</p>"; }
    });
    flush();
  });
  return out || '<p class="dim">Nothing written yet.</p>';
}
function renderKbPane(a) {
  if (!a) return '<div class="nb-empty">Pick an article on the left, or start a new one.</div>';
  var editing = nb.edit[a.id] || !a.body;
  var from = a.fromRequest && nbTicket(a.fromRequest);
  var top = '<div class="nb-foot" style="margin:0 0 14px;"><div class="seg">' +
    '<button type="button" data-nb-mode="read" class="' + (editing ? "" : "active") + '">Read</button>' +
    '<button type="button" data-nb-mode="edit" class="' + (editing ? "active" : "") + '">Edit</button></div><span class="grow"></span>' +
    '<span class="nb-saved" id="nb-saved">Updated ' + E(nbWhen(a.updatedAt)) + "</span>" +
    '<button type="button" data-nb-pdf="' + E(a.id) + '" title="Opens a print-ready page — choose Save as PDF, or print it">Download PDF</button></div>';
  setTimeout(function () { nbHydrate($("#view")); drawNbThumbs(a.id); }, 0);
  if (!editing) {
    return top + '<div class="nb-kb">' + E(kbNo(a)) + "</div><h3>" + E(a.title) + '</h3><div class="nb-sub">' + E([a.category, from ? "from " + itrPerson(from) + "'s ticket" : ""].filter(Boolean).join(" · ")) + "</div>" +
      '<div class="nb-read">' + nbFormat(a.body) + "</div>";
  }
  return top + '<div class="nb-kb">' + E(kbNo(a)) + "</div>" +
    '<input class="nb-title" data-nb-a="title" data-id="' + E(a.id) + '" value="' + E(a.title) + '" placeholder="Title" aria-label="Title">' +
    '<div class="nb-tools"><button type="button" data-nb-suggest="' + E(a.id) + '" title="Writes a title from the Problem section">✨ Suggest title</button></div>' +
    '<div class="nb-field" style="max-width:280px;margin-top:8px;"><label for="nb-acat">Category</label><input id="nb-acat" list="nbCats" data-nb-a="category" data-id="' + E(a.id) + '" value="' + E(a.category) + '" placeholder="e.g. Network & VPN" autocomplete="off"></div>' +
    '<div class="nb-field"><label for="nb-body">Article</label><textarea id="nb-body" rows="14" data-nb-a="body" data-id="' + E(a.id) + '" placeholder="# Problem&#10;What people see.&#10;&#10;# Fix&#10;- Step one&#10;- Step two">' + E(a.body) + "</textarea>" +
    '<div class="nb-tools" style="margin-top:8px;"><input type="file" id="nbImgFile" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>' +
      '<button type="button" data-nb-addimg>🖼 Add image</button><span class="small-note">…or paste a screenshot (⌘V) or drag a picture into the article.</span></div>' +
    '<div class="nb-thumbs" id="nb-thumbs"></div>' +
    '<span class="small-note">Tip: start a line with # for a heading, - for a bullet, and wrap commands in `backticks`.</span></div>' +
    '<div class="nb-foot"><span class="grow"></span><button type="button" class="text-button" data-nb-delete="' + E(a.id) + '">Delete article</button></div>';
}

// Saving: debounced per field, without re-rendering while you type.
function nbSave(kind, id, key, value) {
  var tk = kind + id + key;
  // Keep the local copy current, so switching views shows what you typed.
  if (kind === "t") { var lr = nbTicket(id); if (lr) { lr.writeup = lr.writeup || {}; lr.writeup[key] = value; } }
  else { var la = nbArticle(id); if (la) la[key] = value; }
  var saved = $("#nb-saved");
  if (saved) saved.textContent = "Saving…";
  clearTimeout(nb.timers[tk]);
  nb.timers[tk] = setTimeout(function () {
    var change = {}; change[key] = value;
    var req = kind === "t"
      ? api("/api/it-notebook/tickets/" + encodeURIComponent(id), { method: "PUT", body: JSON.stringify(change) })
      : api("/api/it-notebook/articles/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(change) });
    req.then(function (res) {
      if (kind === "t") { var r = nbTicket(id); if (r) r.writeup = res; }
      else { var a = nbArticle(id); if (a) Object.assign(a, res); }
      var s = $("#nb-saved"); if (s) s.textContent = "Saved";
    }, function (err) { toast(err.message, true); var s = $("#nb-saved"); if (s) s.textContent = "Not saved"; });
  }, 700);
}
function nbNewArticle(fields) {
  return api("/api/it-notebook/articles", { method: "POST", body: JSON.stringify(fields) }).then(function (a) {
    nb.data.articles.unshift(a);
    nb.view = "kb"; nb.sel.kb = a.id; nb.edit[a.id] = true; nb.q = "";
    render();
    var t = $(".nb-title"); if (t) { t.focus(); t.select(); }
    return a;
  }, function (err) { toast(err.message, true); });
}
document.addEventListener("input", function (e) {
  var t = e.target;
  if (t.id === "nbFind") {
    nb.q = t.value; var pos = t.selectionStart; render();
    var f = $("#nbFind"); if (f) { f.focus(); try { f.setSelectionRange(pos, pos); } catch (x) {} }
    return;
  }
  if (t.dataset && t.dataset.nbT) nbSave("t", t.dataset.id, t.dataset.nbT, t.value);
  else if (t.dataset && t.dataset.nbA) nbSave("a", t.dataset.id, t.dataset.nbA, t.value);
});
document.addEventListener("click", function (e) {
  var img = e.target.closest && e.target.closest("img[data-kbimg]");
  if (img && img.src) { window.open(img.src, "_blank", "noopener"); return; }
  var t = e.target.closest && e.target.closest("[data-nb-view],[data-nb-show],[data-nb-ticket],[data-nb-article],[data-nb-mode],[data-nb-new],[data-nb-promote],[data-nb-open],[data-nb-delete],[data-nb-pdf],[data-nb-suggest],[data-nb-addimg]");
  if (!t) return;
  var ds = t.dataset;
  if (ds.nbPdf) { var pa = nbArticle(ds.nbPdf); if (pa) nbPrint(pa); return; }
  if ("nbAddimg" in ds) { var fi = $("#nbImgFile"); if (fi) fi.click(); return; }
  if (ds.nbSuggest) {
    var sa = nbArticle(ds.nbSuggest), ti = $(".nb-title");
    var sug = sa && (suggestTitle(sa.body) || (sa.fromRequest && nbTicket(sa.fromRequest) ? suggestTitle(nbTicket(sa.fromRequest).issue) : ""));
    if (!sug) { toast("Write a Problem section first, then try again.", true); return; }
    if (ti) { ti.value = sug; ti.focus(); }
    nbSave("a", sa.id, "title", sug);
    return;
  }
  if (ds.nbView) { nb.view = ds.nbView; render(); }
  else if (ds.nbShow) { nb.show = ds.nbShow; render(); }
  else if (ds.nbTicket) { nb.sel.tickets = ds.nbTicket; render(); }
  else if (ds.nbArticle) { nb.sel.kb = ds.nbArticle; render(); }
  else if (ds.nbMode) { nb.edit[nb.sel.kb] = ds.nbMode === "edit"; render(); }
  else if ("nbNew" in ds) nbNewArticle({ title: "Untitled article", body: "" });
  else if (ds.nbOpen) { nb.view = "kb"; nb.sel.kb = ds.nbOpen; nb.q = ""; render(); }
  else if (ds.nbPromote) {
    var r = nbTicket(ds.nbPromote), w = (r && r.writeup) || {};
    if (!r) return;
    var first = suggestTitle(r.issue) || String(r.issue || "IT issue").split(/[.!?\n]/)[0].trim().slice(0, 100);
    var body = "# Problem\n" + (r.issue || "") + (w.fix ? "\n\n# Fix\n" + w.fix : "\n\n# Fix\n") + (w.notes ? "\n\n# Notes\n" + w.notes : "");
    nbNewArticle({ title: first, category: w.category || "", body: body, fromRequest: r.id }).then(function (a) {
      if (!a) return;
      api("/api/it-notebook/tickets/" + encodeURIComponent(r.id), { method: "PUT", body: JSON.stringify({ articleId: a.id }) })
        .then(function (res) { r.writeup = res; }).catch(function () {});
    });
  }
  else if (ds.nbDelete) {
    var a = nbArticle(ds.nbDelete);
    if (!a || !confirm("Delete “" + a.title + "”? This can't be undone.")) return;
    api("/api/it-notebook/articles/" + encodeURIComponent(a.id), { method: "DELETE" }).then(function () {
      nb.data.articles = nb.data.articles.filter(function (x) { return x.id !== a.id; });
      nb.sel.kb = ""; render(); toast("Article deleted.");
    }, function (err) { toast(err.message, true); });
  }
});

// Images into an article: file picker, paste a screenshot, or drag one in.
document.addEventListener("change", function (e) {
  if (e.target.id !== "nbImgFile") return;
  var ta = $("#nb-body");
  if (ta) nbUpload(e.target.files, ta);
  e.target.value = "";
});
document.addEventListener("paste", function (e) {
  var ta = e.target;
  if (!ta || ta.id !== "nb-body" || !e.clipboardData) return;
  var files = Array.prototype.filter.call(e.clipboardData.files || [], function (f) { return /^image\//.test(f.type); });
  if (!files.length) return;
  e.preventDefault();
  nbUpload(files, ta);
});
document.addEventListener("dragover", function (e) { if (e.target.id === "nb-body") { e.preventDefault(); e.target.classList.add("drop"); } });
document.addEventListener("dragleave", function (e) { if (e.target.id === "nb-body") e.target.classList.remove("drop"); });
document.addEventListener("drop", function (e) {
  if (e.target.id !== "nb-body") return;
  e.preventDefault();
  e.target.classList.remove("drop");
  nbUpload(e.dataTransfer && e.dataTransfer.files, e.target);
});

"use strict";
// Chat with AOG: one Claude chat for the company (chat.js and the
// /api/chat routes on the server). It finds board files and documents,
// reads documents, and adds notes, documents and ILS results to a file —
// always as you, with your permissions. Your chats are kept; IT can open
// anyone's (read-only).
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

var ch = { list: null, user: "", error: "", open: null, draft: "", sending: false, loading: false };

function chLoad(user) {
  ch.loading = true;
  var q = user ? "?user=" + encodeURIComponent(user) : "";
  return api("/api/chat" + q).then(function (d) { ch.list = d; ch.user = d.user; ch.error = ""; }, function (err) { ch.error = err.message; })
    .then(function () { ch.loading = false; requestRender(); });
}
function chOpen(id) {
  var q = ch.list && !ch.list.mine ? "?user=" + encodeURIComponent(ch.list.user) : "";
  api("/api/chat/" + encodeURIComponent(id) + q).then(function (c) { ch.open = c; render(); chScroll(); }, function (err) { toast(err.message, true); });
}
function chScroll() { var m = $("#ch-msgs"); if (m) m.scrollTop = m.scrollHeight; }

// Plain text with paragraphs, bullet and numbered lines, and **bold**.
function chFormat(text) {
  var inline = function (s) { return E(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>"); };
  var ITEM = /^\s*([-*•]|\d+[.)])\s+/;
  return String(text || "").split(/\n{2,}/).map(function (block) {
    // Runs of list lines become a list; other lines a paragraph.
    var html = "", para = [], items = [], ol = false;
    var flushPara = function () { if (para.length) { html += "<p>" + para.map(inline).join("<br>") + "</p>"; para = []; } };
    var flushList = function () { if (items.length) { html += (ol ? "<ol>" : "<ul>") + items.map(function (l) { return "<li>" + inline(l) + "</li>"; }).join("") + (ol ? "</ol>" : "</ul>"); items = []; } };
    block.split("\n").forEach(function (l) {
      if (ITEM.test(l)) { flushPara(); if (!items.length) ol = /^\s*\d/.test(l); items.push(l.replace(ITEM, "")); }
      else { flushList(); para.push(l); }
    });
    flushPara(); flushList();
    return html;
  }).join("");
}

function renderDeptChat() {
  setBreadcrumb(["Company", "Chat with AOG"]);
  if (!ch.list && !ch.loading && !ch.error) setTimeout(function () { chLoad(""); }, 0);
  var d = ch.list;
  var head = '<div class="intro"><div><div class="eyebrow">Company</div><h1>Chat with AOG</h1>' +
    "<p>Ask Claude to find a quote file or a document, read a document, or add a note, a document or ILS results to a file. It works with your permissions, never more, and every change it makes is recorded on the file as made through Chat with AOG for you. Your chats are kept; IT can read them.</p></div></div>";
  if (ch.error && !d) return head + '<div class="banner">' + E(ch.error) + "</div>";
  if (!d) return head + '<div class="empty">Loading…</div>';
  var who = d.audit ? '<div class="nb-field" style="margin:0 0 10px;"><label for="chWho">Whose chats (IT)</label><select id="chWho">' +
    d.logins.map(function (u) { return '<option value="' + E(u) + '"' + (sameUser(u, d.user) ? " selected" : "") + ">" + E(u) + (sameUser(u, me.username) ? " (you)" : "") + "</option>"; }).join("") + "</select></div>" : "";
  var list = (d.mine ? '<button type="button" class="primary" data-ch-new style="width:100%;margin-bottom:10px;">+ New chat</button>' : "") +
    (d.chats.length ? '<ul class="ch-list">' + d.chats.map(function (c) {
      return '<li><button type="button" class="' + (ch.open && ch.open.id === c.id ? "active" : "") + '" data-ch-open="' + E(c.id) + '"><span>' + E(c.title) + '</span><span class="small-note">' + E(new Date(c.updatedAt || c.at).toLocaleDateString()) + "</span></button></li>";
    }).join("") + "</ul>" : '<p class="small-note">' + (d.mine ? "No chats yet." : "No chats.") + "</p>");
  return head + '<div class="ch-wrap"><div class="ch-side card">' + who + list + "</div>" + '<div class="ch-main card">' + chConversation(d) + "</div></div>";
}

function chConversation(d) {
  var msgs = ch.open ? ch.open.messages || [] : [];
  var body = msgs.length ? msgs.map(function (m) {
    if (m.role === "user") return '<div class="ch-msg ch-you"><div class="ch-who">' + E(ch.open && !d.mine ? d.user : "You") + "</div>" + chFormat(m.text) + "</div>";
    return '<div class="ch-msg ch-ai"><div class="ch-who">Chat with AOG</div>' + chFormat(m.text) +
      ((m.actions || []).length ? '<ul class="ch-acts">' + m.actions.map(function (a) { return "<li>✓ " + E(a) + "</li>"; }).join("") + "</ul>" : "") +
      (m.truncated ? '<p class="small-note">The answer was cut short.</p>' : "") + "</div>";
  }).join("") : '<div class="ch-empty"><p><b>Try:</b></p><ul>' +
    "<li>Find the file for quote Q-2201</li><li>Find the 8130-3 for P/N EX-1234-5 in Documents and attach it to that file</li>" +
    "<li>Add a note to RFQ 4471: customer wants delivery to Ramstein</li><li>Here are the ILS results for EX-1234-5: … add them to the file</li></ul></div>";
  if (ch.sending) body += '<div class="ch-msg ch-ai"><div class="ch-who">Chat with AOG</div><p class="small-note">Working… it may look a few things up first.</p></div>';
  var compose = d.mine ? '<div class="ch-compose"><textarea id="chText" rows="3" placeholder="Ask about a quote, a file or a document. Enter sends; Shift+Enter for a new line."' + (ch.sending ? " disabled" : "") + ">" + E(ch.draft) + "</textarea>" +
    '<div class="nb-foot"><button type="button" class="primary" data-ch-send' + (ch.sending ? " disabled" : "") + ">Send</button>" +
    '<span class="small-note">' + (d.ils ? "" : "ILS isn't connected yet: search ilsmart.com and paste the results here to add them to a file. ") +
    "Check what it says before relying on it. It never makes up certificate numbers, 8130-3s, NSNs or prices.</span></div></div>"
    : '<p class="small-note" style="margin:10px 0 0;">Read-only: ' + E(d.user) + "'s chats.</p>";
  return '<div class="ch-msgs" id="ch-msgs">' + body + "</div>" + compose;
}

function chSend() {
  var text = String(ch.draft || "").trim();
  if (!text || ch.sending) return;
  ch.sending = true;
  var chatId = ch.open ? ch.open.id : "";
  // Show the question straight away.
  ch.open = ch.open || { id: "", messages: [] };
  ch.open.messages = (ch.open.messages || []).concat([{ role: "user", text: text, at: Date.now() }]);
  ch.draft = "";
  render(); chScroll();
  api("/api/chat", { method: "POST", body: JSON.stringify({ chatId: chatId, text: text }) }).then(function (c) {
    ch.open = c; ch.sending = false;
    return chLoad("").then(function () {
      if (page !== "chat") return;
      render(); chScroll();
      var t = $("#chText"); if (t) t.focus();
    });
  }, function (err) {
    ch.sending = false;
    ch.open.messages.pop();
    if (!ch.open.messages.length && !chatId) ch.open = null;
    ch.draft = text;
    toast(err.message, true);
    render();
  });
}

document.addEventListener("input", function (e) {
  if (e.target.id === "chText") ch.draft = e.target.value;
});
document.addEventListener("keydown", function (e) {
  if (e.target.id === "chText" && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ch.draft = e.target.value; chSend(); }
});
document.addEventListener("change", function (e) {
  if (e.target.id === "chWho") { ch.open = null; chLoad(sameUser(e.target.value, me.username) ? "" : e.target.value); }
});
document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("[data-ch-new],[data-ch-open],[data-ch-send]");
  if (!t || !$("#view").contains(t)) return;
  if ("chNew" in t.dataset) { ch.open = null; ch.draft = ""; render(); var x = $("#chText"); if (x) x.focus(); return; }
  if (t.dataset.chOpen) { chOpen(t.dataset.chOpen); return; }
  if ("chSend" in t.dataset) { var ta = $("#chText"); if (ta) ch.draft = ta.value; chSend(); }
});

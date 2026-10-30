"use strict";
// Calendar: personal, HR global calendar and who's in office.
// The dashboard's scripts share one global scope and load in the order
// index.html lists them; functions called while a file loads must be
// defined in that file or an earlier one.

// ---------- Calendar ----------
// Tabs: "Personal calendar" (your own Outlook, read-only) for everyone, as a
// List or a Month grid; and for Leadership logins, "HR global calendar"
// (the published Outlook link from /admin.html) and "Who's in office"
// (status per person per weekday). The server checks Leadership too.
var calDays = 14;
var calTab = "personal";
var calMode = "list";            // list | month
var calMonth = today.slice(0, 7) + "-01";
var whoWeek = today;
var hrCal = null;                // { name, url } once loaded
function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function shiftDays(s, n) { var d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return ymd(d); }
function shiftMonths(s, n) { var d = new Date(s + "T00:00:00"); d.setDate(1); d.setMonth(d.getMonth() + n); return ymd(d); }

function renderCalendar() {
  if (!me.leadership) calTab = "personal";
  setBreadcrumb(["Tools", "Calendar", { personal: "Personal", hr: "HR global", whos: "Who's in office" }[calTab]]);
  var hrName = (hrCal && hrCal.name) || "HR global calendar";
  var tabList = [["personal", "Personal calendar"]].concat(me.leadership ? [["hr", hrName], ["whos", "Who's in office"]] : []);
  var tabs = tabList.length > 1 ? '<div class="tabs" role="tablist">' + tabList.map(function (t) {
    return '<button type="button" role="tab" class="tab ' + (calTab === t[0] ? "active" : "") + '" aria-selected="' + (calTab === t[0]) + '" data-cal-tab="' + t[0] + '">' + E(t[1]) + "</button>";
  }).join("") + "</div>" : "";
  var intro, body;
  if (calTab === "hr" && hrCal && !hrCal.hasFeed) {
    intro = introBlock("The HR calendar, published from Outlook.", "");
    body = '<div id="cal-hr" style="margin-top:18px;"><div class="empty">Loading…</div></div>';
    setTimeout(loadHrCalendar, 0);
  } else if (calTab === "whos") {
    intro = introBlock("Who's in, out or remote each weekday — from people's own Outlook (Out of office / Working elsewhere) and the HR calendar. Status only; no event details.",
      '<div class="co-wrap"><div class="eyebrow">Week</div><div class="cos"><button type="button" class="co" data-who-week="-7" aria-label="Previous week">‹</button>' +
      '<button type="button" class="co active" data-who-week="0">' + E(weekLabel(whoWeek)) + '</button><button type="button" class="co" data-who-week="7" aria-label="Next week">›</button></div></div>');
    body = '<div id="cal-who" style="margin-top:18px;"><div class="empty">Loading…</div></div>';
    setTimeout(loadWhosIn, 0);
  } else {
    var picker = '<div class="co-wrap"><div class="eyebrow">View</div><div class="cos">' +
      '<button type="button" class="co ' + (calMode === "list" ? "active" : "") + '" data-cal-mode="list">List</button>' +
      '<button type="button" class="co ' + (calMode === "month" ? "active" : "") + '" data-cal-mode="month">Month</button></div>' +
      (calMode === "list"
        ? '<div class="cos">' + [7, 14, 28].map(function (d) {
            return '<button type="button" class="co ' + (d === calDays ? "active" : "") + '" data-cal-days="' + d + '">' + (d === 7 ? "1 week" : d / 7 + " weeks") + "</button>";
          }).join("") + "</div>"
        : '<div class="cos"><button type="button" class="co" data-cal-month="-1" aria-label="Previous month">‹</button><button type="button" class="co active" data-cal-month="0">' +
          E(new Date(calMonth + "T00:00:00").toLocaleDateString(undefined, { month: "long", year: "numeric" })) + '</button><button type="button" class="co" data-cal-month="1" aria-label="Next month">›</button></div>') +
      "</div>";
    var isHr = calTab === "hr";
    intro = introBlock(isHr
      ? "The HR calendar, read from its Outlook feed. View only — updates every few minutes."
      : "Your Outlook calendar, straight from Microsoft 365. Read-only — nothing here changes your calendar.", picker);
    var title = isHr ? hrName : "Your calendar";
    body = '<div class="section-title"><div><h2>' + E(title) + '</h2><span class="small-note" id="cal-note">Loading…</span></div></div>' +
      (calMode === "month" ? '<div id="cal-month"></div>' : '<div id="cal-mine"></div>');
    setTimeout(calMode === "month" ? loadMonth : loadCalendar, 0);
  }
  if (me.leadership && !hrCal) setTimeout(loadHrName, 0);
  return intro + tabs + body;
}
function introBlock(text, right) {
  return '<div class="intro"><div><div class="eyebrow">Tools</div><h1>Calendar</h1><p>' + E(text) + "</p></div>" + right + "</div>";
}
function dayKey(e) { return e.allDay ? e.start : ymd(new Date(e.start)); }
function timeOf(iso) { return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
function calError(boxSel, err) {
  var box = $(boxSel);
  if (!box) return;
  var note = $("#cal-note");
  if (note) note.textContent = "";
  box.innerHTML = '<div class="banner">' + E(err.message) + "</div>";
}

// ---- Quiet auto-update ----
// Every few minutes the open calendar tab re-checks its data and redraws
// only that part of the page, and only if something changed. Paused while
// the browser tab is hidden; the embedded Outlook page is never reloaded.
var CAL_POLL_MS = 3 * 60 * 1000;
var calLast = {};
function calKey(kind) { return [kind, calTab, calDays, calMonth, whoWeek].join("|"); }
function unchanged(key, data, quiet) {
  var sig = JSON.stringify(data);
  var same = calLast[key] === sig;
  calLast[key] = sig;
  return quiet && same;
}
function quietCalendarRefresh() {
  if (page !== "calendar" || document.hidden || !me) return;
  if (calTab === "whos") loadWhosIn(true);
  else if (calTab === "hr" && hrCal && !hrCal.hasFeed) return;
  else if (calMode === "month") loadMonth(true);
  else loadCalendar(true);
}
setInterval(quietCalendarRefresh, CAL_POLL_MS);
document.addEventListener("visibilitychange", function () { if (!document.hidden) quietCalendarRefresh(); });

// HR calendar entries carry company / holiday tags from the server.
var CO_NAME = { SOI: "SOI", CAS: "CAS", RedSun: "Red Sun", NanoTech: "Nanotech", Global: "Global" };
var calColorsNow = null;
function evStyle(e) {
  if (!calColorsNow || calTab !== "hr") return { cls: "", style: "", tip: "" };
  var color = e.holiday ? (e.company ? calColorsNow[e.company] : calColorsNow.holiday) : e.company ? calColorsNow[e.company] : "";
  var tip = e.holiday ? "Holiday" + (e.company ? " · " + CO_NAME[e.company] : "") : e.company ? CO_NAME[e.company] : e.ambiguous ? "Couldn't tell which company — use full names in /admin.html" : "";
  return { cls: (color ? " co-ev" : "") + (e.holiday ? " holiday" : ""), style: color ? ' style="--co:' + E(color) + '"' : "", tip: tip };
}
function calLegend() {
  if (!calColorsNow || calTab !== "hr") return "";
  return '<div class="cal-legend">' + ["SOI", "CAS", "RedSun", "NanoTech", "Global"].map(function (k) {
    return '<span><i style="background:' + E(calColorsNow[k]) + '"></i>' + E(CO_NAME[k]) + "</span>";
  }).join("") + '<span><i class="hol" style="--co:' + E(calColorsNow.holiday) + '"></i>Holiday / closed</span></div>';
}

// ---- Personal: list ----
// Personal and HR tabs share the List / Month views; only the source differs.
function calSource() { return calTab === "hr" ? "/api/calendar/hr" : "/api/calendar/me"; }
function loadCalendar(quiet) {
  var key = calKey("list");
  api(calSource() + "?start=" + today + "&days=" + calDays).then(function (data) {
    var box = $("#cal-mine");
    if (!box || unchanged(key, data, quiet)) return;
    calColorsNow = data.colors || null;
    // An event shows on every day it covers from today on — so something
    // that started earlier and is still going (e.g. a week of OOO) is listed.
    var lastShown = shiftDays(today, calDays - 1);
    var byDay = {};
    var events = data.events.filter(function (e) {
      var first = dayKey(e);
      var last = e.allDay ? shiftDays(e.end, -1) : ymd(new Date(new Date(e.end).getTime() - 1));
      if (last < first) last = first;
      var shown = false;
      for (var d = first < today ? today : first; d <= last && d <= lastShown; d = shiftDays(d, 1)) {
        (byDay[d] = byDay[d] || []).push(e);
        shown = true;
      }
      return shown;
    });
    $("#cal-note").textContent = events.length + " event" + (events.length === 1 ? "" : "s") + " in the next " + (calDays === 7 ? "week" : calDays / 7 + " weeks") + " · times in your time zone";
    if (!events.length) { box.innerHTML = '<div class="card empty">Nothing on ' + (calTab === "hr" ? "the HR calendar" : "your calendar") + ".</div>"; return; }
    box.innerHTML = calLegend() + Object.keys(byDay).sort().map(function (day) {
      var label = new Date(day + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
      return '<div class="card" style="margin-bottom:14px;"><div class="card-label" style="margin-bottom:10px;">' + E(day === today ? "Today · " + label : label) + "</div>" +
        byDay[day].map(function (e) {
          var lastDay = e.allDay ? shiftDays(e.end, -1) : "";
          var when = e.allDay
            ? (lastDay > e.start ? "All day · through " + new Date(lastDay + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "All day")
            : timeOf(e.start) + " – " + timeOf(e.end);
          var link = safeLink(e.webLink);
          var join = safeLink(e.joinUrl);
          var st = evStyle(e);
          return '<div class="cal-event' + (e.allDay ? " all-day" : "") + st.cls + '"' + st.style + (st.tip ? ' title="' + E(st.tip) + '"' : "") + '><span class="cal-time">' + E(when) + "</span>" +
            "<strong>" + (e.holiday ? "★ " : "") + E(e.subject) + "</strong>" + (st.tip && !e.holiday && e.company ? ' <span class="co-tag">' + E(CO_NAME[e.company]) + "</span>" : "") +
            (e.location ? ' <span class="small-note">· ' + E(e.location) + "</span>" : "") +
            (e.organizer ? ' <span class="small-note">· ' + E(e.organizer) + "</span>" : "") +
            '<span class="cal-links">' + (join ? '<a href="' + E(join) + '" target="_blank" rel="noopener noreferrer">Join ↗</a>' : "") +
            (link ? '<a href="' + E(link) + '" target="_blank" rel="noopener noreferrer">Open in Outlook ↗</a>' : "") + "</span></div>";
        }).join("") + "</div>";
    }).join("");
  }).catch(function (err) { if (!quiet) calError("#cal-mine", err); });
}

// ---- Personal: month grid (weeks start on Sunday) ----
function loadMonth(quiet) {
  var key = calKey("month");
  var first = new Date(calMonth + "T00:00:00");
  var gridStart = shiftDays(calMonth, -first.getDay());
  var month = calMonth.slice(0, 7);
  api(calSource() + "?start=" + gridStart + "&days=42").then(function (data) {
    var box = $("#cal-month");
    if (!box || unchanged(key, data, quiet)) return;
    calColorsNow = data.colors || null;
    var byDay = {};
    data.events.forEach(function (e) {
      // An all-day event can span several days; show it on each.
      if (e.allDay) {
        for (var d = e.start; d < e.end; d = shiftDays(d, 1)) (byDay[d] = byDay[d] || []).push(e);
      } else (byDay[dayKey(e)] = byDay[dayKey(e)] || []).push(e);
    });
    var inMonth = data.events.filter(function (e) { return dayKey(e).slice(0, 7) === month; }).length;
    $("#cal-note").textContent = inMonth + " event" + (inMonth === 1 ? "" : "s") + " this month · times in your time zone";
    var head = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(function (d) { return '<div class="mg-dow">' + d + "</div>"; }).join("");
    var cells = "";
    for (var i = 0; i < 42; i++) {
      var day = shiftDays(gridStart, i);
      var evs = byDay[day] || [];
      // First three show; the rest are there but hidden until "+N more".
      var shown = evs.map(function (e, n) {
        var link = safeLink(e.webLink);
        var label = (e.allDay ? "" : timeOf(e.start) + " ") + e.subject;
        var st = evStyle(e);
        var inner = '<span class="mg-ev' + (e.allDay ? " all-day" : "") + st.cls + (n >= 3 ? " mg-extra" : "") + '"' + st.style + ' title="' + E(label + (st.tip ? " — " + st.tip : "")) + '">' + (e.holiday ? "★ " : "") + E(label) + "</span>";
        return link ? '<a href="' + E(link) + '" target="_blank" rel="noopener noreferrer"' + (n >= 3 ? ' class="mg-extra"' : "") + ">" + inner + "</a>" : inner;
      }).join("");
      var more = evs.length > 3 ? '<button type="button" class="mg-more" data-mg-more="' + (evs.length - 3) + '" aria-expanded="false">+' + (evs.length - 3) + " more</button>" : "";
      var hol = calTab === "hr" && evs.some(function (e) { return e.holiday; });
      cells += '<div class="mg-cell' + (day.slice(0, 7) !== month ? " out" : "") + (day === today ? " today" : "") + (hol ? " holiday-day" : "") + '"><span class="mg-num">' + Number(day.slice(8)) + "</span>" + shown + more + "</div>";
    }
    box.innerHTML = calLegend() + '<div class="month-grid">' + head + cells + "</div>";
  }).catch(function (err) { if (!quiet) calError("#cal-month", err); });
}

document.addEventListener("click", function (e) {
  var b = e.target.closest && e.target.closest("[data-mg-more]");
  if (!b) return;
  var cell = b.closest(".mg-cell"), open = !cell.classList.contains("expanded");
  cell.classList.toggle("expanded", open);
  b.setAttribute("aria-expanded", String(open));
  b.textContent = open ? "Show less" : "+" + b.dataset.mgMore + " more";
});

// ---- HR global calendar (Leadership) ----
function loadHrName() {
  return api("/api/calendar/shared").then(function (cal) {
    var changed = !hrCal || hrCal.name !== cal.name || hrCal.hasFeed !== cal.hasFeed;
    hrCal = cal;
    if (changed && page === "calendar") requestRender();
    return cal;
  });
}
function loadHrCalendar() {
  (hrCal ? Promise.resolve(hrCal) : loadHrName()).then(function (cal) {
    var box = $("#cal-hr");
    if (!box) return;
    var url = safeLink(cal.url);
    box.innerHTML = url
      ? '<iframe src="' + E(url) + '" title="' + E(cal.name || "HR global calendar") + '" style="width:100%;height:76vh;border:1px solid var(--line);border-radius:12px;background:#fff;"></iframe>'
      : '<div class="banner">No HR calendar is set yet. An admin can add its Outlook "Publish to web" <b>ICS</b> link under <b>HR global calendar</b> in /admin.html.</div>';
  }).catch(function (err) { calError("#cal-hr", err); });
}

// ---- Who's in office (Leadership) ----
function weekLabel(d) {
  var mon = shiftDays(d, -((new Date(d + "T00:00:00").getDay() + 6) % 7));
  var fri = shiftDays(mon, 4);
  var f = function (s) { return new Date(s + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
  return f(mon) + " – " + f(fri);
}
// At a glance: one day (today, or pick a weekday) as groups of people —
// In the office, Remote, Part of the day, Out — above the full week table.
var whoDay = "", whoData = null;
function whoGlance(data) {
  if (whoDay && data.days.indexOf(whoDay) === -1) whoDay = "";
  var day = whoDay || (data.days.indexOf(today) !== -1 ? today : data.days[0]);
  var groups = { in: [], remote: [], part: [], out: [], unknown: [] };
  data.people.forEach(function (p) {
    var st = p.days[day] || {};
    if (p.error) groups.unknown.push({ p: p, note: "Calendar not readable" });
    else if (st.status === "unknown") return; // HR-calendar-only person with no entry that day
    else if (st.partial) groups.part.push({ p: p, note: (st.status === "out" ? "Out " : "Remote ") + (st.note || "") });
    else (groups[st.status] || groups.in).push({ p: p, note: "" });
  });
  var initials = function (n) {
    var parts = String(n).replace(/[._@-]+/g, " ").trim().split(/\s+/);
    return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0] || "")[1] || "")).toUpperCase();
  };
  var colors = data.colors || {};
  var chip = function (x) {
    var co = x.p.company, bg = co && colors[co];
    var tip = x.p.username + (co ? " · " + (CO_NAME[co] || co) : x.p.ambiguous ? " · company unclear (same first name at two companies)" : "") + (x.note ? " — " + x.note : "");
    return '<span class="person-chip" title="' + E(tip) + '"><span class="av' + (bg ? " by-co" : "") + '" aria-hidden="true"' + (bg ? ' style="background:' + E(bg) + '"' : "") + ">" + E(initials(x.p.username)) + "</span>" +
      E(x.p.username) + (x.note ? " <small>" + E(x.note.trim()) + "</small>" : "") + "</span>";
  };
  var group = function (id, label, emptyText) {
    var list = groups[id];
    if (id === "unknown" && !list.length) return "";
    if (id === "part" && !list.length) return "";
    return '<div class="glance-group ' + id + '"><h3>' + E(label) + " <b>" + list.length + '</b></h3><div class="glance-people">' +
      (list.length ? list.map(chip).join("") : '<span class="glance-empty">' + E(emptyText) + "</span>") + "</div></div>";
  };
  var dayLabel = function (d) { return new Date(d + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric" }); };
  var legend = '<div class="cal-legend" style="margin:0 0 12px;">' + ["SOI", "CAS", "RedSun", "NanoTech", "Global"].map(function (k) {
    return colors[k] ? '<span><i style="background:' + E(colors[k]) + ';border-radius:50%"></i>' + E(CO_NAME[k]) + "</span>" : "";
  }).join("") + "</div>";
  return '<div class="glance"><div class="glance-head"><h2>' + (day === today ? "Today" : E(new Date(day + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }))) + "</h2>" +
    '<div class="seg">' + data.days.map(function (d) {
      return '<button type="button" data-who-day="' + d + '" class="' + (d === day ? "active" : "") + '">' + (d === today ? "Today" : E(dayLabel(d))) + "</button>";
    }).join("") + "</div></div>" +
    legend + '<div class="glance-groups">' + group("in", "In the office", "Nobody yet") + group("remote", "Remote", "Nobody") + group("part", "Part of the day", "") +
    group("out", "Out", "Nobody") + group("unknown", "Couldn't check", "") + "</div></div>";
}
function drawWhosIn() { if (whoData) drawWhosInData(whoData); }
function loadWhosIn(quiet) {
  var key = calKey("whos");
  api("/api/calendar/whos-in?week=" + whoWeek).then(function (data) {
    var box = $("#cal-who");
    if (!box || unchanged(key, data, quiet)) return;
    whoData = data;
    drawWhosInData(data);
  }).catch(function (err) { if (!quiet) calError("#cal-who", err); });
}
function drawWhosInData(data) {
    var box = $("#cal-who");
    if (!box) return;
    var counts = data.days.map(function (d) {
      return data.people.filter(function (p) { return !p.error && p.days[d].status === "in"; }).length;
    });
    var cell = function (s) {
      if (s.status === "unknown") return '<span class="dim" title="Not in the tracker yet, so only HR calendar entries are known">—</span>';
      if (s.status === "in") return '<span class="who in">In office</span>';
      var label = s.status === "out" ? "Out" : "Remote";
      return '<span class="who ' + s.status + '">' + label + (s.partial ? " · " + E(s.note) : "") + "</span>" +
        (s.sources && s.sources.indexOf("hr") !== -1 ? '<span class="co-note" style="padding:2px 0 0">HR calendar</span>' : "");
    };
    box.innerHTML = (data.hrError ? '<div class="banner">' + E(data.hrError) + "</div>" : "") +
      (!data.hrConnected && !data.hrError ? '<div class="banner">Only people\'s own Outlook is checked. To include the HR calendar, add its <b>ICS</b> link under <b>HR global calendar</b> in /admin.html.</div>' : "") +
      whoGlance(data) +
      '<div class="section-title"><div><h2>Everyone this week</h2></div></div>' +
      '<div class="table-wrap"><table class="plain narrow"><thead><tr><th>Person</th>' + data.days.map(function (d, i) {
        var label = new Date(d + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
        return '<th class="' + (d === today ? "who-today" : "") + '">' + E(label) + '<br><span style="text-transform:none;letter-spacing:0;font-weight:400;">' + counts[i] + " in office</span></th>";
      }).join("") + "</tr></thead><tbody>" +
      data.people.map(function (p) {
        var dot = p.company && data.colors && data.colors[p.company] ? '<span class="co-dot" style="background:' + E(data.colors[p.company]) + '" title="' + E(CO_NAME[p.company]) + '"></span>' : "";
        return "<tr><td>" + dot + "<strong>" + E(p.username) + "</strong>" +
          (p.company && p.company !== "SOI" ? ' <span class="co-tag">' + E(CO_NAME[p.company]) + "</span>" : "") +
          (p.hrOnly ? '<span class="co-note" style="padding:2px 0 0">From the HR calendar · no login yet</span>' : "") + (p.error ? '<span class="co-note" style="padding:2px 0 0;color:var(--danger)">' + E(p.error) + "</span>" : "") + "</td>" +
          data.days.map(function (d) { return '<td class="' + (d === today ? "who-today" : "") + '">' + (p.error && p.days[d].status === "in" ? '<span class="dim">—</span>' : cell(p.days[d])) + "</td>"; }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>" +
      '<p class="small-note" style="margin-top:12px;">In office = nothing marked Out of office or Working elsewhere on their Outlook, and no matching entry on the HR calendar. ' +
      "People named on the HR calendar without a login are listed too, from the HR calendar only (— on days it doesn't mention them). Days are in " + E(data.timeZone) + ". Updates every few minutes.</p>";
}
document.addEventListener("click", function (e) {
  var b = e.target.closest && e.target.closest("[data-who-day]");
  if (!b) return;
  whoDay = b.dataset.whoDay;
  drawWhosIn();
});

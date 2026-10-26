/* Attendance Sheet — dates are whole UTC days (no DST drift); pages are laid out in mm and printed with @page. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;

  var PAPER = { A4: [210, 297], Letter: [215.9, 279.4] };
  var MARGIN = 10, HEAD = 17, THEAD = 10, FOOT = 9; // mm
  var WD = {
    en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    ar: ["أحد", "إثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"]
  };
  var MONTHS = {
    en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    ar: ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]
  };
  var T = {
    en: { title: "Attendance", name: "Name", num: "#", total: "Total", page: "Page", of: "of", sign: "Signature", teacher: "Teacher", date: "Date",
      legend: "✓ present   ✗ absent   L late", session: "Session" },
    ar: { title: "كشف الحضور", name: "الاسم", num: "#", total: "المجموع", page: "صفحة", of: "من", sign: "التوقيع", teacher: "المعلم", date: "التاريخ",
      legend: "✓ حاضر   ✗ غائب   L متأخر", session: "حصة" }
  };
  var MARK = { "": "", P: "✓", A: "✗", L: "L" }, NEXT = { "": "P", P: "A", A: "L", L: "" };

  // ---------- pure logic (tested in S3_SELFTEST) ----------
  function utcDay(iso) { var p = String(iso || "").split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2] || 1) / 864e5; }
  function isoOf(day) { return new Date(day * 864e5).toISOString().slice(0, 10); }
  function dow(day) { return new Date(day * 864e5).getUTCDay(); }

  // -> [{key, day|null, n}] ; skip = array of weekday numbers (0 = Sunday)
  function columns(s) {
    var out = [], skip = s.skip || [], i, d;
    if (s.mode === "blank") {
      for (i = 1; i <= Math.min(100, Math.max(1, s.count | 0)); i++) out.push({ key: "c" + i, day: null, n: i });
      return out;
    }
    if (skip.length >= 7) return out;
    if (s.mode === "month") {
      var p = String(s.month || "").split("-"), y = +p[0], m = +p[1] - 1;
      if (!y || isNaN(m)) return out;
      var first = Date.UTC(y, m, 1) / 864e5, last = Date.UTC(y, m + 1, 1) / 864e5;
      for (d = first; d < last; d++) if (skip.indexOf(dow(d)) < 0) out.push({ key: isoOf(d), day: d, n: out.length + 1 });
      return out;
    }
    d = utcDay(s.start);
    if (!isFinite(d)) return out;
    var want = Math.min(100, Math.max(1, s.count | 0));
    while (out.length < want) { if (skip.indexOf(dow(d)) < 0) out.push({ key: isoOf(d), day: d, n: out.length + 1 }); d++; }
    return out;
  }

  function parseNames(text) {
    return String(text || "").split(/\r?\n/).map(function (l) {
      return l.split("\t")[0].replace(/^\s*\d+\s*[.)\-]\s+/, "").trim();
    }).filter(Boolean);
  }

  // Page geometry in mm. Columns that do not fit across one page continue on the next page (same names).
  function layout(s, nCols, nRows) {
    var P = PAPER[s.paper] || PAPER.A4, W = s.orient === "portrait" ? P[0] : P[1], H = s.orient === "portrait" ? P[1] : P[0];
    var innerW = W - 2 * MARGIN, innerH = H - 2 * MARGIN, rowH = +s.rowH || 8;
    var numW = s.num ? 8 : 0, totW = s.total && nCols ? 13 : 0;
    var nameW = Math.max(42, Math.min(70, innerW * 0.22));
    var minC = s.cell === "sign" ? 24 : 6.5, maxC = s.cell === "sign" ? 60 : 16;
    var room = innerW - numW - nameW - totW;
    var perPage = Math.max(1, Math.floor(room / minC));
    var chunks = nCols ? Math.ceil(nCols / perPage) : 1;
    var per = nCols ? Math.ceil(nCols / chunks) : 0;
    var colW = per ? Math.min(maxC, room / per) : 0;
    nameW = innerW - numW - totW - per * colW; // the name column takes what is left
    var rowsPer = Math.max(1, Math.floor((innerH - HEAD - THEAD - FOOT - 1) / rowH));
    var rowPages = Math.max(1, Math.ceil(nRows / rowsPer));
    return { W: W, H: H, innerW: innerW, rowH: rowH, numW: numW, nameW: nameW, totW: totW, colW: colW, per: per,
      chunks: chunks, rowsPer: rowsPer, rowPages: rowPages, pages: rowPages * chunks };
  }

  function csvCell(v) { v = String(v == null ? "" : v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function toCSV(names, cols, marks, withMarks) {
    var head = ["Name"].concat(cols.map(function (c) { return c.day == null ? "Session " + c.n : c.key; }));
    if (withMarks) head.push("Present", "Absent", "Late");
    var rows = [head];
    names.forEach(function (n) {
      var r = [n], cnt = { P: 0, A: 0, L: 0 };
      cols.forEach(function (c) { var m = withMarks ? marks[n + "\u0001" + c.key] || "" : ""; if (m) cnt[m]++; r.push(m); });
      if (withMarks) r.push(cnt.P, cnt.A, cnt.L);
      rows.push(r);
    });
    return rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n") + "\r\n";
  }

  // ---------- state ----------
  var today = new Date(), pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
  var DEF = { title: "", group: "", teacher: "", names: "", extra: 2, mode: "month",
    month: today.getFullYear() + "-" + pad2(today.getMonth() + 1), start: today.getFullYear() + "-" + pad2(today.getMonth() + 1) + "-" + pad2(today.getDate()),
    count: 12, skip: [0, 6], cell: "box", paper: "A4", orient: "landscape", rowH: "8", lang: "en", num: true, total: true, printMarks: false, view: "sheet" };
  var st = Object.assign({}, DEF, S3.store("att.settings") || {});
  var marks = S3.store("att.marks") || {};
  function persist() { S3.store("att.settings", st); }
  function saveMarks() { S3.store("att.marks", marks); }

  // ---------- page rendering ----------
  function periodText(cols, lang) {
    var M = MONTHS[lang];
    if (st.mode === "month") { var p = st.month.split("-"); return p[0] ? M[+p[1] - 1] + " " + p[0] : ""; }
    if (st.mode === "blank" || !cols.length) return "";
    function f(d) { var x = new Date(d * 864e5); return x.getUTCDate() + " " + M[x.getUTCMonth()].slice(0, lang === "en" ? 3 : 20) + " " + x.getUTCFullYear(); }
    return f(cols[0].day) + " – " + f(cols[cols.length - 1].day);
  }
  function colHead(c, lang, multiMonth) {
    if (c.day == null) return [st.cell === "sign" ? T[lang].session : "", String(c.n)];
    var x = new Date(c.day * 864e5);
    return [WD[lang][x.getUTCDay()], multiMonth ? x.getUTCDate() + "/" + (x.getUTCMonth() + 1) : String(x.getUTCDate())];
  }
  function buildPages(target) {
    var lang = st.lang, t = T[lang], names = parseNames(st.names), cols = columns(st);
    var rows = names.slice(); for (var e = 0; e < Math.min(60, Math.max(0, st.extra | 0)); e++) rows.push("");
    var L = layout(st, cols.length, rows.length);
    var multiMonth = cols.length && cols[0].day != null && new Date(cols[0].day * 864e5).getUTCMonth() !== new Date(cols[cols.length - 1].day * 864e5).getUTCMonth();
    var sub = [st.group, periodText(cols, lang), st.teacher ? t.teacher + ": " + st.teacher : ""].filter(Boolean).join("   ·   ");
    target.textContent = "";
    var pageNo = 0;
    for (var rp = 0; rp < L.rowPages; rp++) {
      for (var ch = 0; ch < L.chunks; ch++) {
        pageNo++;
        var part = cols.slice(ch * L.per, (ch + 1) * L.per), last = ch === L.chunks - 1;
        var page = S3.h("div", { "class": "as-page cell-" + st.cell, dir: lang === "ar" ? "rtl" : "ltr", lang: lang,
          style: "width:" + L.W + "mm;height:" + (L.H - 0.4) + "mm;padding:" + MARGIN + "mm" });
        var head = S3.h("div", { "class": "as-head", style: "height:" + HEAD + "mm" }, [
          S3.h("div", { "class": "as-hl" }, [S3.h("div", { "class": "as-ttl", text: st.title || t.title }), S3.h("div", { "class": "as-sub", text: sub })]),
          st.mode === "blank" ? S3.h("div", { "class": "as-dateline", text: t.date + ": ____________" }) : null
        ]);
        page.appendChild(head);
        var tbl = S3.h("table", { "class": "as-tbl", style: "width:" + (L.numW + L.nameW + part.length * L.colW + (last ? L.totW : 0)) + "mm" });
        var cg = S3.h("colgroup");
        if (L.numW) cg.appendChild(S3.h("col", { style: "width:" + L.numW + "mm" }));
        cg.appendChild(S3.h("col", { style: "width:" + L.nameW + "mm" }));
        part.forEach(function () { cg.appendChild(S3.h("col", { style: "width:" + L.colW + "mm" })); });
        if (last && L.totW) cg.appendChild(S3.h("col", { style: "width:" + L.totW + "mm" }));
        tbl.appendChild(cg);
        var hr = S3.h("tr", { style: "height:" + THEAD + "mm" });
        if (L.numW) hr.appendChild(S3.h("th", { text: t.num }));
        hr.appendChild(S3.h("th", { "class": "as-name", text: t.name }));
        part.forEach(function (c) { var hh = colHead(c, lang, multiMonth); hr.appendChild(S3.h("th", { "class": "as-dh" }, [S3.h("small", { text: hh[0] }), S3.h("b", { text: hh[1] })])); });
        if (last && L.totW) hr.appendChild(S3.h("th", { text: t.total }));
        tbl.appendChild(S3.h("thead", null, [hr]));
        var tb = S3.h("tbody");
        rows.slice(rp * L.rowsPer, (rp + 1) * L.rowsPer).forEach(function (n, i) {
          var tr = S3.h("tr", { style: "height:" + L.rowH + "mm" });
          if (L.numW) tr.appendChild(S3.h("td", { "class": "as-n", text: n ? String(rp * L.rowsPer + i + 1) : "" }));
          tr.appendChild(S3.h("td", { "class": "as-name" }, [S3.h("div", { dir: "auto", text: n })]));
          var cnt = 0;
          part.forEach(function (c) {
            var m = st.printMarks && n ? marks[n + "\u0001" + c.key] || "" : "";
            tr.appendChild(S3.h("td", { "class": "as-c" + (m ? " m-" + m : "") }, [st.cell === "box" && !m ? S3.h("i") : MARK[m]]));
          });
          if (last && L.totW) {
            if (st.printMarks && n) cols.forEach(function (c) { var m = marks[n + "\u0001" + c.key]; if (m === "P" || m === "L") cnt++; });
            tr.appendChild(S3.h("td", { "class": "as-tot", text: st.printMarks && n ? String(cnt) : "" }));
          }
          tb.appendChild(tr);
        });
        tbl.appendChild(tb);
        page.appendChild(tbl);
        page.appendChild(S3.h("div", { "class": "as-foot", style: "height:" + FOOT + "mm;left:" + MARGIN + "mm;right:" + MARGIN + "mm;bottom:" + MARGIN + "mm" }, [
          S3.h("span", { text: st.cell === "box" || st.printMarks ? t.legend : "" }),
          S3.h("span", { text: t.sign + ": ______________________" }),
          S3.h("span", { text: t.page + " " + pageNo + " " + t.of + " " + L.pages })
        ]));
        target.appendChild(page);
      }
    }
    return { L: L, names: names, cols: cols };
  }

  var pageStyle = document.head.appendChild(S3.h("style", { id: "asPage" }));
  function fitPreview() {
    var stage = $("#stage"), first = $("#preview .as-page");
    if (!first) return;
    var mmPx = 96 / 25.4, w = stage.clientWidth - 28, z = Math.min(1, w / (parseFloat(first.style.width) * mmPx));
    $("#preview").style.zoom = String(z);
  }

  // ---------- register (on-screen ticking) ----------
  function drawRegister(names, cols) {
    var tbl = $("#reg"), lang = st.lang, multi = false;
    tbl.textContent = "";
    if (!names.length || !cols.length) {
      tbl.appendChild(S3.h("tbody", null, [S3.h("tr", null, [S3.h("td", { "class": "empty", text: names.length ? "Choose some dates first." : "Add some names first." })])]));
      $("#regStats").textContent = ""; return;
    }
    if (cols[0].day != null) multi = new Date(cols[0].day * 864e5).getUTCMonth() !== new Date(cols[cols.length - 1].day * 864e5).getUTCMonth();
    var hr = S3.h("tr", null, [S3.h("th", { "class": "as-rn", text: T[lang].name })]);
    cols.forEach(function (c) {
      var hh = colHead(c, lang, multi);
      hr.appendChild(S3.h("th", null, [S3.h("button", { "class": "as-colbtn", type: "button", "data-col": c.key, title: "Mark everyone still empty as present", text: (hh[0] ? hh[0] + " " : "") + hh[1] })]));
    });
    hr.appendChild(S3.h("th", { text: "✓" })); hr.appendChild(S3.h("th", { text: "%" }));
    tbl.appendChild(S3.h("thead", null, [hr]));
    var tb = S3.h("tbody"), tot = { P: 0, A: 0, L: 0 };
    names.forEach(function (n, ri) {
      var tr = S3.h("tr", null, [S3.h("th", { "class": "as-rn", dir: "auto", text: n })]), p = 0, seen = 0;
      cols.forEach(function (c) {
        var m = marks[n + "\u0001" + c.key] || "";
        if (m) { tot[m]++; seen++; if (m !== "A") p++; }
        tr.appendChild(S3.h("td", null, [S3.h("button", { "class": "as-cellbtn m-" + (m || "0"), type: "button", "data-r": ri, "data-col": c.key, "aria-label": n + " " + c.key + ": " + (m || "empty"), text: MARK[m] })]));
      });
      tr.appendChild(S3.h("td", { "class": "as-num", text: String(p) }));
      tr.appendChild(S3.h("td", { "class": "as-num", text: seen ? Math.round(p / seen * 100) + "%" : "—" }));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    var st2 = $("#regStats"); st2.textContent = "";
    [["present", tot.P], ["absent", tot.A], ["late", tot.L], ["names", names.length], ["dates", cols.length]].forEach(function (x) {
      st2.appendChild(S3.h("div", { "class": "stat" }, [S3.h("b", { text: String(x[1]) }), S3.h("span", { text: x[0] })]));
    });
  }
  var regNames = [], regCols = [];
  $("#reg").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    if (b.classList.contains("as-cellbtn")) {
      var k = regNames[+b.dataset.r] + "\u0001" + b.dataset.col, m = NEXT[marks[k] || ""];
      if (m) marks[k] = m; else delete marks[k];
    } else if (b.classList.contains("as-colbtn")) {
      regNames.forEach(function (n) { var k2 = n + "\u0001" + b.dataset.col; if (!marks[k2]) marks[k2] = "P"; });
    } else return;
    saveMarks(); var focusKey = b.dataset.r + "|" + b.dataset.col;
    render();
    var again = $$("#reg .as-cellbtn").filter(function (x) { return x.dataset.r + "|" + x.dataset.col === focusKey; })[0];
    if (again) again.focus();
  });

  // ---------- UI ----------
  var status = $("#status");
  function render() {
    persist();
    $("#monthWrap").hidden = st.mode !== "month";
    $("#startWrap").hidden = st.mode !== "sessions";
    $("#countWrap").hidden = st.mode === "month";
    $("#countWrap").firstChild.textContent = st.mode === "blank" ? "Number of columns" : "Number of sessions";
    $("#skipWrap").hidden = st.mode === "blank";
    $("#title").placeholder = T[st.lang].title;
    var r = buildPages($("#preview"));
    buildPages($("#sheet"));
    regNames = r.names; regCols = r.cols;
    pageStyle.textContent = "@page { size: " + st.paper + " " + st.orient + "; margin: 0; }";
    $("#nameCount").textContent = r.names.length + (r.names.length === 1 ? " name" : " names");
    var c = r.cols, info = "";
    if (st.mode !== "blank") info = c.length ? c.length + " dates: " + c.slice(0, 6).map(function (x) { return isoOf(x.day).slice(5); }).join(", ") + (c.length > 6 ? " … " + isoOf(c[c.length - 1].day).slice(5) : "") : "No dates. Check the month or the skipped days.";
    $("#dateInfo").textContent = info;
    if (!c.length) { status.className = "chip warn"; status.textContent = "No date columns"; }
    else if (!r.names.length) { status.className = "chip"; status.textContent = r.L.pages + (r.L.pages > 1 ? " pages" : " page") + " · add names"; }
    else { status.className = "chip ok"; status.textContent = r.L.pages + (r.L.pages > 1 ? " pages" : " page") + " · " + r.L.rowsPer + " rows each" + (r.L.chunks > 1 ? " · dates split over " + r.L.chunks : ""); }
    if (st.view === "register") drawRegister(r.names, r.cols);
    requestAnimationFrame(fitPreview);
  }
  var queue = S3.debounce(render, 120);

  function seg(el, value, onPick) {
    $$("button", el).forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.v === String(value)));
      b.addEventListener("click", function () { $$("button", el).forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); onPick(b.dataset.v); });
    });
  }
  function bindAll() {
    ["title", "group", "teacher", "names"].forEach(function (k) { $("#" + k).value = st[k]; $("#" + k).addEventListener("input", function () { st[k] = this.value; queue(); }); });
    ["extra", "count"].forEach(function (k) { $("#" + k).value = st[k]; $("#" + k).addEventListener("input", function () { st[k] = Math.max(0, Math.min(k === "count" ? 100 : 60, parseInt(this.value, 10) || 0)); queue(); }); });
    ["month", "start", "paper", "orient", "rowH", "lang"].forEach(function (k) { $("#" + k).value = st[k]; $("#" + k).addEventListener("change", function () { st[k] = this.value; render(); }); });
    ["num", "total", "printMarks"].forEach(function (k) { $("#" + k).checked = st[k]; $("#" + k).addEventListener("change", function () { st[k] = this.checked; render(); }); });
    seg($("#mode"), st.mode, function (v) { st.mode = v; render(); });
    seg($("#cell"), st.cell, function (v) { st.cell = v; if (v === "sign" && +st.rowH < 10) { st.rowH = "13"; $("#rowH").value = "13"; } render(); });
    seg($("#view"), st.view, function (v) { st.view = v; showView(); render(); });
    var order = [6, 0, 1, 2, 3, 4, 5];
    order.forEach(function (d) {
      var cb = S3.h("input", { type: "checkbox", value: String(d) });
      cb.checked = st.skip.indexOf(d) >= 0;
      cb.addEventListener("change", function () { st.skip = $$("#skip input").filter(function (x) { return x.checked; }).map(function (x) { return +x.value; }); render(); });
      $("#skip").appendChild(S3.h("label", { "class": "check as-day" }, [cb, WD.en[d]]));
    });
  }
  function showView() { $("#sheetView").hidden = st.view !== "sheet"; $("#registerView").hidden = st.view !== "register"; }
  bindAll(); showView();

  var SAMPLE = ["Ahmad Khalil", "Lina Haddad", "Omar Saleh", "Sara Nasser", "Yousef Abu Zaid", "Maya Rahman", "Karim Odeh", "Huda Mansour",
    "Zaid Qasem", "Noor Hamdan", "Tariq Aziz", "Rana Barakat", "Fadi Shami", "Dina Jaber", "Hani Masri", "Leen Awad"];
  $("#sample").addEventListener("click", function () { st.names = SAMPLE.join("\n"); $("#names").value = st.names; render(); });
  $("#sortNames").addEventListener("click", function () {
    var n = parseNames(st.names); if (!n.length) return;
    n.sort(function (a, b) { return a.localeCompare(b, st.lang); }); st.names = n.join("\n"); $("#names").value = st.names; render();
  });
  $("#print").addEventListener("click", function () {
    if (!columns(st).length) { S3.toast("There are no date columns. Check the month or skipped days.", "error"); return; }
    render(); window.print(); S3.done();
  });
  function fname() { return (st.title || "attendance").replace(/[^\w؀-ۿ -]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "attendance"; }
  function regCSV() { return "﻿" + toCSV(regNames, regCols, marks, true); }
  $("#csvBlank").addEventListener("click", function () {
    if (!regNames.length) { S3.toast("Add some names first", "error"); return; }
    S3.download("﻿" + toCSV(regNames, regCols, marks, false), fname() + "-blank.csv", "text/csv;charset=utf-8"); S3.done();
  });
  $("#csv").addEventListener("click", function () {
    if (!regNames.length) { S3.toast("Add some names first", "error"); return; }
    S3.download(regCSV(), fname() + ".csv", "text/csv;charset=utf-8"); S3.done();
  });
  $("#copyCsv").addEventListener("click", function () { if (regNames.length) { S3.copy(regCSV().slice(1), "CSV copied"); S3.done(); } });
  $("#clearMarks").addEventListener("click", function () {
    var keys = Object.keys(marks).length;
    if (!keys) { S3.toast("No ticks to clear"); return; }
    if (!window.confirm("Clear all " + keys + " recorded ticks?")) return;
    marks = {}; saveMarks(); render();
  });
  window.addEventListener("resize", S3.debounce(fitPreview, 100));
  render();

  window.S3_DEMO = function () {
    Object.assign(st, { title: "", group: "Grade 7 B · Science", teacher: "Ms. Rana", names: SAMPLE.join("\n"), mode: "month", month: "2026-11",
      skip: [5, 6], cell: "box", orient: "landscape", rowH: "8", extra: 2, view: "sheet" });
    ["title", "group", "teacher", "names", "month", "rowH", "orient"].forEach(function (k) { $("#" + k).value = st[k]; });
    $$("#skip input").forEach(function (x) { x.checked = st.skip.indexOf(+x.value) >= 0; });
    render();
  };

  window.S3_SELFTEST = function () {
    var nov = columns({ mode: "month", month: "2026-11", skip: [5, 6] });          // Nov 2026: 30 days, 4 Fri + 4 Sat
    var feb = columns({ mode: "month", month: "2028-02", skip: [] });              // leap year
    var ses = columns({ mode: "sessions", start: "2026-11-05", count: 3, skip: [5, 6] }); // Thu, then skip Fri/Sat
    var weekends = columns({ mode: "month", month: "2026-11", skip: [1, 2, 3, 4, 5] }); // only Sat + Sun
    var none = columns({ mode: "month", month: "2026-11", skip: [0, 1, 2, 3, 4, 5, 6] });
    var blank = columns({ mode: "blank", count: 4 });
    var L = layout({ paper: "A4", orient: "landscape", rowH: 8, num: true, total: true, cell: "box" }, 22, 40);
    var S = layout({ paper: "A4", orient: "landscape", rowH: 13, num: true, total: true, cell: "sign" }, 22, 10);
    var names = parseNames("1. Ahmad\n\n 2) Lina \nOmar\tx\n");
    var csv = toCSV(["A, B", 'Q"x'], [{ key: "2026-11-01", day: 1 }], { "A, B\u00012026-11-01": "P" }, true);
    return nov.length === 22 && nov[0].key === "2026-11-01" && nov[4].key === "2026-11-05" && nov[5].key === "2026-11-08" &&
      nov.every(function (c) { var w = dow(c.day); return w !== 5 && w !== 6; }) &&
      feb.length === 29 && ses.map(function (c) { return c.key; }).join() === "2026-11-05,2026-11-08,2026-11-09" &&
      weekends.length === 9 && weekends[0].key === "2026-11-01" && none.length === 0 && blank.length === 4 && blank[3].key === "c4" &&
      L.rowsPer === 19 && L.rowPages === 3 && L.chunks === 1 && L.pages === 3 && Math.abs(L.numW + L.nameW + 22 * L.colW + L.totW - 277) < 1e-9 &&
      S.chunks === 3 && S.per === 8 && S.pages === 3 &&
      names.join("|") === "Ahmad|Lina|Omar" &&
      csv === 'Name,2026-11-01,Present,Absent,Late\r\n"A, B",P,1,0,0\r\n"Q""x",,0,0,0\r\n';
  };
})();

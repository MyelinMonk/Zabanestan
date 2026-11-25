/* Wikipedia reading finder, for the roster languages that have a Wikipedia.
   Take the longest articles from
   Special:LongPages, read each one, score it by how much of it is prose (paragraphs and
   sections count for it; lists, tables and infoboxes against it), keep the likely reading
   material and rank it. Requests go straight from the visitor's browser to Wikipedia. */
(function () {
  "use strict";
  // Roster languages with a live Wikipedia. "dir" and "lang" make titles display properly.
  var WIKIS = [
    { code: "mzn", name: "Mazandarani", native: "مازرونی", dir: "rtl" },
    { code: "glk", name: "Gilaki", native: "گیلکی", dir: "rtl" },
    { code: "tly", name: "Taleshi", native: "Tolışi", dir: "ltr" },
    { code: "os", name: "Ossetian", native: "Ирон", dir: "ltr" },
    { code: "diq", name: "Zazaki", native: "Zazaki", dir: "ltr" },
  ];
  var wiki = WIKIS[0];
  var API = function () { return "https://" + wiki.code + ".wikipedia.org/w/api.php"; };
  var STORE = function () { return "zabanestan-wiki-finder-" + wiki.code; };
  var root = document.getElementById("finder");
  if (!root) return;

  // ---------- small helpers ----------
  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (attrs[k] == null || attrs[k] === false) continue;
      if (k === "text") n.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fmt(n) { return Math.round(n).toLocaleString("en-US"); }
  function articleUrl(title) { return "https://" + wiki.code + ".wikipedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_")); }
  function squish(s) { return s.replace(/\s+/g, " ").trim(); }

  function RateLimited() { this.name = "RateLimited"; }
  async function api(params, signal) {
    var q = new URLSearchParams(Object.assign({ format: "json", origin: "*" }, params));
    var res;
    try { res = await fetch(API() + "?" + q.toString(), { signal: signal }); }
    catch (e) {
      if (e && e.name === "AbortError") throw e;
      // Wikipedia's "too many requests" answer often arrives without the header browsers need,
      // so it looks like a network error. Either way, the right thing is to wait.
      throw new RateLimited();
    }
    if (res.status === 429 || res.status === 503) throw new RateLimited();
    if (!res.ok) throw new Error("Wikipedia answered " + res.status);
    return res.json();
  }

  // ---------- 1. the longest articles ----------
  async function longPages(limit, signal) {
    var out = [], seen = {}, offset = 0;
    for (var round = 0; round < 10 && out.length < limit; round++) {
      var dat = await api({ action: "query", list: "querypage", qppage: "Longpages", qplimit: "500", qpoffset: String(offset) }, signal);
      var batch = (dat.query && dat.query.querypage && dat.query.querypage.results) || [];
      if (!batch.length) break;
      batch.forEach(function (p) {
        var ns = p.ns == null ? 0 : Number(p.ns);
        if (ns !== 0 || !p.title || seen[p.title]) return;
        seen[p.title] = true;
        out.push({ title: p.title, length_bytes: Number(p.value) || 0 });
      });
      offset += batch.length;
      await sleep(100);
    }
    out.sort(function (a, b) { return b.length_bytes - a.length_bytes; });
    return out.slice(0, limit);
  }

  // ---------- 2. score one article ----------
  function scorePage(page, html) {
    var parser = new DOMParser();
    var full = parser.parseFromString(html, "text/html");
    var doc = parser.parseFromString(html, "text/html");
    ["table", ".navbox", ".vertical-navbox", ".metadata", ".mw-references-wrap", "sup.reference", ".thumb"].forEach(function (sel) {
      doc.querySelectorAll(sel).forEach(function (n) { n.remove(); });
    });
    var paras = Array.prototype.map.call(doc.querySelectorAll("p"), function (p) { return squish(p.textContent); });
    var prose = squish(paras.join(" "));
    var r = {
      title: page.title,
      length_bytes: page.length_bytes,
      prose_chars: Array.from(prose).length,
      paragraph_count: paras.filter(function (t) { return t !== ""; }).length,
      list_items: doc.querySelectorAll("li").length,
      table_count: full.querySelectorAll("table").length,
      infobox_count: full.querySelectorAll(".infobox").length,
      section_count: doc.querySelectorAll("h2, h3").length,
      fullurl: articleUrl(page.title),
    };
    r.prose_ratio = page.length_bytes > 0 ? r.prose_chars / page.length_bytes : 0;
    r.score = r.prose_chars + 800 * r.paragraph_count + 400 * r.section_count
      - 120 * r.list_items - 2500 * r.table_count - 1500 * r.infobox_count;
    return r;
  }

  // ---------- 3. keep likely reading material, best first ----------
  function readingCandidates(scored) {
    return scored.filter(function (r) {
      return r.prose_chars >= 1500 && r.table_count <= 8 && r.list_items <= 120 && r.paragraph_count >= 5;
    }).sort(function (a, b) {
      return b.score - a.score || b.prose_chars - a.prose_chars || b.length_bytes - a.length_bytes;
    });
  }

  // ---------- the page ----------
  var state = { running: false, ctrl: null, results: null, checkedAt: 0, partial: false, pick: null };
  // results are kept per language, so switching back shows the last search
  function recall() {
    state.results = null; state.checkedAt = 0; state.partial = false; state.pick = null;
    try {
      var saved = JSON.parse(localStorage.getItem(STORE()) || "null");
      if (saved && Array.isArray(saved.results)) { state.results = saved.results; state.checkedAt = saved.at; state.partial = !!saved.partial; }
    } catch (e) { /* storage off */ }
  }
  function remember() {
    try {
      localStorage.setItem(STORE(), JSON.stringify({ results: state.results, at: state.checkedAt, partial: state.partial }));
      localStorage.setItem("zabanestan-wiki-finder-lang", wiki.code);
    } catch (e) { /* storage off */ }
  }
  try {
    var last = localStorage.getItem("zabanestan-wiki-finder-lang");
    WIKIS.forEach(function (w) { if (w.code === last) wiki = w; });
  } catch (e) { /* storage off */ }
  recall();

  var langSel = el("select", { id: "finder-lang", class: "finder-select", onchange: function () {
    WIKIS.forEach(function (w) { if (w.code === langSel.value) wiki = w; });
    try { localStorage.setItem("zabanestan-wiki-finder-lang", wiki.code); } catch (e) { /* storage off */ }
    recall(); status.textContent = ""; render();
  } });
  WIKIS.forEach(function (w) {
    langSel.appendChild(el("option", { value: w.code, selected: w === wiki }, w.name));
  });
  var countSel = el("select", { id: "finder-count", class: "finder-select" },
    el("option", { value: "50" }, "50 longest · about 1 min"),
    el("option", { value: "100" }, "100 longest · about 2 min"),
    el("option", { value: "200", selected: true }, "200 longest · about 4 min"));
  var startBtn = el("button", { type: "button", class: "button button-primary", onclick: start }, "Find articles");
  var stopBtn = el("button", { type: "button", class: "button button-secondary", hidden: true, onclick: function () { if (state.ctrl) state.ctrl.abort(); } }, "Stop");
  var bar = el("div", { class: "finder-bar", hidden: true }, el("i"));
  var status = el("p", { class: "finder-status", role: "status", "aria-live": "polite" });
  var out = el("div", { class: "finder-results" });

  root.replaceChildren(
    el("div", { class: "finder-controls" },
      el("div", { class: "finder-field" }, el("label", { for: "finder-lang" }, "Language"), langSel),
      el("div", { class: "finder-field" }, el("label", { for: "finder-count" }, "Articles to check"), countSel),
      el("div", { class: "finder-buttons" }, startBtn, stopBtn)),
    bar, status, out);

  function setProgress(done, total) {
    bar.hidden = false;
    bar.firstChild.style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
  }

  async function start() {
    if (state.running) return;
    var limit = Number(countSel.value);
    state.running = true; state.ctrl = new AbortController(); state.pick = null;
    startBtn.disabled = true; stopBtn.hidden = false; countSel.disabled = true; langSel.disabled = true;
    out.replaceChildren();
    var scored = [], pages = [], stoppedBy = null, t0 = Date.now();
    try {
      status.textContent = "Asking the " + wiki.name + " Wikipedia for its longest articles…";
      setProgress(0, 1);
      pages = await longPages(limit, state.ctrl.signal);
      for (var i = 0; i < pages.length; i++) {
        var left = i > 2 ? Math.round(((Date.now() - t0) / i) * (pages.length - i) / 1000) : null;
        status.textContent = "Reading article " + (i + 1) + " of " + pages.length + (left != null ? " · about " + (left > 90 ? Math.round(left / 60) + " minutes" : left + " seconds") + " left" : "") + "…";
        setProgress(i, pages.length);
        var html = null;
        for (var attempt = 0; attempt < 2 && html == null; attempt++) {
          try {
            var dat = await api({ action: "parse", page: pages[i].title, prop: "text", disablelimitreport: "1", disableeditsection: "1" }, state.ctrl.signal);
            html = (dat.parse && dat.parse.text && dat.parse.text["*"]) || "";
          } catch (e) {
            if (e && e.name === "AbortError") throw e;
            if (attempt === 1) throw e;
            await sleep(2500);
          }
        }
        if (html) scored.push(scorePage(pages[i], html));
        await sleep(100);
      }
      setProgress(1, 1);
    } catch (e) {
      stoppedBy = e && e.name === "AbortError" ? "stopped" : e instanceof RateLimited ? "limited" : "error";
    }
    state.running = false; state.ctrl = null;
    startBtn.disabled = false; stopBtn.hidden = true; countSel.disabled = false; langSel.disabled = false; bar.hidden = true;
    if (scored.length) {
      state.results = readingCandidates(scored);
      state.checkedAt = Date.now();
      state.partial = !!stoppedBy;
      remember();
    }
    status.textContent =
      stoppedBy === "limited" ? "Wikipedia has stopped answering, usually because of too many requests in a short time. Wait 5–10 minutes, then try again." + (scored.length ? " Below are the articles checked so far." : "")
      : stoppedBy === "stopped" ? (scored.length ? "Stopped. Below are the articles checked so far." : "Stopped.")
      : stoppedBy === "error" ? "Something went wrong talking to Wikipedia. Check your connection and try again."
      : "";
    render();
  }

  function render() {
    out.replaceChildren();
    var rows = state.results;
    if (!rows) return;
    var when = state.checkedAt ? new Date(state.checkedAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "";
    if (!rows.length) {
      out.appendChild(el("p", null, "None of the articles checked looked like good reading material. Try checking more of them."));
      return;
    }
    var pick = state.pick != null ? rows[state.pick] : null;
    // (append() would print a missing pick as the word "null", so add the parts one by one)
    [el("div", { class: "finder-summary" },
        el("p", null, wiki.name + ": " + fmt(rows.length) + " article" + (rows.length === 1 ? "" : "s") + " worth reading" + (state.partial ? ", from a search that was cut short" : "") + (when ? " · checked " + when : "")),
        el("div", { class: "actions" },
          el("button", { type: "button", class: "button button-secondary", onclick: function () {
            state.pick = Math.floor(Math.random() * rows.length); render();
            var hit = out.querySelector(".finder-pick"); if (hit) hit.scrollIntoView({ block: "nearest" });
          } }, "Pick one at random"),
          el("button", { type: "button", class: "button button-secondary", onclick: saveCsv }, "Save as a spreadsheet"))),
      pick ? el("p", { class: "finder-pick" }, "Your random article: ",
        el("a", { href: pick.fullurl, target: "_blank", rel: "noopener", lang: wiki.code, dir: wiki.dir, class: wiki.dir === "rtl" ? "finder-title-rtl" : null }, pick.title)) : null
    ].forEach(function (n) { if (n) out.appendChild(n); });
    var table = el("table", { class: "finder-table" },
      el("thead", null, el("tr", null,
        el("th", { scope: "col" }, "#"),
        el("th", { scope: "col" }, "Article"),
        el("th", { scope: "col", class: "num" }, "Paragraphs"),
        el("th", { scope: "col", class: "num" }, "Characters of prose"),
        el("th", { scope: "col", class: "num" }, "Lists"),
        el("th", { scope: "col", class: "num" }, "Tables"),
        el("th", { scope: "col", class: "num" }, "Score"))),
      el("tbody", null));
    rows.forEach(function (r, i) {
      table.tBodies[0].appendChild(el("tr", { class: i === state.pick ? "is-pick" : null },
        el("td", null, String(i + 1)),
        el("td", null, el("a", { href: r.fullurl, target: "_blank", rel: "noopener", lang: wiki.code, dir: wiki.dir, class: wiki.dir === "rtl" ? "finder-title-rtl" : null }, r.title)),
        el("td", { class: "num" }, fmt(r.paragraph_count)),
        el("td", { class: "num" }, fmt(r.prose_chars)),
        el("td", { class: "num" }, fmt(r.list_items)),
        el("td", { class: "num" }, fmt(r.table_count)),
        el("td", { class: "num" }, fmt(r.score))));
    });
    out.appendChild(el("div", { class: "finder-table-wrap" }, table));
  }

  function saveCsv() {
    var cols = ["title", "length_bytes", "prose_chars", "paragraph_count", "list_items", "table_count", "infobox_count", "section_count", "prose_ratio", "score", "fullurl"];
    var esc = function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [cols.join(",")].concat(state.results.map(function (r) { return cols.map(function (c) { return esc(r[c]); }).join(","); }));
    // the byte-order mark lets Excel read the Mazandarani titles correctly
    var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = el("a", { href: URL.createObjectURL(blob), download: wiki.code + "_wikipedia_reading.csv" });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  render();
})();

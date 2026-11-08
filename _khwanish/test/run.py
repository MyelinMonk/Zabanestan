import json, os, sys, threading, http.server, functools, time, traceback
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
TEST = ROOT / "test"
OUT = TEST / "out"
OUT.mkdir(exist_ok=True)
PDFJS_DIR = TEST / "node_modules/pdfjs-dist/build"

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DIST))
class Quiet(Handler.func):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8765), functools.partial(Quiet, directory=str(DIST)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:8765/index.html"
MOCK = (TEST / "mock.js").read_text()

fails = []
def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{str(info)[:300]}]" if info and not cond else ""))
    if not cond: fails.append(name)

def wire(page, errors):
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    def pdfjs(route):
        name = route.request.url.rsplit("/", 1)[-1]
        route.fulfill(path=str(PDFJS_DIR / name), content_type="text/javascript")
    page.route("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/**", pdfjs)
    page.route("https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/**", lambda r: r.fulfill(path=str(TEST / "node_modules/sql.js/dist" / r.request.url.rsplit("/", 1)[-1]), content_type="text/javascript"))
    page.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css"))
    page.route("https://fonts.gstatic.com/**", lambda r: r.abort())

def settle(page, ms=400):
    page.wait_for_timeout(ms)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])

    # ---------- fixtures: a Persian PDF with a text layer, and a page photo ----------
    fx = browser.new_page()
    fx.set_content("""<html><body style="font-family:serif;font-size:20px;padding:40px" dir="rtl">
      <p>این یک متن آزمایشی است که در سال 2026 برای امتحان خواندن PDF Reader نوشته شده.</p><p>صفحهٔ ۱۴۰۵ از کتاب.</p>
      <p>کتاب‌ها را روی میز گذاشتم و به خانه رفتم. فردا دوباره می‌آیم.</p>
      <p>زبان مازندرانی و زبان گیلکی از زبان‌های ایرانی شمالی هستند.</p></body></html>""")
    fx.pdf(path=str(OUT / "persian.pdf"), format="A4")
    fx.screenshot(path=str(OUT / "page.png"))
    fx.close()
    import wave, struct, math
    with wave.open(str(OUT / "talk.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
        w.writeframes(b"".join(struct.pack("<h", int(3000 * math.sin(2 * math.pi * 220 * i / 8000))) for i in range(8000 * 8)))
    (OUT / "talk.srt").write_text("""1
00:00:00,000 --> 00:00:01,500
<i>سلام</i> دوستان من

2
00:00:01,500 --> 00:00:03,000
امروز دربارهٔ زبان مازندرانی حرف می‌زنیم

3
00:00:03,000 --> 00:00:08,000
{\\an8}این زبان در شمال ایران گفته می‌شود
""", encoding="utf-8")

    # ---------- device A ----------
    ctxA = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    ctxA.add_init_script(MOCK)
    page = ctxA.new_page()
    errA = []
    wire(page, errA)
    page.goto(URL)
    page.wait_for_selector(".tiles")
    settle(page, 800)

    # unit checks on the core logic
    u = page.evaluate("""() => {
      const fa = L('fa'), fr = L('fr'), pi = L('pi'), sa = L('sa'), tg = L('tg');
      const k = keyFn(fa), kp = keyFn(pi), ks = keyFn(sa), kt = keyFn(tg);
      const os = makeLang(CATALOG_BY_CODE.os), zza = makeLang(CATALOG_BY_CODE.zza);
      const frToks = tokenizer(fr)("L'homme qu’il aime aujourd'hui, c'est-à-dire peut-être.").filter(t => t.w).map(t => t.s);
      const saToks = tokenizer(sa)("कर्मण्येवाधिकारस्ते मा फलेषु कदाचन । मा").map(t => [t.s, t.w]);
      const faToks = tokenizer(fa)("می‌روم به خانهٔ دوستم، ۱۲ بار.").filter(t => t.w).map(t => t.s);
      const paras = analyze("Un. Deux trois! Quatre\\n\\nCinq six.", fr);
      const long = Array.from({length: 900}, (_, i) => 'mot' + i + (i % 12 === 11 ? '.' : '')).join(' ');
      const pages = paginate(analyze(long, fr), 220);
      // FSRS
      const t0 = Date.UTC(2026, 10, 8, 12);
      let c = newCard();
      const a1 = FSRS.next(c, 3, t0, {});
      const a2 = FSRS.next(a1, 3, t0 + 10 * MIN, {});
      const a3 = FSRS.next(a2, 3, a2.due + 1000, {});
      const a4 = FSRS.next(a3, 1, a3.due + 1000, {});
      const easyNew = FSRS.next(newCard(), 4, t0, {});
      const pv = FSRS.preview(a3, a3.due + 1000, {});
      return {
        zwnj: k('مي‌روم') === k('میروم'),
        ezafe: k('خانهٔ') === k('خانه') && k('خانۀ') === k('خانه'),
        harakat: k('کِتاب') === k('کتاب'),
        pali: kp('saṁsāra') === kp('saṃsāra'),
        sanskrit: ks('kr̥ṣṇa') === ks('kṛṣṇa'),
        tajikStress: kt('кито́б') === kt('китоб'),
        tajikMacron: kt('ӣ') !== kt('и'),
        ossetian: keyFn(os)('æз') === keyFn(os)('ӕз'),
        zazaCase: keyFn(zza)('IRMAK') === 'ırmak',
        frToks, saToks, faToks,
        sentences: paras.map(p => p.toks.filter(t => t.w).map(t => t.sid)),
        gaps: paras.map(p => p.gap),
        pageCount: pages.length, pageSizes: pages.map(pg => pg.reduce((n, b) => n + analyze(long, fr)[b.p].toks.slice(b.a, b.b).filter(t => t.w).length, 0)),
        fsrs: { a1: [a1.q, (a1.due - t0) / MIN], a2: [a2.q, a2.ivl, +a2.S.toFixed(2)], a3: [a3.q, a3.ivl, +a3.S.toFixed(2), +a3.D.toFixed(2)], a4: [a4.q, a4.lp, +a4.S.toFixed(2)], easy: [easyNew.q, easyNew.ivl], pv: Object.values(pv).map(fmtIvl) },
        enc: JSON.stringify(decE(encE({ s: 1, u: 5, a: 4, m: 'x', c: { q: 2, due: 9, S: 1.23456, D: 5, rp: 1, lp: 0, lr: 3, st: 0 } }))),
        encKnown: JSON.stringify(encE({ s: 2, u: 1731000000000 })),
      };
    }""")
    print(json.dumps(u, ensure_ascii=False, indent=1))
    check("persian zwnj + arabic yeh match", u["zwnj"])
    check("persian ezafe forms match", u["ezafe"])
    check("persian harakat ignored", u["harakat"])
    check("pali ṁ/ṃ match", u["pali"])
    check("sanskrit r̥/ṛ match", u["sanskrit"])
    check("tajik stress ignored", u["tajikStress"])
    check("tajik ӣ kept distinct", u["tajikMacron"])
    check("ossetian æ/ӕ match", u["ossetian"])
    check("zazaki dotless i", u["zazaCase"])
    check("french elision split", u["frToks"] == ["L'", "homme", "qu’", "il", "aime", "aujourd'hui", "c'", "est", "à", "dire", "peut", "être"], u["frToks"])
    check("persian tokens keep ZWNJ words, skip digits", u["faToks"] == ["می‌روم", "به", "خانهٔ", "دوستم", "بار"], u["faToks"])
    check("devanagari danda is not a word", ["।", False] in [[s.strip(), w] for s, w in u["saToks"]] or any(not w and "।" in s for s, w in u["saToks"]))
    check("sentence ids", u["sentences"][0] == [0, 1, 1, 2], u["sentences"])
    check("stanza gap kept", u["gaps"] == [False, True], u["gaps"])
    check("long paragraph paginated", u["pageCount"] >= 4 and max(u["pageSizes"]) <= 320, u["pageSizes"])
    f = u["fsrs"]
    check("fsrs new→good = 10m learning", f["a1"] == [1, 10.0], f["a1"])
    check("fsrs graduates to review", f["a2"][0] == 2 and 2 <= f["a2"][1] <= 6, f["a2"])
    check("fsrs review grows interval", f["a3"][0] == 2 and f["a3"][1] > f["a2"][1], f["a3"])
    check("fsrs lapse → relearning", f["a4"][0] == 3 and f["a4"][1] == 1, f["a4"])
    check("fsrs easy new card ≈ 16d", f["easy"][0] == 2 and 14 <= f["easy"][1] <= 17, f["easy"])

    # ---------- library → sample → reader ----------
    check("sample offered", page.locator(".lesson.sample").count() == 1)
    check("cloud connected", page.evaluate("Cloud.state") == "ready", page.evaluate("Cloud.state"))
    page.locator(".lesson.sample").click()
    page.wait_for_selector("#rtext .w")
    settle(page)
    n_words = page.locator("#rtext .w").count()
    check("reader shows words", n_words >= 25, n_words)
    check("all words start new", page.locator("#rtext .w.st-new").count() == n_words)
    words = page.locator("#rtext .w")
    words.nth(0).click()
    page.wait_for_selector("#sheet .sh-word")
    check("panel shows tapped word", page.locator("#sheet .sh-word").inner_text() == words.nth(0).inner_text())
    page.fill("#f-m", "children of Adam")
    page.get_by_role("button", name="Add flashcard").click()
    settle(page)
    check("word becomes learning", "st-l1" in words.nth(0).get_attribute("class"))
    # Ask Claude on a second word
    words.nth(1).click()
    settle(page, 200)
    check("panel switches without leaking the old meaning", page.input_value("#f-m") == "")
    page.get_by_role("button", name="Ask Claude").click()
    page.wait_for_selector(".ai-card")
    page.get_by_role("button", name="Use this").click()
    settle(page)
    e1 = page.evaluate("JSON.stringify(entry('fa', tokOf(UI.reader.flat[1]).k))")
    check("claude suggestion saved", '"m":"mock meaning"' in e1 and '"r":"mockroot"' in e1, e1)
    # known
    words.nth(2).click()
    page.locator(".seg .s-known").click()
    settle(page)
    check("known word unhighlighted", page.evaluate("UI.reader.flat[2].className.includes('st-')") is False)
    # phrase
    words.nth(4).click()
    page.get_by_role("button", name="+ word after").click()
    settle(page, 200)
    phr = page.locator("#sheet .sh-word").inner_text()
    check("phrase grows", len(phr.split()) == 2, phr)
    page.fill("#f-m", "a phrase")
    page.press("#f-m", "Enter")
    settle(page)
    page.keyboard.press("Escape")
    settle(page)
    check("phrase underlined", page.locator("#rtext .w.ph").count() >= 2)
    page.screenshot(path=str(OUT / "reader.png"))
    # open panel for the screenshot
    words.nth(5).click()
    settle(page, 300)
    page.screenshot(path=str(OUT / "reader-sheet.png"))
    page.keyboard.press("Escape")
    # finish
    page.locator("#pg-next").click()
    settle(page)
    check("finish dialog", page.locator("#modal h2").inner_text() == "Text finished")
    check("untouched words known after finishing", page.locator("#rtext .w.st-new").count() == 0)
    page.locator("#modal").get_by_role("button", name="Library").click()
    settle(page)
    meta = page.locator(".lesson .l-meta").first.inner_text()
    check("library shows % known", "% known" in meta, meta)
    known_tile = page.locator(".tile .big").first.inner_text()
    check("known count shown", int(known_tile.replace(",", "")) >= 20, known_tile)

    # ---------- review ----------
    page.goto(URL + "#review")
    page.wait_for_selector(".rv-head")
    settle(page)
    check("review has a card", page.locator(".rv-card").count() == 1)
    page.get_by_role("button", name="Show answer").click()
    labels = page.locator(".grade small").all_inner_texts()
    check("grade buttons show intervals", labels[:3] == ["1m", "6m", "10m"], labels)
    page.locator(".grade.good").click()
    settle(page)
    page.screenshot(path=str(OUT / "review.png"))
    page.keyboard.press("Space")
    page.keyboard.press("1")
    settle(page)
    page.keyboard.press("u")
    settle(page)
    check("undo restores the card front", page.get_by_role("button", name="Show answer").count() == 1)
    rcount = page.evaluate("today().r")
    check("review stats counted", rcount == 1, rcount)
    sib = page.evaluate("""() => {
      const out = {};
      const m = vmap('fa');
      const now = Date.now();
      // a word whose forward card was studied today: its reverse card must wait
      m.set('__a', { s: 1, m: 'x', u: now, a: 1, c: { ...newCard(), q: 2, due: now + 5 * DAY, lr: now, S: 5, D: 5 }, c2: { ...newCard(), q: 2, due: now - DAY, lr: now - 3 * DAY, S: 3, D: 5 } });
      // a word studied days ago: its due reverse card is offered
      m.set('__b', { s: 1, m: 'y', u: now, a: 2, c: { ...newCard(), q: 2, due: now + 5 * DAY, lr: now - 2 * DAY, S: 5, D: 5 }, c2: { ...newCard(), q: 2, due: now - DAY, lr: now - 3 * DAY, S: 3, D: 5 } });
      const picks = [];
      for (const [k, e] of m) { }
      const all = [];
      let it, guard = 0, avoid = null;
      const saved = new Map(m);
      // collect review-state picks without answering, by temporarily hiding picked items
      const hidden = [];
      while ((it = pickNext('lang')) && guard++ < 50) { all.push(it.key + ':' + it.d); const e = m.get(it.key); hidden.push([it.key, e]); m.delete(it.key); }
      for (const [k, e] of hidden) m.set(k, e);
      m.delete('__a'); m.delete('__b');
      out.picks = all;
      return out;
    }""")
    check("reverse card waits when its sibling was studied today", "__a:2" not in sib["picks"] and "__b:2" in sib["picks"], sib)

    # ---------- words + Anki export ----------
    page.goto(URL + "#words")
    page.wait_for_selector("#wlist")
    settle(page)
    check("words list shows learning words", page.locator(".wrow").count() >= 3, page.locator(".wrow").count())
    page.get_by_role("button", name="Export to Anki").click()
    page.wait_for_selector("#modal .radios")
    page.check("#ex-file-txt")
    status = page.locator("#modal [role=status]").inner_text()
    check("export count", "will be exported" in status, status)
    page.locator("#modal").get_by_role("button", name="Save file").click()
    settle(page)
    dl = page.evaluate("window.__dl")
    check("anki file saved", dl and dl["filename"].endswith(".txt") and dl["data"].startswith("#separator:tab"), str(dl)[:200])
    if dl:
        lines = dl["data"].strip().split("\n")
        check("anki headers", "#notetype:Basic (and reversed card)" in lines and "#columns:GUID\tFront\tBack\tTags" in lines, lines[:8])
        rows = [l for l in lines if not l.startswith("#")]
        check("anki rows have 4 columns", rows and all(r.count("\t") == 3 for r in rows), rows[:2])
        (OUT / "anki.txt").write_text(dl["data"])
    exported = page.evaluate("[...vmap('fa').values()].filter(e => e.ex).length")
    check("exported words remembered", exported >= 2, exported)

    # ---------- Anki package with schedule and review history ----------
    page.evaluate("""() => {
      const [k, e] = [...vmap('fa')].find(([k, e]) => e.c && e.c.q);
      let t = Date.now() - 40 * DAY, c = { ...newCard(), due: t };
      for (const g of [3, 3, 3, 1, 3]) { t = Math.max(t, c.due) + 1000; c = FSRS.answer(c, g, t, {}); }
      putEntry('fa', k, { c });
      window.__histKey = k;
    }""")
    page.goto(URL + "#words")
    page.wait_for_selector("#wlist")
    page.get_by_role("button", name="Export to Anki").click()
    page.wait_for_selector("#ex-file-apkg")
    check("package is the default export", page.is_checked("#ex-file-apkg"))
    page.uncheck("#ex-new")
    page.locator("#modal").get_by_role("button", name="Save file").click()
    page.wait_for_selector("text=Anki package saved", timeout=30000)
    saved = page.locator("#modal .m-text").inner_text()
    print("APKG:", saved)
    dl = page.evaluate("window.__dl")
    check("package saved as .apkg.zip", dl["filename"].endswith(".apkg.zip") and dl["data"].startswith("@b64:"), dl["filename"])
    import base64
    (OUT / "test.apkg").write_bytes(base64.b64decode(dl["data"][5:]))
    hist_key = page.evaluate("window.__histKey")
    page.locator("#modal").get_by_role("button", name="Done").click()

    # ---------- options: Zabanestan roster ----------
    page.goto(URL + "#options")
    page.wait_for_selector(".opt-langs")
    stray = page.evaluate("""() => { const w = document.createTreeWalker(document.querySelector('#view'), NodeFilter.SHOW_TEXT); const out = []; let n;
      while ((n = w.nextNode())) if (/^(null|undefined|false|true|\\[object [A-Za-z]+\\])$/.test(n.textContent.trim())) out.push(n.textContent.trim()); return out; }""")
    check("options: no stray text", not stray, stray)
    page.get_by_role("button", name="Add the Zabanestan Core Roster (19)").click()
    settle(page)
    n_langs = page.evaluate("S.settings.langs.length")
    check("roster added", n_langs == 25, n_langs)
    roster = page.evaluate("S.settings.langs.filter(l => CATALOG_BY_CODE[l.code] && CATALOG_BY_CODE[l.code].roster).map(l => l.name)")
    check("all 20 roster languages present", len(roster) == 20, roster)
    ab = page.evaluate("""() => {
      const fa = L('fa');
      const link = dictUrl(fa.dicts.find(d => d.n === 'Abadis').u, 'نوش خوردن');
      const old = fixSettings({ v: 1, u: 5, cur: 'fa', langs: [{ ...makeLang(CATALOG_BY_CODE.fa), dicts: [DICTS.vajehyab(), DICTS.steingass()] }] });
      const hist = [...vmap('fa').values()].filter(e => e.c && e.c.h).map(e => e.c.h);
      return { names: fa.dicts.map(d => d.n), link, upgraded: old.langs[0].dicts.map(d => d.n), v: old.v, hist };
    }""")
    print("ABADIS", json.dumps(ab, ensure_ascii=False))
    check("persian dictionaries include Abadis", ab["names"][:3] == ["Vajehyab", "Abadis", "Steingass"], ab["names"])
    check("abadis link format", ab["link"] == "https://abadis.ir/fatofa/%D9%86%D9%88%D8%B4-%D8%AE%D9%88%D8%B1%D8%AF%D9%86/", ab["link"])
    check("saved persian settings gain Abadis", ab["upgraded"] == ["Vajehyab", "Abadis", "Steingass"] and ab["v"] == 2, ab["upgraded"])
    check("review history recorded", len(ab["hist"]) >= 1 and len(ab["hist"][0][0]) == 5 and ab["hist"][0][0][1] == 3, ab["hist"])

    # ---------- French paste import ----------
    page.evaluate("switchLang('fr')")
    page.goto(URL + "#library")
    page.wait_for_selector(".tiles")
    settle(page)
    page.get_by_role("button", name="Paste text").click()
    page.fill("#imp-text", "L'homme qu'il aime est arrivé aujourd'hui. Il dit : « Bonjour ! »")
    page.locator("#modal").get_by_role("button", name="Import").click()
    page.wait_for_selector("#rtext .w")
    frw = page.locator("#rtext .w").all_inner_texts()
    check("french reader tokens", frw[:4] == ["L'", "homme", "qu'", "il"], frw)

    # ---------- PDF import (text layer) ----------
    page.evaluate("switchLang('fa')")
    page.goto(URL + "#library")
    page.wait_for_selector(".tiles")
    page.get_by_role("button", name="Import a file").click()
    page.set_input_files("#imp-file", str(OUT / "persian.pdf"))
    page.locator("#modal").get_by_role("button", name="Import").click()
    page.wait_for_selector("text=has text inside it", timeout=15000)
    page.get_by_role("button", name="Use the PDF’s text").click()
    page.wait_for_selector("#pv-text", timeout=15000)
    pdf_text = page.input_value("#pv-text")
    print("PDF TEXT:", pdf_text[:200].replace("\n", " / "))
    check("pdf text extracted in order", "را روی میز گذاشتم" in pdf_text and "به خانه رفتم" in pdf_text, pdf_text[:120])
    check("pdf rejoins wrapped lines", "PDF Reader نوشته شده." in pdf_text, pdf_text[:160])
    check("pdf ezafe mark reattached", "صفحهٔ ۱۴۰۵" in pdf_text, pdf_text[:200])
    check("pdf keeps numbers and latin words", "سال 2026 برای" in pdf_text and "PDF Reader" in pdf_text and "۱۴۰۵" in pdf_text, pdf_text[:160])
    page.locator("#modal").get_by_role("button", name="Create text").click()
    page.wait_for_selector("#rtext .w")
    check("pdf lesson opens", page.locator("#rtext .w").count() > 20)

    # ---------- scan (photo) import via Claude ----------
    page.goto(URL + "#library")
    page.wait_for_selector(".tiles")
    settle(page)
    page.get_by_role("button", name="Scan pages").click()
    page.set_input_files("#imp-file", str(OUT / "page.png"))
    page.locator("#modal").get_by_role("button", name="Continue").click()
    page.wait_for_selector("text=Transcribe pages")
    page.locator("#modal").get_by_role("button", name="Start").click()
    page.wait_for_selector("#pv-text", timeout=15000)
    check("scan transcription in preview", "نمونهٔ متن" in page.input_value("#pv-text"))
    calls = page.evaluate("window.__imgCalls")
    check("scan sent images to Claude", calls and calls[0]["n"] >= 1, calls)
    page.locator("#modal").get_by_role("button", name="Create text").click()
    page.wait_for_selector("#rtext .w")

    # ---------- timed text parsing ----------
    tt = page.evaluate(r"""() => {
      const yt = `WEBVTT
Kind: captions
Language: fa

00:00:00.000 --> 00:00:02.000 align:start position:0%
سلام<00:00:00.500><c> به</c><00:00:01.000><c> همه</c>

00:00:02.000 --> 00:00:02.010 align:start position:0%
سلام به همه
 

00:00:02.010 --> 00:00:04.000 align:start position:0%
سلام به همه
امروز<00:00:02.500><c> درس</c><00:00:03.000><c> داریم</c>

00:00:04.000 --> 00:00:04.010 align:start position:0%
امروز درس داریم
 `;
      const lrc = `[ti:test]\n[00:01.00]line one\n[00:03.50]line two\n[00:05.00][00:09.00]chorus`;
      const js = JSON.stringify({ app: 'khwanish-media', title: 'غزل ۱', lang: 'fa', credit: 'Recited by X', cues: [{ s: 0, e: 2000, t: 'مصرع یک' }, { s: 2000, e: 4000, t: 'مصرع دو' }, { s: 4000, e: 6000, t: 'مصرع سه', gap: true }] });
      return { yt: parseTimed(yt, 'a.vtt').cues, lrc: parseTimed(lrc, 'a.lrc').cues, js: parseTimed(js, 'p.json') };
    }""")
    print("TIMED", json.dumps(tt, ensure_ascii=False)[:600])
    check("youtube rolling captions deduplicated", [c["t"] for c in tt["yt"]] == ["سلام به همه", "امروز درس داریم"], [c["t"] for c in tt["yt"]])
    check("lrc parsed with ends", [c["t"] for c in tt["lrc"]] == ["line one", "line two", "chorus"] and tt["lrc"][0]["e"] == 3500 and tt["lrc"][2]["e"] == 14000, tt["lrc"])
    check("helper json keeps title, credit and stanza gaps", tt["js"]["title"] == "غزل ۱" and tt["js"]["cues"][2]["gap"] is True, tt["js"])

    # ---------- audio lesson ----------
    page.goto(URL + "#library")
    page.wait_for_selector(".tiles")
    page.get_by_role("button", name="Audio or video").click()
    page.set_input_files("#mi-media", str(OUT / "talk.wav"))
    page.set_input_files("#mi-timed", str(OUT / "talk.srt"))
    page.locator("#modal").get_by_role("button", name="Create").click()
    page.wait_for_selector("#player audio", timeout=10000)
    check("audio lesson shows a player", page.locator("#player audio").count() == 1)
    check("each subtitle line gets a time button", page.locator("#rtext .cue-t").count() == 3, page.locator("#rtext .cue-t").count())
    check("subtitle tags stripped", "{" not in page.locator("#rtext").inner_text() and "<i>" not in page.locator("#rtext").inner_text())
    page.locator("#rtext .cue-t").nth(1).click()
    page.wait_for_function("document.querySelector('#rtext p.now')", timeout=8000)
    now_line = page.evaluate("document.querySelector('#rtext p.now').dataset.cue")
    check("current line highlighted while playing", now_line in ("1", "2"), now_line)
    page.locator("#rtext p[data-cue='2'] .w").first.click()
    settle(page, 200)
    paused = page.evaluate("UI.reader.el.paused")
    check("playback pauses while a word is open", paused is True)
    page.keyboard.press("Escape")
    settle(page, 300)
    check("playback resumes when the panel closes", page.evaluate("UI.reader.el.paused") is False)
    page.evaluate("UI.reader.el.pause()")
    page.screenshot(path=str(OUT / "audio-lesson.png"))
    audio_id = page.evaluate("UI.reader.meta.id")

    # let sync finish, then check what reached the account
    page.goto(URL + "#library")
    page.wait_for_selector(".tiles")
    page.wait_for_function("!Sync.has() && !Sync.running", timeout=20000)
    st = page.evaluate("JSON.stringify(window.__dbStats)")
    print("db calls:", st)
    mock = page.evaluate("localStorage.getItem('__mockdb')")
    store = json.loads(mock)
    keys = sorted(store.keys())
    print("account docs:", len(keys), [k.split('/')[-1] for k in keys][:20])
    check("settings saved to account", any(k.endswith("/settings") for k in keys))
    check("lesson texts saved to account", sum(1 for k in keys if "/lt." in k) >= 4)
    check("vocab shards saved to account", any("/v.fa." in k for k in keys))

    # backup
    page.goto(URL + "#options")
    page.wait_for_selector(".opt-langs")
    page.get_by_role("button", name="Back up everything").click()
    page.wait_for_function("window.__dl && window.__dl.filename.endsWith('.json')", timeout=10000)
    bk = json.loads(page.evaluate("window.__dl.data"))
    check("backup has lessons and words", len(bk["lessons"]) >= 4 and len(bk["vocab"]["fa"]) >= 20, (len(bk["lessons"]), list(bk["vocab"].keys())))

    # reload persists
    page.reload()
    page.wait_for_selector("#view")
    page.goto(URL + "#library")
    page.wait_for_selector(".tiles")
    settle(page, 600)
    kn = page.locator(".tile .big").first.inner_text()
    check("known count survives reload", int(kn.replace(",", "")) >= 20, kn)
    check("no errors on device A", not errA, errA[:5])

    # ---------- device B: same account, empty browser ----------
    ctxB = browser.new_context(viewport={"width": 1280, "height": 860})
    ctxB.add_init_script(f"sessionStorage.getItem('__seed') || sessionStorage.setItem('__seed', {json.dumps(mock)});")
    ctxB.add_init_script(MOCK)
    pb = ctxB.new_page()
    errB = []
    wire(pb, errB)
    pb.goto(URL)
    pb.wait_for_selector(".tiles")
    pb.wait_for_function("Cloud.state === 'ready' && S.cloudLoaded.has('fa')", timeout=15000)
    settle(pb, 600)
    check("device B sees settings from the account", pb.evaluate("S.settings.langs.length") == 25)
    kb = pb.locator(".tile .big").first.inner_text()
    check("device B sees known words", int(kb.replace(",", "")) >= 20, kb)
    nb = pb.locator(".lessons .lesson").count()
    check("device B lists lessons", nb >= 4, nb)
    pb.evaluate(f"openLesson('{audio_id}')")
    pb.wait_for_selector("#player .relink", timeout=10000)
    check("other device asks for the recording", "talk.wav" in pb.locator("#player .relink").inner_text())
    pb.goto(URL + "#library")
    pb.wait_for_selector(".lessons .lesson")
    pb.locator(".lessons .lesson").last.click()
    pb.wait_for_selector("#rtext .w", timeout=10000)
    check("device B downloads lesson text", pb.locator("#rtext .w").count() > 5)
    pb.locator("#rtext .w").first.click()
    settle(pb, 300)
    pb.screenshot(path=str(OUT / "desktop-reader.png"))
    check("no errors on device B", not errB, errB[:5])

    # ---------- no Claude runtime: device-only mode ----------
    ctxC = browser.new_context(viewport={"width": 390, "height": 844})
    ctxC.add_init_script("window.__noClaude = true;")
    ctxC.add_init_script(MOCK)
    pc = ctxC.new_page()
    errC = []
    wire(pc, errC)
    pc.goto(URL)
    pc.wait_for_selector(".tiles")
    settle(pc, 500)
    check("device-only mode", pc.evaluate("Cloud.state") == "local")
    check("no scan button without Claude", pc.get_by_role("button", name="Scan pages").count() == 0)
    pc.locator(".lesson.sample").click()
    pc.wait_for_selector("#rtext .w")
    pc.locator("#rtext .w").first.click()
    check("no Ask Claude without Claude", pc.get_by_role("button", name="Ask Claude").count() == 0)
    check("no errors in device-only mode", not errC, errC[:5])

    browser.close()

# ---------- import the package into a real Anki collection ----------
import tempfile
from anki.collection import Collection, ImportAnkiPackageRequest, ImportAnkiPackageOptions
tmp = tempfile.mkdtemp()
col = Collection(os.path.join(tmp, "collection.anki2"))
res = col.import_anki_package(ImportAnkiPackageRequest(package_path=str(OUT / "test.apkg"), options=ImportAnkiPackageOptions(with_scheduling=True)))
today = col.sched.today
decks = sorted(d.name for d in col.decks.all_names_and_ids())
notes = col.find_notes("")
cards = col.db.all("select c.id, c.type, c.queue, c.due, c.ivl, c.reps, c.lapses, c.data, n.flds from cards c join notes n on n.id = c.nid")
revs = col.db.all("select cid, ease, ivl, lastIvl, type from revlog order by id")
print("ANKI today", today, "decks", decks, "notes", len(notes))
for r in cards:
    if r[1] != 0: print("  card", r[1:8], r[8].split("\x1f")[0])
print("  revlog", revs)
check("anki imports every note", len(notes) == 3, (len(notes), saved))
check("anki imports both card directions", col.card_count() == int(saved.split()[0]) and col.card_count() > len(notes), (col.card_count(), saved))
ords = col.db.list("select ord from cards")
check("anki has word→meaning and meaning→word cards", 0 in ords and 1 in ords, ords)
check("anki deck created", any("Khwānish" in d for d in decks), decks)
rev_cards = [r for r in cards if r[1] == 2]
check("anki has a review card with FSRS state", rev_cards and '"s"' in rev_cards[0][7] and rev_cards[0][4] >= 1, rev_cards)
if rev_cards:
    check("anki keeps the overdue date", rev_cards[0][3] < today, (rev_cards[0][3], today))
    check("anki review card keeps reps and lapses", rev_cards[0][5] == 5 and rev_cards[0][6] == 1, rev_cards[0][5:7])
check("anki revlog carries the history", len(revs) == 5 and [x[1] for x in revs] == [3, 3, 3, 1, 3] and [x[4] for x in revs] == [0, 0, 1, 1, 2], revs)
new_cards = [r for r in cards if r[1] == 0]
check("cards never reviewed stay new", len(new_cards) >= 1, len(new_cards))
col.close()

print("\n%d failures" % len(fails))
for f in fails: print(" -", f)
srv.shutdown()

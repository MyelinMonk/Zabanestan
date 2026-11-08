"""The website copy (dist/site), served the way the Zabanestan site serves it:
no Claude runtime, and any request to another host is blocked and counted.
Run  python3 build.py --site  first (and test/run.py once, for its PDF fixture)."""
import base64, functools, http.server, json, os, re, shutil, tempfile, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "dist" / "site"
OUT = ROOT / "test" / "out"
REPO = ROOT.parent  # the Zabanestan site, when this folder is its _khwanish/

# lay it out like https://myelinmonk.github.io/Zabanestan/
serve = Path(tempfile.mkdtemp())
base = serve / "Zabanestan"
shutil.copytree(SITE, base / "khwanish")
guide = Path(os.environ.get("GUIDE_HTML", ""))
if guide.is_file():  # the rendered reader page, when the Jekyll site has been built
    shutil.copytree(guide.parent, base, dirs_exist_ok=True, ignore=shutil.ignore_patterns("khwanish"))
else:
    (base / "reader.html").write_text('<!doctype html><title>Reader guide</title><h1>Reader guide</h1><h2 id="ocr">OCR</h2>')
    (base / "index.html").write_text("<!doctype html><title>Zabanestan</title>")
if not (base / "favicon.svg").exists():  # the site's icon, which the page links to as ../favicon.svg
    if (REPO / "favicon.svg").exists():
        shutil.copy(REPO / "favicon.svg", base / "favicon.svg")
    else:
        (base / "favicon.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>')


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8767), functools.partial(Quiet, directory=str(serve)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
HOST = "http://127.0.0.1:8767"
URL = HOST + "/Zabanestan/khwanish/"

fails = []

STRAY_JS = """() => { const w = document.createTreeWalker(document.querySelector('#view'), NodeFilter.SHOW_TEXT); const out = []; let n;
  while ((n = w.nextNode())) if (/^(null|undefined|false|true|\\[object [A-Za-z]+\\])$/.test(n.textContent.trim())) out.push(n.textContent.trim() + ' in ' + n.parentElement.tagName);
  return out; }"""


def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{str(info)[:300]}]" if info and not cond else ""))
    if not cond:
        fails.append(name)


outside, missing, errors, local_reqs = [], [], [], []


def watch(ctx, page):
    def route(r):
        if r.request.url.startswith(HOST):
            local_reqs.append(r.request.url)
            r.continue_()
        else:
            outside.append(r.request.url)
            r.abort()
    ctx.route("**/*", route)
    page.on("response", lambda r: missing.append(f"{r.status} {r.url}") if r.status >= 400 else None)
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))


def faces(page, family):
    return page.evaluate("f => [...document.fonts].filter(x => x.family.replace(/[\"']/g, '') === f).map(x => x.status)", family)


with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])

    # a scanned PDF: a picture of a page, with no text inside
    fx = b.new_page()
    img = base64.b64encode((OUT / "page.png").read_bytes()).decode()
    fx.set_content(f'<img src="data:image/png;base64,{img}" style="width:100%">')
    fx.pdf(path=str(OUT / "scan.pdf"), format="A4")
    fx.close()

    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, accept_downloads=True)
    pg = ctx.new_page()
    watch(ctx, pg)
    pg.goto(URL)
    pg.wait_for_selector(".tiles")
    pg.wait_for_timeout(600)
    check("runs without Claude", pg.evaluate("typeof window.claude") == "undefined" and pg.evaluate("Cloud.state") == "local")
    check("site settings present", pg.evaluate("SITE && SITE.name") == "Zabanestan")
    check("browser saves files itself", pg.evaluate("Cloud.plainFiles === true && !!Cloud.downloads"))
    langs = pg.evaluate("S.settings.langs.map(l => l.code)")
    check("starts with Persian and the Core Roster", len(langs) == 21 and langs[0] == "fa" and "zza" in langs and "bsh" in langs and "sgh-x-rushani" in langs and "pi" not in langs and "smy" not in langs, langs)
    bad = pg.evaluate("""() => S.settings.langs.map(l => { try { const a = analyze('سلام دنیا Salom dunyo Салом', l); return a && a.length ? null : l.code + ': no words'; } catch (e) { return l.code + ': ' + e.message; } }).filter(Boolean)""")
    check("every roster language reads text", not bad, bad)
    note = pg.locator(".notice")
    check("first visit points to the guide", note.count() == 1 and "New here?" in note.inner_text(), note.all_inner_texts())
    href = pg.evaluate("document.querySelector('.notice a').href")
    check("guide link goes to the site's reader page", href == HOST + "/Zabanestan/reader.html", href)
    pg.screenshot(path=str(OUT / "site-first-run.png"))
    pg.evaluate("document.fonts.ready")
    pg.wait_for_timeout(300)
    check("wordmark font loads from the site", "loaded" in faces(pg, "Khwanish Mark"), faces(pg, "Khwanish Mark"))
    check("interface font loads from the site", "loaded" in faces(pg, "IBM Plex Sans"), faces(pg, "IBM Plex Sans"))

    # read a sample and save a word
    pg.locator(".lesson.sample").click()
    pg.wait_for_selector("#rtext .w")
    pg.wait_for_timeout(500)
    check("Persian reading font loads from the site", "loaded" in faces(pg, "Noto Naskh Arabic"), faces(pg, "Noto Naskh Arabic"))
    pg.locator("#rtext .w").nth(0).click()
    pg.wait_for_selector("#sheet .sh-word")
    check("no Ask Claude button", pg.get_by_role("button", name="Ask Claude").count() == 0)
    pg.fill("#f-m", "children of Adam")
    pg.get_by_role("button", name="Add flashcards").click()
    pg.wait_for_timeout(300)
    e = pg.evaluate("(() => { const e = entry('fa', tokOf(UI.reader.flat[0]).k); return { c: !!e.c, c2: !!e.c2, m: e.m }; })()")
    check("word saved with both cards", e == {"c": True, "c2": True, "m": "children of Adam"}, e)
    pg.keyboard.press("Escape")

    # enough saved words to ask for a backup
    pg.evaluate("""() => { const now = Date.now();
      for (let i = 0; i < 16; i++) putEntry('fa', 'واژه' + i, { s: 1, m: 'word ' + i, c: newCard(), a: now }); }""")
    pg.goto(URL + "#library")
    pg.wait_for_selector(".tiles")
    pg.wait_for_timeout(300)
    note = pg.locator(".notice")
    check("backup reminder appears", note.count() == 1 and "only in this browser" in note.inner_text(), note.all_inner_texts())
    pg.screenshot(path=str(OUT / "site-backup-notice.png"))
    with pg.expect_download() as dl:
        note.get_by_role("button", name="Save a backup").click()
    d = dl.value
    check("backup downloads as .json", re.fullmatch(r"khwanish-backup-\d{4}-\d\d-\d\d\.json", d.suggested_filename) is not None, d.suggested_filename)
    d.save_as(str(OUT / "site-backup.json"))
    bk = json.loads((OUT / "site-backup.json").read_text(encoding="utf-8"))
    check("backup holds the words and texts", bk.get("app") == "khwanish" and len(bk["vocab"].get("fa", {})) >= 17 and len(bk["lessons"]) >= 1, (len(bk["vocab"].get("fa", {})), len(bk["lessons"])))
    pg.wait_for_timeout(300)
    check("reminder gone after the backup", pg.locator(".notice").count() == 0, pg.locator(".notice").all_inner_texts())
    pg.goto(URL + "#options")
    pg.wait_for_selector("#o-last-backup")
    check("options show the last backup", pg.inner_text("#o-last-backup") == "Last backup: today.", pg.inner_text("#o-last-backup"))
    check("options: no stray text", not pg.evaluate(STRAY_JS), pg.evaluate(STRAY_JS))
    secs = [s.strip().lower() for s in pg.locator("#view h2.sec").all_inner_texts()]
    check("no Claude section on the website", "claude" not in secs and "about" in secs, secs)
    about = pg.evaluate("[...document.querySelectorAll('#view section.opt')].pop().querySelectorAll('a').length && [...[...document.querySelectorAll('#view section.opt')].pop().querySelectorAll('a')].map(a => a.href)")
    check("about links back to the site", about[:2] == [HOST + "/Zabanestan/reader.html", HOST + "/Zabanestan/"] and about[2] == URL + "LICENSE.txt", about)
    for link in about[2:]:
        status = pg.evaluate("u => fetch(u).then(r => r.status)", link)
        check(f"{link.rsplit('/', 1)[-1]} is there", status == 200, status)
    pg.locator("#view section.opt").last.scroll_into_view_if_needed()
    pg.screenshot(path=str(OUT / "site-options.png"))

    # Anki package: a real .apkg, built with the site's own sql.js
    pg.goto(URL + "#words")
    pg.wait_for_selector("#wlist")
    pg.get_by_role("button", name="Export to Anki").click()
    pg.wait_for_selector("#ex-file-apkg")
    check("package is the default export", pg.is_checked("#ex-file-apkg"))
    with pg.expect_download() as dl:
        pg.locator("#modal").get_by_role("button", name="Save file").click()
    d = dl.value
    check("package saved with a real .apkg name", re.fullmatch(r"khwanish-fa-\d{4}-\d\d-\d\d\.apkg", d.suggested_filename) is not None, d.suggested_filename)
    d.save_as(str(OUT / "site.apkg"))
    pg.wait_for_selector("text=Anki package saved")
    reported = int(re.match(r"\s*(\d+) cards?", pg.locator("#modal .m-text").first.inner_text()).group(1))
    steps = pg.locator("#modal .steps li").all_inner_texts()
    check("no rename step", len(steps) == 2 and not any("Rename" in s for s in steps), steps)
    check("sql.js came from the site", any(u.endswith("/khwanish/lib/sql.js/sql-asm-memory-growth.js") for u in local_reqs))
    pg.screenshot(path=str(OUT / "site-export-saved.png"))
    pg.locator("#modal").get_by_role("button", name="Done").click()
    pg.get_by_role("button", name="Export to Anki").click()
    pg.wait_for_selector("#ex-file-txt")
    pg.check("#ex-file-txt")
    pg.uncheck("#ex-new")
    with pg.expect_download() as dl:
        pg.locator("#modal").get_by_role("button", name="Save file").click()
    d = dl.value
    txt = Path(d.path()).read_text(encoding="utf-8")
    check("text export downloads", d.suggested_filename.endswith(".txt") and txt.startswith("#separator:tab"), d.suggested_filename)

    # PDF with text, read by the site's own pdf.js
    pg.goto(URL + "#library")
    pg.wait_for_selector(".tiles")
    pg.get_by_role("button", name="Import a file").click()
    pg.set_input_files("#imp-file", str(OUT / "persian.pdf"))
    pg.locator("#modal").get_by_role("button", name="Import").click()
    pg.wait_for_selector("text=has text inside it", timeout=20000)
    pg.get_by_role("button", name="Use the PDF’s text").click()
    pg.wait_for_selector("#pv-text", timeout=20000)
    pdf_text = pg.input_value("#pv-text")
    check("pdf text extracted in order", "را روی میز گذاشتم" in pdf_text and "صفحهٔ ۱۴۰۵" in pdf_text, pdf_text[:160])
    check("pdf.js and its worker came from the site", any(u.endswith("/khwanish/lib/pdfjs/pdf.min.js") for u in local_reqs) and any(u.endswith("/khwanish/lib/pdfjs/pdf.worker.min.js") for u in local_reqs), [u for u in local_reqs if "pdf" in u])
    hint = pg.locator("#modal").inner_text()
    check("pdf hint doesn't mention Claude", "Claude" not in hint, hint[:300])
    pg.locator("#modal").get_by_role("button", name="Create text").click()
    pg.wait_for_selector("#rtext .w")

    # a scanned PDF points to the OCR helper
    pg.goto(URL + "#library")
    pg.wait_for_selector(".tiles")
    pg.get_by_role("button", name="Import a file").click()
    pg.set_input_files("#imp-file", str(OUT / "scan.pdf"))
    pg.locator("#modal").get_by_role("button", name="Import").click()
    pg.wait_for_selector("text=looks like a scan", timeout=20000)
    msg = pg.locator("#modal p.muted").last
    check("scan points to the OCR helper", "OCR helper" in msg.inner_text() and "Claude" not in pg.locator("#modal").inner_text(), pg.locator("#modal").inner_text()[:300])
    ocr = pg.evaluate("[...document.querySelectorAll('#modal a')].map(a => a.href)")
    check("OCR link goes to the guide", HOST + "/Zabanestan/reader.html#ocr" in ocr, ocr)
    pg.screenshot(path=str(OUT / "site-scan.png"))
    pg.keyboard.press("Escape")

    # another device: restore the backup file
    ctx2 = b.new_context(viewport={"width": 390, "height": 844}, accept_downloads=True)
    pb = ctx2.new_page()
    watch(ctx2, pb)
    pb.goto(URL + "#options")
    pb.wait_for_selector("#o-restore")
    pb.set_input_files("#o-restore", str(OUT / "site-backup.json"))
    pb.wait_for_timeout(1200)
    n = pb.evaluate("[...vmap('fa').values()].filter(e => !e.d && e.m).length")
    check("backup restores on another device", n >= 17, n)
    check("restored text listed", pb.evaluate("[...S.lessons.values()].filter(m => !m.del).length") >= 1)
    b.close()

check("nothing requested from other hosts", not outside, sorted(set(outside))[:8])
check("no missing files", not missing, missing[:8])
check("no errors", not errors, errors[:5])

# the package goes into a real Anki collection
from anki.collection import Collection, ImportAnkiPackageRequest, ImportAnkiPackageOptions
tmp = tempfile.mkdtemp()
col = Collection(os.path.join(tmp, "collection.anki2"))
col.import_anki_package(ImportAnkiPackageRequest(package_path=str(OUT / "site.apkg"), options=ImportAnkiPackageOptions(with_scheduling=True)))
notes, cards = len(col.find_notes("")), col.card_count()
# 17 words with meanings; "meaning → word" cards are on, so Anki makes both directions for each
check("Anki imports the website's package", notes == 17 and cards == reported == 34, (notes, cards, reported))
col.close()

print(f"\n{len(fails)} failures")
for f in fails:
    print(" -", f)
srv.shutdown()

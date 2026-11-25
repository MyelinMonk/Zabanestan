"""Meanings from Wiktionary in the word panel (Wiktionary answered by the test).
Run  python3 build.py --site  first."""
import functools, http.server, shutil, tempfile, threading
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out"
OUT.mkdir(exist_ok=True)
serve = Path(tempfile.mkdtemp())
base = serve / "Zabanestan"
shutil.copytree(ROOT / "dist" / "site", base / "khanesh")
if (ROOT.parent / "images").exists():
    shutil.copytree(ROOT.parent / "images", base / "images")
(base / "reader.html").write_text("<!doctype html><title>Reader guide</title>")
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8774), functools.partial(Quiet, directory=str(serve)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:8774/Zabanestan/khanesh/"
fails, errors = [], []
def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{str(info)[:300]}]" if info and not cond else ""))
    if not cond: fails.append(name)
import json
# Wiktionary's current page markup (headings wrapped in div.mw-heading), trimmed
PAGE = """<div class="mw-content-ltr mw-parser-output">
<div class="mw-heading mw-heading2"><h2 id="Arabic">Arabic</h2></div>
<div class="mw-heading mw-heading3"><h3 id="Noun">Noun</h3></div>
<ol><li>amount (Arabic sense)</li></ol>
<div class="mw-heading mw-heading2"><h2 id="Persian">Persian</h2></div>
<div class="mw-heading mw-heading3"><h3 id="Etymology">Etymology</h3></div>
<p>From Arabic.</p>
<div class="mw-heading mw-heading3"><h3 id="Noun_2">Noun</h3></div>
<p><strong>مقدار</strong> (meqdâr)</p>
<ol><li><a href="#">amount</a>, <a href="#">quantity</a><sup class="reference">[1]</sup>
<dl><dd>example sentence</dd></dl></li>
<li>measure<ol><li>a sub-sense</li></ol></li></ol>
<div class="mw-heading mw-heading3"><h3 id="Adverb">Adverb</h3></div>
<ol><li>somewhat</li></ol>
<div class="mw-heading mw-heading2"><h2 id="Urdu">Urdu</h2></div>
<ol><li>Urdu sense</li></ol></div>"""
OLD = """<h2><span class="mw-headline" id="Persian">Persian</span></h2><h3><span class="mw-headline" id="Noun">Noun</span></h3><ol><li>book</li></ol><h2><span class="mw-headline" id="Tajik">Tajik</span></h2><ol><li>x</li></ol>"""
asked = []
def wikt(r):
    page = r.request.url.split("page=")[-1]
    asked.append(page)
    from urllib.parse import unquote
    w = unquote(page)
    if w == "مقدار": body = {"parse": {"title": w, "text": PAGE}}
    elif w == "کتاب": body = {"parse": {"title": w, "text": OLD}}
    else: body = {"error": {"code": "missingtitle"}}
    r.fulfill(body=json.dumps(body), content_type="application/json", headers={"Access-Control-Allow-Origin": "*"})
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    def router(r):
        u = r.request.url
        if u.startswith("http://127.0.0.1:8774"): r.continue_()
        elif u.startswith("https://en.wiktionary.org/w/api.php"): wikt(r)
        else: r.abort()
    ctx.route("**/*", router)
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL + "#library"); pg.wait_for_selector("#view")
    pg.evaluate("""(async () => { const m = await createLesson('fa', 'Test', 'ما یه مقدار کتاب و زغال داریم.', ''); putLesson(m); openLesson(m.id); })()""")
    pg.wait_for_selector("#rtext .w")
    def open_word(w):
        pg.locator("#rtext .w", has_text=w).first.click(); pg.wait_for_selector("#wk-btn")
    open_word("مقدار")
    pg.click("#wk-btn"); pg.wait_for_selector(".wk-def")
    defs = pg.locator(".wk-def").all_inner_texts()
    check("only the Persian section's meanings", defs == ["amount, quantity", "measure", "somewhat"], defs)
    check("parts of speech shown", pg.locator(".wk-pos").all_inner_texts() == ["NOUN", "ADVERB"] or [x.lower() for x in pg.locator(".wk-pos").all_inner_texts()] == ["noun", "adverb"], pg.locator(".wk-pos").all_inner_texts())
    pg.locator(".wk-def").nth(0).click()
    check("tapping fills the meaning box", pg.input_value("#f-m") == "amount, quantity")
    pg.locator(".wk-def").nth(1).click()
    pg.locator(".wk-def").nth(1).click()
    check("tapping another adds it once", pg.input_value("#f-m") == "amount, quantity; measure", pg.input_value("#f-m"))
    pg.screenshot(path=str(OUT / "wiktionary.png"))
    pg.click(".rbar .icon-btn[aria-label='Back to library']") if False else None
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    check("the meaning is saved", pg.evaluate("entry('fa', 'مقدار') && entry('fa', 'مقدار').m") == "amount, quantity; measure", pg.evaluate("entry('fa', 'مقدار')"))
    open_word("کتاب"); pg.click("#wk-btn"); pg.wait_for_selector(".wk-def")
    check("older page markup works too", pg.locator(".wk-def").all_inner_texts() == ["book"], pg.locator(".wk-def").all_inner_texts())
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    open_word("زغال"); pg.click("#wk-btn"); pg.wait_for_selector("#f-wk p:not(.thinking)")
    check("a missing word says so", "no Persian entry" in pg.inner_text("#f-wk"), pg.inner_text("#f-wk"))
    check("no errors", not errors, errors)
    b.close()
srv.shutdown()
print(f"\n{len(fails)} failures")
for f in fails: print(" -", f)

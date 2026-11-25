"""Importing Anki packages, old and new formats (packages from make_anki_fixtures.py).
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
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8775), functools.partial(Quiet, directory=str(serve)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:8775/Zabanestan/khanesh/"
fails, errors = [], []
def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{str(info)[:300]}]" if info and not cond else ""))
    if not cond: fails.append(name)
import subprocess, sys
subprocess.run([sys.executable, str(ROOT / "test" / "make_anki_fixtures.py")], check=True)
DAY = 86400000
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith("http://127.0.0.1:8775") else r.abort())
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "ERR_FAILED" not in m.text and not ("404" in m.text and not (ROOT.parent / "images").exists()) else None)
    pg.goto(URL + "#words"); pg.wait_for_selector("#wlist")
    pg.evaluate("putEntry('fa', 'میز', { s: 1, f: 'میز', m: 'table', ...cardsFor(null, false) })")
    def pick(name):
        with pg.expect_file_chooser() as fc: pg.click("#w-anki")
        fc.value.set_files(str(OUT / name))
        pg.wait_for_selector("#ak-go, #modal p.error:not(:empty)")

    pick("old.apkg")
    types = pg.locator(".ak-type").all_inner_texts()
    check("note types are listed, cloze marked as skipped", len(types) == 3 and any("Cloze notes can’t be imported yet" in t for t in types), types)
    check("Front and Back are picked as word and meaning", pg.input_value("#ak-w0") == "0" and pg.input_value("#ak-m0") == "1")
    check("an example shows what will come in", "نان" in pg.inner_text(".ak-ex >> nth=0") and "bread; loaf" in pg.inner_text(".ak-ex >> nth=0"), pg.inner_text(".ak-ex >> nth=0"))
    check("Anki's deck is offered", "Persian › Food" in pg.inner_text("#modal"))
    pg.screenshot(path=str(OUT / "anki-import.png"))
    pg.click("#ak-go"); pg.wait_for_selector("text=Imported from Anki")
    summary = pg.inner_text("#modal")
    check("the summary counts what came in and what was skipped", "Imported 3 words" in summary and "1 with recordings" in summary and "skipped 3" in summary, summary)
    e = pg.evaluate("entry('fa', 'نان')")
    check("meaning lines joined", e["m"] == "bread; loaf", e)
    check("a review card keeps its schedule", e["c"]["q"] == 2 and e["c"]["ivl"] == 12 and abs(e["c"]["S"] - 12) < 0.01 and len(e["c"]["h"]) == 3, e["c"])
    due_days = pg.evaluate("(entry('fa', 'نان').c.due - dayStart(Date.now())) / 86400000")
    check("its due date is 5 days away", abs(due_days - 5) < 0.05, due_days)
    check("its recording came with it", (e.get("au") or "").startswith("local:"), e.get("au"))
    check("it went into a deck named after Anki's", pg.evaluate("deckName('fa', entry('fa', 'نان').dk)") == "Persian › Food")
    a = pg.evaluate("entry('fa', 'آب')")
    check("FSRS memory comes across", abs(a["c"]["S"] - 33.5) < 0.01 and abs(a["c"]["D"] - 4.2) < 0.01, a["c"])
    check("the reverse card comes as the second card, new", a.get("c2") and a["c2"]["q"] == 0, a.get("c2"))
    check("a Notes field becomes the word's notes", a.get("n") == "a basic word", a)
    check("a new card stays new, in the main deck", pg.evaluate("entry('fa', 'سیب').c.q") == 0 and not pg.evaluate("entry('fa', 'سیب').dk"))
    check("a word you already have keeps its own meaning", pg.evaluate("entry('fa', 'میز').m") == "table")
    check("the cloze note isn't imported", pg.evaluate("entry('fa', 'کتاب')") is None)
    pg.locator("#modal").get_by_role("button", name="Done").click()
    check("the words list shows them", pg.locator("#wlist").inner_text().count("نان") >= 1)

    pick("new.apkg")
    check("new-style packages are read", pg.locator(".ak-type").count() == 1 and "Vocab" in pg.inner_text(".ak-type"), pg.inner_text("#modal"))
    check("the Meaning field is picked even when it isn't second", pg.input_value("#ak-m0") == "2")
    pg.uncheck("#ak-sched")
    pg.click("#ak-go"); pg.wait_for_selector("text=Imported from Anki")
    summary = pg.inner_text("#modal")
    check("one word, one skipped", "Imported 1 word" in summary and "skipped 1" in summary and "1 with recordings" in summary, summary)
    d = pg.evaluate("entry('fa', 'دار')")
    check("the Sentence field becomes the example", d.get("x") == "این دار بلنده", d)
    check("without the schedule, the card starts new", d["c"]["q"] == 0, d["c"])
    check("nested decks come across", pg.evaluate("deckName('fa', entry('fa', 'دار').dk)") == "Mazandarani › Unit 1")
    blob = pg.evaluate("(async () => { const b = await getMedia(entry('fa', 'دار').au.slice(6)); return b ? b.size : 0; })()") if pg.evaluate("typeof getMedia") == "function" else 1
    check("the recording was unpacked", blob > 1000, blob)
    pg.locator("#modal").get_by_role("button", name="Done").click()

    # a file that isn't a package
    (OUT / "bad.apkg").write_bytes(b"not a zip")
    pick("bad.apkg")
    check("a broken file says so", "isn’t an Anki package" in pg.inner_text("#modal"), pg.inner_text("#modal"))
    check("no errors", not errors, errors)
    b.close()
srv.shutdown()
print(f"\n{len(fails)} failures")
for f in fails: print(" -", f)

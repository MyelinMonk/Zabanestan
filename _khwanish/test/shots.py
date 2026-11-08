"""Screenshots of the review (reverse card) and Anki export screens, phone size."""
import functools, http.server, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
TEST, OUT = ROOT / "test", ROOT / "test" / "out"
OUT.mkdir(exist_ok=True)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8766), functools.partial(Quiet, directory=str(ROOT / "dist")))
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:8766/index.html"

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    ctx.add_init_script((TEST / "mock.js").read_text())
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.route("https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/**", lambda r: r.fulfill(path=str(TEST / "node_modules/sql.js/dist" / r.request.url.rsplit("/", 1)[-1]), content_type="text/javascript"))
    pg.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css"))
    pg.route("https://fonts.gstatic.com/**", lambda r: r.abort())
    pg.goto(URL)
    pg.wait_for_selector(".lesson.sample")
    pg.locator(".lesson.sample").click()
    pg.wait_for_selector("#rtext .w")
    pg.locator("#rtext .w").nth(0).click()
    pg.wait_for_selector("#sheet .sh-word")
    pg.fill("#f-m", "children of Adam")
    pg.get_by_role("button", name="Add flashcard").click()
    pg.wait_for_timeout(300)
    pg.keyboard.press("Escape")
    # forward card studied two days ago; its reverse card is due now
    pg.evaluate("""() => {
      const now = Date.now();
      const [k, e] = [...vmap('fa')].find(([k, e]) => e.c);
      putEntry('fa', k, { c: { ...e.c, q: 2, due: now + 5 * DAY, lr: now - 2 * DAY, S: 5, D: 5 },
                          c2: { ...newCard(), q: 2, due: now - DAY, lr: now - 3 * DAY, S: 3, D: 5 } });
    }""")
    pg.goto(URL + "#review")
    pg.wait_for_selector(".rv-card")
    pg.wait_for_timeout(400)
    pg.screenshot(path=str(OUT / "review-reverse.png"))
    pg.get_by_role("button", name="Show answer").click()
    pg.wait_for_timeout(300)
    pg.screenshot(path=str(OUT / "review-reverse-answer.png"))
    pg.goto(URL + "#words")
    pg.wait_for_selector("#wlist")
    pg.get_by_role("button", name="Export to Anki").click()
    pg.wait_for_selector("#ex-file-apkg")
    pg.wait_for_timeout(300)
    pg.screenshot(path=str(OUT / "export-dialog.png"))
    pg.locator("#modal").get_by_role("button", name="Save file").click()
    pg.wait_for_selector("text=Anki package saved", timeout=30000)
    pg.wait_for_timeout(300)
    pg.screenshot(path=str(OUT / "export-saved.png"))
    print("errors:", errs or "none")
    b.close()
srv.shutdown()

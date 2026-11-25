"""Audio or video with its text: a subtitle file, YouTube's transcript pasted in, or lines pasted in
and timed by hand. Uses a silent recording made here, since YouTube can't load in tests.
Run  python3 build.py --site  first."""
import functools, http.server, shutil, tempfile, threading, wave
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out"; OUT.mkdir(exist_ok=True)
serve = Path(tempfile.mkdtemp()); base = serve / "Zabanestan"
shutil.copytree(ROOT / "dist" / "site", base / "khanesh")
if (ROOT.parent / "images").exists():
    shutil.copytree(ROOT.parent / "images", base / "images")
(base / "reader.html").write_text("<!doctype html><title>Reader guide</title>")
rec = serve / "song.wav"
with wave.open(str(rec), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000); w.writeframes(b"\0\0" * 8000 * 30)
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8773), functools.partial(Quiet, directory=str(serve)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:8773/Zabanestan/khanesh/"
fails, errors = [], []
def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{str(info)[:300]}]" if info and not cond else ""))
    if not cond: fails.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 430, "height": 900}, device_scale_factor=2)
    ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith("http://127.0.0.1:8773") else r.abort())
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL + "#library"); pg.wait_for_selector("#view")
    pg.evaluate("setSettings({ cur: 'fa' })")

    def open_import():
        pg.goto(URL + "#library"); pg.wait_for_selector("#view")
        pg.get_by_role("button", name="Audio or video").click()
        pg.wait_for_selector("#mi-lang")
        pg.select_option("#mi-lang", "fa")
        pg.set_input_files("#mi-media", str(rec))

    # 1. paste lyrics, then time them
    open_import()
    check("three ways to add the words", pg.locator(".mi-seg [role=radio]").all_inner_texts() == ["Subtitle file", "YouTube’s transcript", "Paste and time it"])
    pg.get_by_role("radio", name="Paste and time it").click()
    pg.fill("#mi-lyrics", "خط اول\nخط دوم\nخط سوم\n\nبند دوم")
    pg.fill("#mi-title", "A song")
    pg.screenshot(path=str(OUT / "media-import.png"))
    pg.click("#mi-create")
    pg.wait_for_selector(".sync-line")
    check("pasted lines open the timing tool", pg.locator(".sync-line").count() == 4)
    pg.wait_for_function("document.querySelector('.sync-player audio')")
    pg.wait_for_function("document.querySelector('.sync-player audio').readyState >= 1")
    at = lambda sec: pg.evaluate(f"document.querySelector('.sync-player audio').currentTime = {sec}")
    pg.locator("#modal h2, #modal .m-title").first.click()   # focus away from any field
    for sec in (1, 4, 7):
        at(sec); pg.wait_for_timeout(80); pg.keyboard.press("Space")
    check("Space marks each line in turn", pg.locator(".sync-line.done").count() == 3 and pg.locator(".sync-line.cur").get_attribute("data-i") == "3")
    pg.keyboard.press("Backspace")
    check("Undo takes back the last line", pg.locator(".sync-line.done").count() == 2 and pg.locator(".sync-line.cur").get_attribute("data-i") == "2")
    check("…and saving waits until every line is timed", pg.is_disabled("#sync-save"))
    at(7.5); pg.wait_for_timeout(80); pg.click("#sync-mark")
    at(2); pg.wait_for_timeout(80); pg.click("#sync-mark")
    check("a mark before the line above is refused", "before the line above" in pg.inner_text("#toast") if pg.locator("#toast").count() else False)
    at(11); pg.wait_for_timeout(80); pg.click("#sync-mark")
    pg.screenshot(path=str(OUT / "media-sync.png"))
    pg.click("#sync-save")
    pg.wait_for_selector("#rtext p[data-cue]")
    cues = pg.evaluate("UI.reader.meta.cues")
    check("saved timings play along in the reader", [c[0] for c in cues] == [1000, 4000, 7500, 11000] and cues[0][1] == 4000 and cues[3][1] >= 14000, cues)
    check("…with a way to fix them later", pg.get_by_role("button", name="Fix timings").count() == 1)
    pg.get_by_role("button", name="Fix timings").click()
    pg.wait_for_selector(".sync-line.done")
    check("fixing starts from the saved timings", pg.locator(".sync-line.done").count() == 4)
    pg.locator(".sync-line").nth(2).locator(".sync-at").click()
    at(8); pg.wait_for_timeout(80); pg.click("#sync-mark")
    pg.click("#sync-save"); pg.wait_for_selector("#rtext p[data-cue]")
    check("one line's timing can be fixed", [c[0] for c in pg.evaluate("UI.reader.meta.cues")] == [1000, 4000, 8000, 11000])

    # 2. pasted, then left for later: the reader offers to time it
    open_import()
    pg.get_by_role("radio", name="Paste and time it").click()
    pg.fill("#mi-lyrics", "یک\nدو")
    pg.fill("#mi-title", "Later song")
    pg.click("#mi-create"); pg.wait_for_selector(".sync-line")
    pg.get_by_role("button", name="Later").click()
    lid = pg.evaluate("[...S.lessons.values()].find(m => m.title === 'Later song').id")
    pg.evaluate(f"openLesson('{lid}')"); pg.wait_for_selector("#rtext")
    check("an untimed text offers to time its lines", pg.get_by_role("button", name="Time the lines").count() == 1)

    # 3. YouTube's transcript, pasted
    open_import()
    pg.get_by_role("radio", name="YouTube’s transcript").click()
    pg.fill("#mi-trans", "Transcript\n0:00\n0 seconds\nسلام دوستان\n0:04\n4 seconds\nامروز درباره زبان\nحرف می‌زنیم\n0:09\nخداحافظ")
    pg.fill("#mi-title", "A talk")
    pg.click("#mi-create"); pg.wait_for_selector("#rtext p[data-cue]")
    check("a pasted transcript keeps its times", [c[0] for c in pg.evaluate("UI.reader.meta.cues")] == [0, 4000, 9000])
    check("…and its lines, without the screen-reader times", pg.locator("#rtext p[data-cue]").count() == 3 and "seconds" not in pg.inner_text("#rtext"))

    # 3b. the same panel copied in one go: times, times in words and text run together
    open_import()
    pg.get_by_role("radio", name="YouTube’s transcript").click()
    pg.fill("#mi-trans", "جستجوی ترانویسی\n0:000 ثانیهاگر به کره زمین نگاه کنید\n0:099 ثانیهنمی‌کنه بلکه هیچ موجود\n0:5454 ثانیه[موسیقی]\n1:011 دقیقه و 1 ثانیهقبل از اینکه ویدیو رو شروع کنیم\n4:004 دقیقهبه طور متوسط در هر سال")
    pg.fill("#mi-title", "Run together")
    pg.click("#mi-create"); pg.wait_for_selector("#rtext p[data-cue]")
    check("a transcript copied in one go is read too", [c[0] for c in pg.evaluate("UI.reader.meta.cues")] == [0, 9000, 61000, 240000], pg.evaluate("UI.reader.meta.cues"))
    txt = pg.inner_text("#rtext")
    check("…without the times in words or [Music]", "ثانیه" not in txt and "دقیقه" not in txt and "موسیقی" not in txt and "اگر به کره زمین" in txt, txt[:200])

    # 3c. the playing line stays in view below the player, in a short window, in both fonts
    long = "\n".join(f"0:{i:02d}\n" + f"خط شماره {i} " + "این یک خط آزمایشی است که باید زیر پخش‌کننده دیده شود " * 2 for i in range(19))
    open_import()
    pg.get_by_role("radio", name="YouTube’s transcript").click()
    pg.fill("#mi-trans", long); pg.fill("#mi-title", "Long one")
    pg.click("#mi-create"); pg.wait_for_selector("#rtext p[data-cue]")
    pg.wait_for_selector("#player audio")
    # as tall as a YouTube video with its buttons (the test can't load YouTube itself)
    pg.add_style_tag(content="#player audio { height: 280px; }")
    for font in ("nastaliq", "sans"):
        pg.evaluate(f"setSettings({{ font: '{font}' }}); applyReadingPrefs()")
        pg.set_viewport_size({"width": 1365, "height": 640})
        for i in (6, 12, 17):
            pg.evaluate("UI.reader.el.play()"); pg.wait_for_timeout(150)
            pg.evaluate(f"UI.reader.el.currentTime = {i}.3")
            pg.wait_for_timeout(1300)
            box = pg.evaluate(f"""(() => {{
              const p = document.querySelector('#rtext p.now').getBoundingClientRect();
              const pl = document.querySelector('#player').getBoundingClientRect();
              const f = document.querySelector('.rfoot').getBoundingClientRect();
              return [p.top, p.bottom, pl.bottom, f.top];
            }})()""")
            pg.evaluate("UI.reader.el.pause()")
            check(f"the playing line (from {i}) is in full view below the player ({font})", box[0] >= box[2] - 1 and box[1] <= box[3] + 1, box)
    pg.screenshot(path=str(OUT / "media-follow.png"))

    # where you left off: the recording's time and line, after closing and reopening the page
    pg.evaluate("UI.reader.el.play()"); pg.wait_for_timeout(150)
    pg.evaluate("UI.reader.el.currentTime = 11.4"); pg.wait_for_timeout(400)
    pg.evaluate("UI.reader.el.pause()"); pg.wait_for_timeout(200)
    long_id = pg.evaluate("UI.reader.meta.id")
    pg.wait_for_timeout(1000)
    check("pausing saves the time", abs(pg.evaluate("UI.reader.meta.at.t") - 11500) < 900, pg.evaluate("UI.reader.meta.at"))
    pg.goto(URL + "#library"); pg.reload(); pg.wait_for_selector("#lib-continue")
    check("the library offers to continue", "long one" in pg.inner_text("#lib-continue").lower() and "at 0:11" in pg.inner_text("#lib-continue"), pg.inner_text("#lib-continue"))
    pg.click("#lib-continue")
    pg.wait_for_function("UI.reader && UI.reader.el && UI.reader.el.currentTime > 10", timeout=8000)
    pg.wait_for_timeout(700)
    box = pg.evaluate("""(() => { const p = document.querySelector('#rtext p.now'); const r = p.getBoundingClientRect();
      return [+p.dataset.cue, r.top, r.bottom, document.querySelector('#player').getBoundingClientRect().bottom, document.querySelector('.rfoot').getBoundingClientRect().top]; })()""")
    check("reopening a recording goes back to its time and line", box[0] == 11 and box[1] >= box[3] - 1 and box[2] <= box[4] + 1, box)
    pg.set_viewport_size({"width": 430, "height": 900})

    # where you left off in a long text without a recording
    pg.goto(URL + "#library"); pg.wait_for_selector("#view")
    pg.evaluate("""(async () => { const t = Array.from({ length: 60 }, (_, i) => `پاراگراف شماره ${i}: ` + 'این متن برای آزمایش جای خواندن است. '.repeat(8)).join('\\n');
      const m = await createLesson(L().code, 'Long read', t, ''); putLesson(m); openLesson(m.id); })()""")
    pg.wait_for_selector("#rtext p")
    pg.evaluate("(() => { const ps = document.querySelectorAll('#rtext > p'); ps[Math.floor(ps.length / 2)].scrollIntoView({ block: 'start' }); })()")
    pg.wait_for_timeout(2000)
    seen = pg.evaluate("UI.reader.meta.at && UI.reader.meta.at.p")
    check("stopping scrolling saves the place", seen is not None and seen >= 1, pg.evaluate("UI.reader.meta.at"))
    pg.goto(URL + "#library"); pg.reload(); pg.wait_for_selector("#lib-continue"); pg.click("#lib-continue"); pg.wait_for_selector("#rtext p"); pg.wait_for_timeout(500)
    first = pg.evaluate("""(() => { const top = readerTopBound(); for (const el of document.querySelectorAll('#rtext > p')) if (el.getBoundingClientRect().bottom > top + 4) return +el.querySelector('[data-p]').dataset.p; })()""")
    check("reopening a text goes back to the same lines", first == seen, [first, seen])

    # 4. lyrics need something to time them against
    pg.goto(URL + "#library"); pg.wait_for_selector("#view")
    pg.get_by_role("button", name="Audio or video").click(); pg.wait_for_selector("#mi-lang")
    pg.get_by_role("radio", name="Paste and time it").click()
    pg.fill("#mi-lyrics", "یک"); pg.click("#mi-create")
    check("timing needs a recording or a YouTube link", "Choose a recording or paste a YouTube link" in pg.inner_text("#modal .error"))
    b.close()

check("no errors", not errors, errors[:5])
print(f"\n{len(fails)} failures")
for f in fails: print(" -", f)
srv.shutdown()

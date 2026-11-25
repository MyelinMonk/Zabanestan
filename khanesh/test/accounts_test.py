"""Accounts in the website copy, with a stand-in Supabase (test/mock_supabase.js) whose data lives here,
shared by three browser profiles: A shares things, B uses them signed out, T reviews for the team.
Run  python3 build.py --site  first. Nothing may be fetched from another host."""
import functools, http.server, json, re, shutil, tempfile, threading
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out"
OUT.mkdir(exist_ok=True)
serve = Path(tempfile.mkdtemp())
base = serve / "Zabanestan"
shutil.copytree(ROOT / "dist" / "site", base / "khanesh")
(base / "reader.html").write_text('<!doctype html><title>Reader guide</title><h2 id="ocr">OCR</h2>')
if (ROOT.parent / "images").exists():
    shutil.copytree(ROOT.parent / "images", base / "images")  # the site's icons and emblem, which the reader links to


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8771), functools.partial(Quiet, directory=str(serve)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
HOST = "http://127.0.0.1:8771"
URL = HOST + "/Zabanestan/khanesh/"
MOCK = (ROOT / "test" / "mock_supabase.js").read_text()
DB = {"json": json.dumps({"users": {}, "profiles": {}, "resources": [], "files": {}, "reader_docs": {}, "glosses": [], "gloss_reports": []})}
fails, outside, errors, missing = [], [], [], []

STRAY_JS = """() => { const w = document.createTreeWalker(document.querySelector('#view'), NodeFilter.SHOW_TEXT); const out = []; let n;
  while ((n = w.nextNode())) if (/^(null|undefined|false|true|\\[object [A-Za-z]+\\])$/.test(n.textContent.trim())) out.push(n.textContent.trim() + ' in ' + n.parentElement.tagName);
  return out; }"""


def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{str(info)[:300]}]" if info and not cond else ""))
    if not cond:
        fails.append(name)


def db():
    return json.loads(DB["json"])


def put_db(d):
    DB["json"] = json.dumps(d)


def profile(b, user):
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, accept_downloads=True)
    ctx.add_init_script(f"localStorage.setItem('mock-user', {json.dumps(user)})")
    ctx.expose_function("__mockLoad", lambda: DB["json"])
    ctx.expose_function("__mockSave", lambda s: DB.__setitem__("json", s))

    def outside_or_local(r):
        if r.request.url.startswith(HOST):
            r.continue_()
        else:
            outside.append(r.request.url)
            r.abort()

    def page_with_accounts(r):  # the site's config, with a Supabase project filled in
        resp = r.fetch()
        body = re.sub(r'"supabase": \{[^}]*\}', '"supabase": {"url": "https://mock.supabase.co", "key": "mock-publishable-key"}', resp.text(), count=1)
        if '"supabase"' not in body:
            body = body.replace("window.KH_SITE = {", 'window.KH_SITE = {"supabase": {"url": "https://mock.supabase.co", "key": "mock-publishable-key"}, ', 1)
        r.fulfill(response=resp, body=body)

    ctx.route("**/*", outside_or_local)
    ctx.route(lambda u: urlparse(u).path in ("/Zabanestan/khanesh/", "/Zabanestan/khanesh/index.html"), page_with_accounts)
    ctx.route("**/khanesh/lib/supabase/supabase.js", lambda r: r.fulfill(body=MOCK, content_type="text/javascript"))
    pg = ctx.new_page()
    pg.on("console", lambda m: errors.append(f"{user}: {m.text}") if m.type == "error" and not ("404" in m.text and not (ROOT.parent / "images").exists()) else None)
    pg.on("pageerror", lambda e: errors.append(f"{user}: {e}"))
    pg.on("response", lambda r: missing.append(f"{r.status} {r.url}") if r.status >= 400 and not ("/images/" in r.url and not (ROOT.parent / "images").exists()) else None)
    return pg


def sign_in(pg, email):
    pg.goto(URL + "#account")
    pg.get_by_role("button", name="Sign in with Google").click()
    pg.wait_for_selector(f"text=Signed in with Google as {email}", timeout=15000)


def share(pg, *, vis, license=None, source=None, title=None, rights=True):
    m = pg.locator("#modal")
    if title is not None:
        m.locator("#sh-title").fill(title)
    if source is not None:
        m.locator("#sh-source").fill(source)
    if license:
        m.locator("#sh-license").select_option(license)
    m.locator(f"#sh-vis-{vis}").check()
    note = m.locator("#sh-public-note")
    check(f"sharing {vis}: the note on learning materials shows only for everyone",
          note.is_visible() == (vis == "public") and "learning materials" in note.inner_text())
    if rights and vis != "private":
        m.locator("#sh-rights").check()
    pg.evaluate("document.querySelectorAll('dl.facts').forEach(d => { d.dataset.old = 1; })")
    m.get_by_role("button", name=re.compile("^(Share|Save)$")).click()
    pg.wait_for_selector("#modalWrap", state="hidden", timeout=15000)
    pg.wait_for_function("/^#r-[0-9a-f-]{36}$/.test(location.hash)", timeout=15000)
    pg.wait_for_selector("dl.facts:not([data-old])")
    return pg.evaluate("location.hash.slice(3)")


def fact(pg, name):
    return pg.evaluate("n => { const dt = [...document.querySelectorAll('dl.facts dt')].find(d => d.textContent === n); return dt ? dt.nextElementSibling.textContent : null; }", name)


with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])

    # A: signs in and shares
    a = profile(b, "A")
    a.goto(URL)
    a.wait_for_selector(".tiles")
    check("library offers the shared library", a.get_by_role("button", name="Shared library").count() == 1)
    a.goto(URL + "#options")
    a.wait_for_selector("#view h2.sec")
    check("options explain accounts are optional", "Optional. Sign in" in a.inner_text("#view"))
    check("options: no stray text", not a.evaluate(STRAY_JS), a.evaluate(STRAY_JS))
    sign_in(a, "a@example.com")
    check("back from Google, the address is tidy", "code=" not in a.url and a.url.endswith("#account"), a.url)
    a.fill("#ac-name", "Darya")
    a.get_by_role("button", name="Save name").click()
    a.wait_for_timeout(300)
    check("name saved", db()["profiles"]["A"]["display_name"] == "Darya")
    check("account: no stray text", not a.evaluate(STRAY_JS), a.evaluate(STRAY_JS))
    a.screenshot(path=str(OUT / "acct-account.png"))

    a.evaluate("""async () => {
      await createLesson('fa', 'گلستان سعدی', 'بنی آدم اعضای یکدیگرند\\nکه در آفرینش ز یک گوهرند', '');
      await createLesson('fa', 'یادداشت', 'متن خصوصی من', '');
      for (const [w, m] of [['آدم', 'person'], ['گوهر', 'jewel'], ['آفرینش', 'creation']]) putEntry('fa', w, { s: 1, f: w, m, c: newCard() });
    }""")
    a.goto(URL + "#library")
    a.wait_for_selector(".lesson-wrap")
    a.get_by_role("button", name="Options for گلستان سعدی").click()
    a.get_by_role("button", name="Share…").click()
    a.wait_for_selector("#sh-title")
    check("share form starts private, title filled", a.is_checked("#sh-vis-private") and a.input_value("#sh-title") == "گلستان سعدی")
    a.check("#sh-vis-public")
    a.locator("#modal").get_by_role("button", name="Share").click()
    check("public needs a license", "Choose a license" in a.inner_text("#modal .error"))
    a.select_option("#sh-license", "Public domain")
    a.locator("#modal").get_by_role("button", name="Share").click()
    check("public needs the rights", "right to share" in a.inner_text("#modal .error"))
    a.check("#sh-rights")
    a.locator("#modal").get_by_role("button", name="Share").click()
    check("public needs a source", "where it comes from" in a.inner_text("#modal .error"))
    a.screenshot(path=str(OUT / "acct-share.png"))
    text_id = share(a, vis="public", source="Saadi, Golestan (1258)")
    check("public text waits for review", fact(a, "Visibility") == "Public, waiting for review", fact(a, "Visibility"))
    check("shared by the chosen name", fact(a, "Shared by") == "Darya")

    a.goto(URL + "#words")
    a.wait_for_selector("#wlist")
    a.get_by_role("button", name="Share a word list").click()
    a.wait_for_selector("#sh-which-cards")
    list_id = share(a, vis="unlisted", license="CC BY-SA 4.0")
    check("word list shared unlisted", fact(a, "Visibility") == "Unlisted" and fact(a, "Words") == "3", (fact(a, "Visibility"), fact(a, "Words")))

    a.goto(URL + "#account")
    a.get_by_role("button", name="Share an OCR model").click()
    a.set_input_files("#sh-file", files=[{"name": "naskh.safetensors", "mimeType": "application/octet-stream", "buffer": bytes(range(256)) * 8}])
    a.select_option("#sh-lang", "fa")
    model_id = share(a, vis="unlisted", license="CC BY 4.0", title="Naskh print", source="300 lines of Golestan prints")
    check("model shared with its file", fact(a, "File") == "naskh.safetensors · 2 KB" and len(db()["files"]) == 1, fact(a, "File"))

    a.goto(URL + "#library")
    a.wait_for_selector(".lesson-wrap")
    a.get_by_role("button", name="Options for یادداشت").click()
    a.get_by_role("button", name="Share…").click()
    private_id = share(a, vis="private")
    check("private text kept", fact(a, "Visibility") == "Private")
    a.goto(URL + "#account")
    a.wait_for_selector("#ac-mine a.lesson")
    rows = a.locator("#ac-mine a.lesson").all_inner_texts()
    check("account lists all four", len(rows) == 4 and any("Public, waiting for review" in r for r in rows) and sum("Unlisted" in r for r in rows) == 2 and any("Private" in r for r in rows), rows)

    # B: signed out, opens links
    bb = profile(b, "B")
    bb.goto(URL + "#r-" + list_id)
    bb.wait_for_selector("dl.facts")
    check("unlisted list opens by link", bb.inner_text("#view h2.r-title") == "Persian words")
    check("resource page: no stray text", not bb.evaluate(STRAY_JS), bb.evaluate(STRAY_JS))
    bb.screenshot(path=str(OUT / "acct-resource.png"))
    bb.get_by_role("button", name="Add these words").click()
    bb.wait_for_selector("#wi-text")
    check("words arrive in the import form, as learning", bb.input_value("#wi-text").count("\t") == 3 and bb.is_checked("#wi-as-learning"), bb.input_value("#wi-text"))
    bb.locator("#modal").get_by_role("button", name="Import").click()
    bb.wait_for_timeout(400)
    got = bb.evaluate("[...vmap('fa').values()].filter(e => e.s === 1 && e.m).map(e => e.m).sort()")
    check("shared words added with meanings", got == ["creation", "jewel", "person"], got)
    bb.goto(URL + "#r-" + text_id)
    bb.wait_for_selector("dl.facts")
    check("public text opens by link while it waits", "گلستان سعدی" in bb.inner_text("#view h2.r-title") and fact(bb, "Visibility") is None)
    bb.goto(URL + "#shared")
    bb.wait_for_selector("#sh-list .empty")
    check("not in the library before review", "Nothing has been shared in Persian yet" in bb.inner_text("#sh-list"))
    bb.goto(URL + "#r-" + model_id)
    bb.wait_for_selector("dl.facts")
    with bb.expect_download() as dl:
        bb.get_by_role("button", name="Download the model").click()
    d = dl.value
    check("model downloads with its name", d.suggested_filename == "naskh.safetensors" and Path(d.path()).stat().st_size == 2048, d.suggested_filename)
    bb.goto(URL + "#r-" + private_id)
    bb.wait_for_selector("text=Nothing here")
    check("private link opens nothing for others", True)
    bb.goto(URL + "#r-" + text_id)
    bb.wait_for_selector("dl.facts")
    check("others don't get owner buttons", bb.get_by_role("button", name="Edit").count() == 0 and bb.get_by_role("button", name="Delete").count() == 0)

    # T: the review team
    t = profile(b, "T")
    sign_in(t, "t@example.com")
    d_ = db()
    d_["profiles"]["T"]["is_moderator"] = True
    put_db(d_)
    t.reload()
    t.wait_for_selector("#ac-queue a.lesson", timeout=15000)
    q = t.locator("#ac-queue a.lesson").all_inner_texts()
    check("review queue shows the public text, with the name", len(q) == 1 and "گلستان سعدی" in q[0] and "Darya" in q[0], q)
    check("review queue: no stray text", not t.evaluate(STRAY_JS), t.evaluate(STRAY_JS))
    t.screenshot(path=str(OUT / "acct-queue.png"))
    t.locator("#ac-queue a.lesson").first.click()
    t.wait_for_selector("text=Waiting for review.")
    check("reviewers can't edit", t.get_by_role("button", name="Edit").count() == 0)
    t.get_by_role("button", name="Approve", exact=True).click()
    t.wait_for_selector("text=Approved: it’s in the shared library.")
    check("approved", db()["resources"][0]["review"] == "approved")

    # B: finds it in the library and reads it
    bb.goto(URL + "#shared")
    bb.wait_for_selector("#sh-list a.lesson")
    lib = bb.locator("#sh-list a.lesson").all_inner_texts()
    check("approved text in the library, unlisted ones not", len(lib) == 1 and "گلستان سعدی" in lib[0], lib)
    check("shared library: no stray text", not bb.evaluate(STRAY_JS), bb.evaluate(STRAY_JS))
    bb.screenshot(path=str(OUT / "acct-library.png"))
    bb.locator("#sh-list a.lesson").first.click()
    bb.get_by_role("button", name="Add to my library").click()
    bb.wait_for_selector("#rtext .w")
    check("shared text opens in the reader", "بنی" in bb.inner_text("#rtext"))
    bb.goto(URL + "#r-" + text_id)
    bb.get_by_role("button", name="Add to my library").click()
    bb.wait_for_selector("#rtext .w")
    check("adding twice opens the same copy", bb.evaluate("[...S.lessons.values()].filter(m => !m.del && m.src.startsWith('shared:')).length") == 1)

    # A edits it: back to review; T doesn't approve, with a note
    a.goto(URL + "#r-" + text_id)
    a.get_by_role("button", name="Edit").click()
    a.fill("#sh-desc", "The famous lines on humanity")
    share(a, vis="public")
    check("editing a public text sends it back for review", fact(a, "Visibility") == "Public, waiting for review")
    t.goto(URL + "#r-" + text_id)
    t.get_by_role("button", name="Don’t approve").click()
    t.fill("#rv-note", "Please add the edition")
    t.locator("#modal").get_by_role("button", name="Send").click()
    t.wait_for_selector("text=Not approved.")
    a.goto(URL + "#account")
    a.wait_for_selector("#ac-mine .l-meta.warn")
    check("owner sees the note", a.inner_text("#ac-mine .l-meta.warn") == "Not approved: Please add the edition")

    # S: reading saved to the account and shared between two devices
    SYNCED = "Cloud.state === 'ready' && !Sync.has() && !Sync.running"
    s1 = profile(b, "S")
    s1.goto(URL)
    s1.wait_for_selector(".tiles")
    s1.evaluate("""async () => {
      await createLesson('fa', 'شاهنامه', 'توانا بود هر که دانا بود\\nز دانش دل پیر برنا بود', '');
      putEntry('fa', 'دانا', { s: 1, f: 'دانا', m: 'wise', c: newCard() });
      putEntry('fa', 'توانا', { s: 1, f: 'توانا', m: 'able', c: newCard() });
    }""")
    s1.wait_for_timeout(2500)
    check("signed out, the reader saves only in the browser", s1.evaluate("Cloud.state") == "local" and not [k for k in db().get("reader_docs", {}) if k.startswith("S/")])
    s1.goto(URL + "#options")
    s1.wait_for_selector("#view h2.sec")
    check("options offer signing in to save reading", "Sign in to save them to your account" in s1.inner_text("#view") and s1.get_by_role("button", name="Sign in with Google").count() >= 1)
    sign_in(s1, "s@example.com")
    s1.wait_for_function(SYNCED, timeout=20000)
    docs = {k.split("/", 1)[1]: v["data"] for k, v in db().get("reader_docs", {}).items() if v["owner"] == "S"}
    words = {k for d in docs.values() if d.get("t") == "v" for k in d.get("w", {})}
    check("signing in uploads what was in the browser", "settings" in docs and any(k.startswith("lt.") for k in docs) and any(d.get("t") == "lm" and d.get("title") == "شاهنامه" for d in docs.values()) and {"دانا", "توانا"} <= words, (sorted(docs)[:8], words))
    s1.goto(URL + "#options")
    s1.wait_for_selector("#opt-sync")
    check("options say reading is saved to the account", "saved to your account, privately" in s1.inner_text("#view") and s1.inner_text("#opt-sync") == "Saved to your account", s1.inner_text("#opt-sync"))
    check("options: no stray text when synced", not s1.evaluate(STRAY_JS), s1.evaluate(STRAY_JS))

    s2 = profile(b, "S")  # the same person on another device, with a word of its own
    s2.goto(URL)
    s2.wait_for_selector(".tiles")
    s2.evaluate("putEntry('fa', 'دانش', { s: 1, f: 'دانش', m: 'knowledge', c: newCard() })")
    s2.wait_for_timeout(1000)
    sign_in(s2, "s@example.com")
    s2.wait_for_function(SYNCED, timeout=20000)
    s2.evaluate("ensureLang('fa')")
    s2.wait_for_function("entry('fa', 'دانا') && entry('fa', 'توانا')", timeout=10000)
    check("the other device gets the words", s2.evaluate("entry('fa', 'دانا').m") == "wise")
    s2.wait_for_function(SYNCED, timeout=20000)
    words = {k for k, v in db()["reader_docs"].items() if v["owner"] == "S" and v["data"].get("t") == "v" for k in v["data"].get("w", {})}
    check("and its own word joins the account", "دانش" in words, words)
    s2.goto(URL + "#library")
    s2.wait_for_selector(".lesson-wrap")
    s2.locator(".lesson", has_text="شاهنامه").first.click()
    s2.wait_for_selector("#rtext .w")
    check("the other device opens the text", "دانا" in s2.inner_text("#rtext"))
    s1.evaluate("putEntry('fa', 'دانا', { m: 'wise, learned' })")
    s1.wait_for_function(SYNCED, timeout=20000)
    s2.goto(URL + "#words")
    s2.reload()
    s2.wait_for_function(SYNCED, timeout=20000)
    s2.evaluate("ensureLang('fa')")
    s2.wait_for_function("entry('fa', 'دانا') && entry('fa', 'دانا').m === 'wise, learned'", timeout=10000)
    check("a change on one device reaches the other", True)
    s2.goto(URL + "#account")
    s2.wait_for_selector("text=A copy also stays in this browser")
    s2.get_by_role("button", name="Sign out").click()
    s2.wait_for_function("!Acct.user", timeout=10000)
    check("signing out goes back to this browser, keeping its copy", s2.evaluate("Cloud.state") == "local" and s2.evaluate("entry('fa', 'دانا').m") == "wise, learned")
    n_calls = s2.evaluate("window.__readerCalls || 0")
    s2.evaluate("putEntry('fa', 'برنا', { s: 1, f: 'برنا', m: 'young' })")
    s2.wait_for_timeout(2500)
    check("signed out, changes stay in the browser", s2.evaluate("window.__readerCalls || 0") == n_calls and not any("برنا" in v["data"].get("w", {}) for v in db()["reader_docs"].values()))
    s2.screenshot(path=str(OUT / "acct-signed-out.png"))
    check("A's reading reached A's account too", any(v["owner"] == "A" for v in db()["reader_docs"].values()))

    # Q: an account that fills up. (Small limits here: texts 3,000 characters, everything 20,000.)
    SYNCED_Q = "Cloud.state === 'ready' && !Sync.has() && !Sync.running"
    q = profile(b, "Q")
    sign_in(q, "q@example.com")
    q.wait_for_function(SYNCED_Q, timeout=20000)
    q.evaluate("window.__readerTextQuota = 3000; window.__readerQuota = 20000")
    q.evaluate("createLesson('fa', 'کوتاه', 'سلام دنیا. '.repeat(150), '')")
    q.wait_for_function(SYNCED_Q, timeout=20000)
    qdocs = lambda: {k.split("/", 1)[1]: v["data"] for k, v in db()["reader_docs"].items() if v["owner"] == "Q"}
    check("a text that fits goes to the account", any(d.get("t") == "lm" and d.get("title") == "کوتاه" for d in qdocs().values()))
    q.evaluate("createLesson('fa', 'بلند', 'کتاب بزرگ. '.repeat(200), '')")
    q.wait_for_function("Sync.held.size === 1 && !Sync.running", timeout=20000)
    big_id = q.evaluate("[...Sync.held][0]")
    check("a text that doesn't fit stays on the device, without its record in the account",
          not any(k.startswith("lt." + big_id) or k == "lm." + big_id for k in qdocs()), sorted(qdocs()))
    check("the status says the account is full", "Account full · 1 text saved here only" in q.evaluate("syncLabel()[1]"), q.evaluate("syncLabel()[1]"))
    q.evaluate("putEntry('fa', 'دنیا', { s: 1, f: 'دنیا', m: 'world', c: newCard() })")
    q.wait_for_function("!Sync.has() && !Sync.running", timeout=20000)
    check("words still sync when texts don't fit", any("دنیا" in d.get("w", {}) for d in qdocs().values() if d.get("t") == "v"))
    q.goto(URL + "#library")
    q.wait_for_selector(".lesson-wrap")
    check("the library marks the text that's only here", "on this device only" in q.locator(".lesson", has_text="بلند").first.inner_text()
          and "on this device only" not in q.locator(".lesson", has_text="کوتاه").first.inner_text())
    check("the library suggests a backup", "Your account is full" in q.inner_text("#view .notice"))
    q.screenshot(path=str(OUT / "acct-full-library.png"))
    q.goto(URL + "#options")
    q.wait_for_selector("#opt-usage:not([hidden])", timeout=10000)
    usage = q.inner_text("#opt-usage")
    check("options show storage use, the largest texts and what to do", "of 20 KB in your account" in usage and "no room for more texts" in usage and "کوتاه" in usage and "delete texts" in usage, usage)
    check("options: no stray text when full", not q.evaluate(STRAY_JS), q.evaluate(STRAY_JS))
    q.screenshot(path=str(OUT / "acct-full-options.png"), full_page=True)
    q.evaluate("deleteLesson([...S.lessons.values()].find(m => m.title === 'کوتاه').id); Sync.kick(100)")
    q.wait_for_function("Sync.held.size === 0 && !Sync.has() && !Sync.running", timeout=20000)
    docs = qdocs()
    check("deleting a text makes room, and the waiting text goes up with its record",
          any(k.startswith("lt." + big_id) for k in docs) and docs.get("lm." + big_id, {}).get("title") == "بلند", sorted(docs))
    check("the status is back to normal", q.evaluate("syncLabel()[1]") == "Saved to your account")
    q.evaluate("window.__readerQuota = 1")
    q.evaluate("putEntry('fa', 'سلام', { s: 1, f: 'سلام', m: 'hello' })")
    q.wait_for_function("Sync.full && !Sync.running", timeout=20000)
    check("when nothing fits, the status says changes stay here", "new changes saved here only" in q.evaluate("syncLabel()[1]"))
    q.evaluate("window.__readerQuota = 20000; putEntry('fa', 'سلام', { m: 'hello!' })")
    q.wait_for_function("!Sync.full && !Sync.has() && !Sync.running", timeout=20000)
    check("and syncing resumes once there's room", any(d.get("w", {}).get("سلام") for d in qdocs().values() if d.get("t") == "v"))

    # G shares meanings; H, on another computer, sees them as suggestions and under words
    TEXT = "کتاب روی میز است. کتاب خوب است."
    g = profile(b, "G")
    sign_in(g, "g@example.com")
    g.wait_for_function("Cloud.state === 'ready' && !Sync.running", timeout=20000)
    g.evaluate(f"createLesson('fa', 'میز و کتاب', {json.dumps(TEXT)}, '')")
    g.goto(URL + "#library"); g.wait_for_selector(".lesson-wrap")
    g.locator(".lesson", has_text="میز و کتاب").first.click()
    g.wait_for_selector("#rtext .w")
    g.locator("#rtext .w", has_text="کتاب").first.click()
    g.wait_for_selector("#f-sh")
    check("sharing is off by default", not g.is_checked("#f-sh"))
    g.fill("#f-m", "book")
    g.click(".sh-more summary")
    g.fill("#f-dl", "Tehran"); g.fill("#f-sr", "Dehkhoda")
    check("no Persian-equivalent field for Persian itself", g.locator("#f-fa").count() == 0)
    g.check("#f-sh")
    g.wait_for_selector("#modal")
    notice = g.inner_text("#modal")
    check("sharing first explains that meanings may go into dictionaries", "learning materials, such as dictionaries" in notice and "CC BY-SA 4.0" in notice and "without your name" in notice, notice)
    g.locator("#modal").get_by_role("button", name="Share").click()
    gl = lambda: [x for x in db().get("glosses", []) if x["author"] == "G"]
    g.wait_for_function("!Object.keys(S.meta.glossQ || {}).length", timeout=10000)
    shared = gl()
    check("the meaning, dialect and source are shared", len(shared) == 1 and shared[0]["meaning"] == "book" and shared[0]["dialect"] == "Tehran" and shared[0]["source"] == "Dehkhoda" and shared[0]["lang"] == "fa", shared)
    check("word panel: no stray text", not g.evaluate(STRAY_JS), g.evaluate(STRAY_JS))
    g.screenshot(path=str(OUT / "gloss-share.png"))
    g.keyboard.press("Escape")
    k_miz = g.evaluate("[...UI.reader.spans.keys()].find(k => k.includes('میز'))")
    g.evaluate(f"putEntry('fa', {json.dumps(k_miz)}, {{ m: 'table', s: 1, sh: 1, f: 'میز' }}); glossQueue('fa', {json.dumps(k_miz)})")
    g.wait_for_function("!Object.keys(S.meta.glossQ || {}).length", timeout=10000)

    h2 = profile(b, "H")  # not signed in: suggestions are for everyone
    h2.goto(URL); h2.wait_for_selector(".tiles")
    h2.evaluate(f"createLesson('fa', 'میز و کتاب', {json.dumps(TEXT)}, '')")
    h2.goto(URL + "#library"); h2.wait_for_selector(".lesson-wrap")
    h2.locator(".lesson", has_text="میز و کتاب").first.click()
    h2.wait_for_selector("#rtext .w")
    h2.locator("#rtext .w", has_text="کتاب").first.click()
    h2.wait_for_selector(".gl-item", timeout=10000)
    item = h2.inner_text(".gl-item")
    check("another learner sees the shared meaning with its details", "from other learners" in h2.inner_text("#f-gl").lower() and "book" in item and "1 person" in item and "Dialect: Tehran" in item and "Source: Dehkhoda" in item, item)
    h2.locator(".gl-item").get_by_role("button", name="Use this").click()
    check("using a suggestion fills in the meaning and its details", h2.input_value("#f-m") == "book" and h2.input_value("#f-dl") == "Tehran" and h2.input_value("#f-sr") == "Dehkhoda")
    check("using a suggestion doesn't share it back", h2.evaluate("!entry('fa', UI.sheet.key).sh"))
    h2.screenshot(path=str(OUT / "gloss-suggestion.png"))
    h2.keyboard.press("Escape")
    h2.evaluate("setSettings({ gloss: 'shared' }); renderPage(true)")
    h2.wait_for_function("[...document.querySelectorAll('#rtext .w')].some(w => w.dataset.gs === 'shared')", timeout=10000)
    gl_state = h2.evaluate("[...document.querySelectorAll('#rtext .w')].map(w => [w.textContent, w.dataset.g || '', w.dataset.gs || ''])")
    check("interlinear: your own meaning, then other learners'", ["کتاب", "book", "own"] in gl_state and ["میز", "table", "shared"] in gl_state, gl_state)
    check("interlinear: words with no meaning stay bare", ["روی", "", ""] in gl_state, gl_state)
    h2.screenshot(path=str(OUT / "gloss-interlinear.png"))
    h2.evaluate("setSettings({ gloss: 'off' }); renderPage(true)")
    check("interlinear can be switched off", not h2.evaluate("document.querySelector('#rtext').classList.contains('glossed')"))
    sign_in(h2, "h@example.com")
    h2.goto(URL + "#library"); h2.wait_for_selector(".lesson-wrap")
    check("signing in right after changes keeps them (the browser saves before leaving for Google)", h2.locator(".lesson", has_text="میز و کتاب").count() == 1)
    h2.locator(".lesson", has_text="میز و کتاب").first.click()
    h2.wait_for_selector("#rtext .w")
    h2.locator("#rtext .w", has_text="میز").first.click()
    h2.wait_for_selector(".gl-item")
    votes = h2.locator(".gl-item .gl-vote")
    check("each suggestion has up and down votes", votes.count() == 2 and votes.nth(0).get_attribute("aria-label") == "Good meaning (0)" and votes.nth(1).get_attribute("aria-label") == "Not right (0)")
    votes.nth(0).click()
    h2.wait_for_function("document.querySelector('.gl-item .gl-vote').getAttribute('aria-pressed') === 'true'")
    check("voting a meaning up counts it", h2.locator(".gl-item .gl-vote").nth(0).get_attribute("aria-label") == "Good meaning (1)" and [v["vote"] for v in db().get("gloss_votes", [])] == [1], db().get("gloss_votes"))
    h2.locator(".gl-item .gl-vote").nth(1).click()
    h2.wait_for_function("document.querySelectorAll('.gl-item .gl-vote')[1].getAttribute('aria-pressed') === 'true'")
    check("voting down replaces your up vote", h2.locator(".gl-item .gl-vote").nth(0).get_attribute("aria-label") == "Good meaning (0)" and [v["vote"] for v in db().get("gloss_votes", [])] == [-1])
    h2.screenshot(path=str(OUT / "gloss-votes.png"))
    h2.locator(".gl-item .gl-vote").nth(1).click()
    h2.wait_for_function("document.querySelectorAll('.gl-item .gl-vote')[1].getAttribute('aria-pressed') === 'false'")
    check("tapping your vote again takes it back", db().get("gloss_votes", []) == [])
    h2.locator(".gl-item").get_by_role("button", name="Report").click()
    h2.locator("#modal").get_by_role("button", name="Report").click()
    h2.wait_for_selector("text=The team will take a look")
    check("a member can report a shared meaning", len(db().get("gloss_reports", [])) == 1)
    check("a report doesn't hide the meaning", not any(x.get("hidden") for x in db().get("glosses", [])))
    h2.keyboard.press("Escape")
    h2.goto(URL + "#options"); h2.wait_for_selector("#o-share")
    check("options offer sharing everything, with the notice", "learning materials, such as dictionaries" in h2.inner_text("#view") and not h2.is_checked("#o-share"))
    # G stops sharing a word
    g.goto(URL + "#library"); g.wait_for_selector(".lesson-wrap")
    g.locator(".lesson", has_text="میز و کتاب").first.click()
    g.wait_for_selector("#rtext .w")
    g.locator("#rtext .w", has_text="کتاب").first.click()
    g.wait_for_selector("#f-sh")
    check("a shared word shows as shared", g.is_checked("#f-sh"))
    g.uncheck("#f-sh")
    g.wait_for_function("!Object.keys(S.meta.glossQ || {}).length", timeout=10000)
    check("unsharing takes it back", [x["meaning"] for x in gl()] == ["table"], gl())

    # G deletes every shared meaning from the account page: the words, meanings and account stay
    g.goto(URL + "#account"); g.wait_for_selector("#ac-del-shared")
    g.screenshot(path=str(OUT / "account-data.png"), full_page=True)
    before_words = g.evaluate("[...vmap('fa').values()].filter(e => !e.d && e.m).length")
    g.click("#ac-del-shared")
    g.locator("#modal").get_by_role("button", name="Delete shared meanings").click()
    g.wait_for_selector("text=Deleted 1 shared meaning", timeout=10000)
    check("deleting shared meanings removes them from the shared list", gl() == [], gl())
    check("…and unmarks your words, keeping them and their meanings",
          g.evaluate("[...vmap('fa').values()].filter(e => e.sh).length") == 0 and g.evaluate("[...vmap('fa').values()].filter(e => !e.d && e.m).length") == before_words)
    check("…and keeps the account", g.evaluate("!!Acct.user") and "G" in db()["users"])
    # G deletes every flashcard: the words and meanings stay
    g.evaluate(f"putEntry('fa', {json.dumps(k_miz)}, {{ s: 1, ...cardsFor(entry('fa', {json.dumps(k_miz)}), true) }})")
    n_cards = g.evaluate("S.settings.langs.reduce((t, l) => t + cardCount(l.code), 0)")
    g.click("#ac-del-cards")
    g.locator("#modal").get_by_role("button", name="Delete all flashcards").click()
    g.wait_for_selector("text=Deleted the flashcards of", timeout=10000)
    check("deleting all flashcards removes every card", n_cards > 0 and g.evaluate("S.settings.langs.reduce((t, l) => t + cardCount(l.code), 0)") == 0, n_cards)
    check("…and keeps the words and their meanings", g.evaluate("[...vmap('fa').values()].filter(e => !e.d && e.m).length") == before_words)
    # sharing one deck from its ⋯ menu shares only that deck's cards
    g.evaluate(f"(() => {{ const id = addDeck('fa', 'Furniture'); putEntry('fa', {json.dumps(k_miz)}, {{ s: 1, dk: id, ...cardsFor(entry('fa', {json.dumps(k_miz)}), true) }}); }})()")
    g.goto(URL + "#library"); g.wait_for_selector(".dt-more")
    g.get_by_role("button", name="Options for Furniture").click()
    g.locator("#modal").get_by_role("button", name="Share…").click()
    check("sharing a deck suggests its name as the title", g.input_value("#sh-title") == "Persian: Furniture" and g.locator("#sh-which-cards").count() == 0)
    rid = share(g, vis="private")
    r = next(x for x in db()["resources"] if x["id"] == rid)
    check("a shared deck holds just its words", [w[0] for w in r["content"]["words"]] == ["میز"], r.get("content"))

    # A deletes the account
    a.get_by_role("button", name="Delete my account").click()
    a.locator("#modal").get_by_role("button", name="Delete my account").click()
    a.wait_for_selector(".tiles", timeout=15000)  # back in the Library
    check("signed out after deleting", a.evaluate("!Acct.user && !localStorage.getItem('khwanish-auth')"))
    d_ = db()
    check("deleting the account removes its saved reading", not [v for v in d_.get("reader_docs", {}).values() if v["owner"] == "A"])
    check("account and everything in it deleted", "A" not in d_["users"] and not [r for r in d_["resources"] if r["owner"] == "A"] and not d_["files"], (list(d_["users"]), len(d_["resources"]), list(d_["files"])))
    bb.goto(URL + "#r-" + list_id)
    bb.wait_for_selector("text=Nothing here")
    check("links stop working", True)
    check("B's copies stay", bb.evaluate("[...vmap('fa').values()].filter(e => e.s === 1 && e.m).length") == 3)
    b.close()

check("nothing requested from other hosts", not outside, sorted(set(outside))[:5])
check("no missing files", not missing, missing[:5])
check("no errors", not errors, errors[:5])
print(f"\n{len(fails)} failures")
for f in fails:
    print(" -", f)
srv.shutdown()

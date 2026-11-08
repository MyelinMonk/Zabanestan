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
shutil.copytree(ROOT / "dist" / "site", base / "khwanish")
(base / "reader.html").write_text('<!doctype html><title>Reader guide</title><h2 id="ocr">OCR</h2>')
(base / "favicon.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>')  # the site's icon


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8771), functools.partial(Quiet, directory=str(serve)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
HOST = "http://127.0.0.1:8771"
URL = HOST + "/Zabanestan/khwanish/"
MOCK = (ROOT / "test" / "mock_supabase.js").read_text()
DB = {"json": json.dumps({"users": {}, "profiles": {}, "resources": [], "files": {}})}
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
        body = resp.text().replace("window.KH_SITE = {", 'window.KH_SITE = {"supabase": {"url": "https://mock.supabase.co", "key": "mock-publishable-key"}, ', 1)
        r.fulfill(response=resp, body=body)

    ctx.route("**/*", outside_or_local)
    ctx.route(lambda u: urlparse(u).path in ("/Zabanestan/khwanish/", "/Zabanestan/khwanish/index.html"), page_with_accounts)
    ctx.route("**/khwanish/lib/supabase/supabase.js", lambda r: r.fulfill(body=MOCK, content_type="text/javascript"))
    pg = ctx.new_page()
    pg.on("console", lambda m: errors.append(f"{user}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errors.append(f"{user}: {e}"))
    pg.on("response", lambda r: missing.append(f"{r.status} {r.url}") if r.status >= 400 else None)
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
    a.fill("#ac-name", "Austin")
    a.get_by_role("button", name="Save name").click()
    a.wait_for_timeout(300)
    check("name saved", db()["profiles"]["A"]["display_name"] == "Austin")
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
    check("shared by the chosen name", fact(a, "Shared by") == "Austin")

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
    check("review queue shows the public text, with the name", len(q) == 1 and "گلستان سعدی" in q[0] and "Austin" in q[0], q)
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

    # A deletes the account
    a.get_by_role("button", name="Delete my account").click()
    a.locator("#modal").get_by_role("button", name="Delete my account").click()
    a.wait_for_selector(".tiles", timeout=15000)  # back in the Library
    check("signed out after deleting", a.evaluate("!Acct.user && !localStorage.getItem('khwanish-auth')"))
    d_ = db()
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

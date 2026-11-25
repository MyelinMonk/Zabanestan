"""Decks and deleting flashcards, in the website copy without an account (everything in this browser).
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
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8772), functools.partial(Quiet, directory=str(serve)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:8772/Zabanestan/khanesh/"
fails, errors = [], []
def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{str(info)[:300]}]" if info and not cond else ""))
    if not cond: fails.append(name)

SEED = """() => {
  for (const [w, m] of [['کتاب', 'book'], ['میز', 'table'], ['آب', 'water'], ['نان', 'bread']])
    putEntry('fa', w, { s: 1, f: w, m, ...cardsFor(null, true) });
}"""
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith("http://127.0.0.1:8772") else r.abort())
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    # the site copy asks the real Supabase project for shared meanings; this test keeps it offline
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "ERR_FAILED" not in m.text and not ("404" in m.text and not (ROOT.parent / "images").exists()) else None)
    pg.on("requestfailed", lambda r: errors.append("failed: " + r.url) if "supabase.co" not in r.url else None)
    pg.goto(URL + "#words")
    pg.wait_for_selector("#wlist")
    pg.evaluate(SEED)
    check("a word's deck survives saving to an account", pg.evaluate("decE(encE({ s: 1, u: 1, c: newCard(), dk: 'd1' })).dk") == "d1")
    check("words start in the main deck", pg.evaluate("[...vmap('fa').values()].every(e => !e.dk)") and pg.evaluate("decksOf('fa').length") == 1)
    check("with one deck, Words shows no deck menu", pg.locator("#w-deck").count() == 0)

    # add a deck and send new cards to it
    pg.click("#w-decks")
    pg.fill("#deck-new-name", "Food")
    pg.locator("#modal").get_by_role("button", name="Add").click()
    pg.wait_for_selector(".deck-row >> nth=1")
    check("a new deck is listed", pg.locator(".deck-row").count() == 2 and pg.evaluate("decksOf('fa')[1].n") == "Food")
    check("the decks window has no 'new cards go here' choice", pg.locator(".deck-row input[type=radio]").count() == 0)
    pg.screenshot(path=str(OUT / "decks.png"))
    food = pg.evaluate("decksOf('fa')[1].id")
    pg.locator("#modal .icon-btn[aria-label=Close]").click()
    pg.evaluate(f"patchLang('fa', {{ addDeck: '{food}' }})")  # as when Food is chosen beside Add flashcards
    pg.evaluate("putEntry('fa', 'سیب', { s: 1, f: 'سیب', m: 'apple', ...cardsFor(null, true) })")
    check("a new flashcard goes to that deck", pg.evaluate("entry('fa', 'سیب').dk") == food)
    pg.evaluate("putEntry('fa', 'سیب', { m: 'an apple' })")
    check("editing a word keeps its deck", pg.evaluate("entry('fa', 'سیب').dk") == food)

    # move a word in its panel
    pg.evaluate("viewWords()")
    pg.locator(".wrow", has_text="نان").click()
    pg.wait_for_selector("#f-deck")
    pg.select_option("#f-deck", food)
    check("a word's cards move to another deck from its panel", pg.evaluate("entry('fa', 'نان').dk") == food)
    pg.keyboard.press("Escape")
    pg.evaluate("viewWords()")
    pg.wait_for_selector("#w-deck")
    pg.select_option("#w-deck", food)
    rows = pg.locator(".wrow .wf").all_inner_texts()
    check("Words filters by deck", sorted(rows) == sorted(["سیب", "نان"]), rows)
    pg.select_option("#w-deck", "*")
    pg.screenshot(path=str(OUT / "decks-words.png"))

    # review one deck
    pg.goto(URL + "#review")
    pg.wait_for_selector("#rv-deck")
    all_n = pg.evaluate("(q => q.fresh)(queueInfo('lang'))")
    pg.select_option("#rv-deck", food)
    check("review can show one deck", pg.evaluate("(q => q.freshTotal)(queueInfo('lang'))") == 4 and all_n >= 4, all_n)
    cur = pg.evaluate("UI.review.cur && UI.review.cur.key")
    check("…and its card comes from that deck", cur in ("سیب", "نان"), cur)
    pg.screenshot(path=str(OUT / "decks-review.png"))
    pg.select_option("#rv-deck", "*")
    check("…or every deck", pg.evaluate("(q => q.freshTotal)(queueInfo('lang'))") == 10)

    # the home screen: decks, with the tiles still counting the whole language
    pg.goto(URL + "#library"); pg.wait_for_selector(".deck-tile")
    names = pg.locator(".deck-tile .dt-name").all_inner_texts()
    check("the home screen lists the decks", names == ["Main deck", "Food"], names)
    pg.evaluate(f"patchLang('fa', {{ rdeck: '{food}' }}); viewLibrary()")
    tile_due = int(pg.locator(".tile.due .big").inner_text())
    check("the top tiles count every deck, whichever deck Review shows", tile_due == 10 and pg.evaluate("(q => q.fresh)(queueInfo('lang'))") == 4, tile_due)
    pg.screenshot(path=str(OUT / "decks-home.png"), full_page=True)
    pg.locator(".deck-tile", has_text="Food").click()
    pg.wait_for_selector("#rv-deck")
    check("tapping a deck reviews it", pg.evaluate("location.hash") == "#review" and pg.input_value("#rv-deck") == food)
    # each deck's ⋯ menu: browse it, rename it, delete it
    pg.goto(URL + "#library"); pg.wait_for_selector(".dt-more")
    pg.get_by_role("button", name="Options for Food").click()
    pg.wait_for_selector("#dm-name")
    pg.screenshot(path=str(OUT / "deck-menu.png"))
    pg.locator("#modal").get_by_role("button", name="Browse its cards").click()
    pg.wait_for_selector("#wlist .wrow")
    check("a deck's menu opens the card browser on that deck", pg.input_value("#w-deck") == food and sorted(pg.locator("#wlist .wf").all_inner_texts()) == sorted(["سیب", "نان"]))
    pg.evaluate("addDeck('fa', 'Temp')")
    pg.goto(URL + "#library"); pg.wait_for_selector(".dt-more")
    pg.get_by_role("button", name="Options for Temp").click()
    pg.fill("#dm-name", "Temporary")
    pg.locator("#modal").get_by_role("button", name="Done").click()
    check("a deck's menu renames it", "Temporary" in pg.locator(".deck-tile .dt-name").all_inner_texts())
    pg.get_by_role("button", name="Options for Temporary").click()
    pg.locator("#modal").get_by_role("button", name="Delete deck").click()
    pg.wait_for_timeout(300)
    check("a deck's menu deletes it", "Temporary" not in pg.locator(".deck-tile .dt-name").all_inner_texts() and pg.evaluate("decksOf('fa').length") == 2)
    pg.get_by_role("button", name="Options for Main deck").click()
    check("the main deck can't be deleted", pg.locator("#modal").get_by_role("button", name="Delete deck").count() == 0)
    has_share = pg.locator("#modal").get_by_role("button", name="Share…").count()
    if has_share:
        pg.locator("#modal").get_by_role("button", name="Share…").click()
        check("a deck's menu can share it (sign in first)", "Sign in to keep this" in pg.inner_text("#modal"))
    pg.keyboard.press("Escape")
    pg.evaluate("UI.words.deck = '*'; UI.words.st = 'learning'")
    pg.click("#lib-add-deck")
    pg.wait_for_timeout(200)
    check("Add a deck opens the decks, ready for a name", pg.evaluate("document.activeElement && document.activeElement.id") == "deck-new-name")
    pg.keyboard.press("Escape")

    # choosing the deck when adding a word's cards, including a new deck
    pg.evaluate("putEntry('fa', 'شیر', { s: 1, f: 'شیر', m: 'milk' })")
    pg.goto(URL + "#words"); pg.wait_for_selector("#wlist")
    pg.locator(".wrow", has_text="شیر").click()
    pg.wait_for_selector("#f-add-deck")
    pg.select_option("#f-add-deck", "+")
    pg.locator(".deck-inline input").fill("Drinks")
    pg.locator(".deck-inline").get_by_role("button", name="Add").click()
    drinks = pg.evaluate("(decksOf('fa').find(d => d.n === 'Drinks') || {}).id")
    check("a word's panel can make a new deck", bool(drinks) and pg.input_value("#f-add-deck") == drinks and pg.evaluate("newCardDeck('fa')") == drinks)
    pg.screenshot(path=str(OUT / "decks-panel.png"))
    pg.get_by_role("button", name="Add flashcards").click()
    check("…and its cards go there", pg.evaluate("entry('fa', 'شیر').dk") == drinks and pg.evaluate("!!entry('fa', 'شیر').c"))
    check("…and the word's meaning is kept", pg.evaluate("entry('fa', 'شیر').m") == "milk")
    pg.keyboard.press("Escape")
    pg.evaluate("patchLang('fa', { addDeck: '' })")

    # making a card by hand, into a chosen deck
    pg.goto(URL + "#library"); pg.wait_for_selector("#lib-new-card")
    pg.click("#lib-new-card")
    pg.wait_for_selector("#nc-word")
    pg.fill("#nc-word", "پنیر"); pg.fill("#nc-mean", "cheese"); pg.fill("#nc-sent", "نان و پنیر")
    pg.select_option("#nc-deck", food)
    pg.screenshot(path=str(OUT / "new-card.png"))
    pg.click("#nc-add")
    e = pg.evaluate("JSON.stringify(entry('fa', 'پنیر'))")
    check("a card made by hand goes to the chosen deck", pg.evaluate("entry('fa', 'پنیر').dk") == food and pg.evaluate("!!entry('fa', 'پنیر').c && entry('fa', 'پنیر').x === 'نان و پنیر'"), e)
    check("…and the form clears for the next one", pg.input_value("#nc-word") == "")
    pg.fill("#nc-word", "پنیر"); pg.fill("#nc-mean", "cheese again"); pg.click("#nc-add")
    check("…but not twice for the same word", "already have a card" in pg.inner_text("#modal .error"))
    pg.click("#nc-word"); pg.fill("#nc-word", "")
    pg.locator("#modal").get_by_role("button", name="Done").click()
    pg.evaluate("deleteEntry('fa', 'پنیر')")

    # browsing every card: search, and filter by due
    pg.evaluate("""() => {
      const past = Date.now() - 86400000, later = Date.now() + 5 * 86400000;
      const e1 = entry('fa', 'کتاب'); putEntry('fa', 'کتاب', { c: { ...e1.c, q: 2, due: past, lr: past }, c2: { ...e1.c2, q: 2, due: later, lr: past }, n: 'a note about reading' });
      const e2 = entry('fa', 'میز'); putEntry('fa', 'میز', { c: { ...e2.c, q: 2, due: later, lr: past }, c2: { ...e2.c2, q: 2, due: later, lr: past } });
    }""")
    pg.goto(URL + "#library"); pg.wait_for_selector("#lib-browse")
    pg.click("#lib-browse")
    pg.wait_for_selector("#wlist .wrow")
    cnt = lambda: pg.locator("#wlist .wrow").count()
    check("Browse cards lists every word with flashcards", pg.input_value("#w-st") == "cards" and cnt() == 6, cnt())
    pg.select_option("#w-st", "due")
    check("…can show only cards due now", [t.strip() for t in pg.locator("#wlist .wf").all_inner_texts()] == ["کتاب"], pg.locator("#wlist .wf").all_inner_texts())
    pg.select_option("#w-st", "later")
    check("…or cards not due yet", [t.strip() for t in pg.locator("#wlist .wf").all_inner_texts()] == ["میز"])
    pg.select_option("#w-st", "newc")
    check("…or new cards", cnt() == 4)
    pg.select_option("#w-st", "cards")
    pg.fill("#w-q", "reading"); pg.wait_for_timeout(400)
    check("search finds a card by its notes", [t.strip() for t in pg.locator("#wlist .wf").all_inner_texts()] == ["کتاب"])
    pg.fill("#w-q", "bre"); pg.wait_for_timeout(400)
    check("…or its meaning", [t.strip() for t in pg.locator("#wlist .wf").all_inner_texts()] == ["نان"])
    pg.fill("#w-q", ""); pg.wait_for_timeout(300)
    pg.screenshot(path=str(OUT / "browse-cards.png"))

    # import into a new deck
    pg.goto(URL + "#words"); pg.wait_for_selector("#wlist")
    pg.get_by_role("button", name="Import a word list").click()
    pg.fill("#wi-text", "گربه\tcat\nسگ\tdog")
    pg.check("#wi-as-learning")
    pg.select_option("#wi-deck", "+")
    pg.locator(".deck-new input").fill("Unit 3")
    pg.locator("#modal").get_by_role("button", name="Import", exact=True).click()
    pg.wait_for_selector("#modalWrap", state="hidden")
    unit = pg.evaluate("(decksOf('fa').find(d => d.n === 'Unit 3') || {}).id")
    check("an import can make a new deck for its cards", unit and pg.evaluate("entry('fa', 'گربه').dk") == unit and pg.evaluate("entry('fa', 'سگ').dk") == unit)

    # delete a deck, moving its cards to the main deck
    pg.click("#w-decks")
    row = pg.locator(".deck-row").nth(pg.evaluate("decksOf('fa').findIndex(d => d.n === 'Food')"))
    row.get_by_role("button", name="Delete").click()
    pg.locator("#modal").get_by_role("button", name="Move them to Main deck").click()
    pg.wait_for_selector(".deck-row >> nth=1")
    check("deleting a deck can keep its cards in the main deck",
          pg.evaluate("!decksOf('fa').some(d => d.n === 'Food') && !entry('fa', 'نان').dk && !!entry('fa', 'نان').c && newCardDeck('fa') === ''"))
    # delete a deck with its cards
    row = pg.locator(".deck-row").nth(pg.evaluate("decksOf('fa').findIndex(d => d.n === 'Unit 3')"))
    row.get_by_role("button", name="Delete").click()
    pg.locator("#modal").get_by_role("button", name="Delete the flashcards").click()
    pg.wait_for_selector(".deck-row")
    check("…or delete them, keeping the words", pg.evaluate("!entry('fa', 'گربه').c && !entry('fa', 'گربه').c2 && entry('fa', 'گربه').m === 'cat'"))

    # every flashcard of a language
    pg.locator("#modal").get_by_role("button", name="Delete all Persian flashcards").click()
    pg.locator("#modal").get_by_role("button", name="Delete flashcards").click()
    pg.wait_for_selector("text=Deleted the flashcards of 6 words")
    check("deleting a language's flashcards keeps its words and meanings",
          pg.evaluate("cardCount('fa')") == 0 and pg.evaluate("[...vmap('fa').values()].filter(e => !e.d && e.m).length") == 8)

    # every flashcard, from Options
    pg.evaluate("putEntry('fa', 'آب', { s: 1, ...cardsFor(entry('fa', 'آب'), true) })")
    pg.goto(URL + "#options"); pg.wait_for_selector("#view .opt")
    pg.get_by_role("button", name="Delete all flashcards").click()
    pg.locator("#modal").get_by_role("button", name="Delete all flashcards").click()
    pg.wait_for_selector("text=Deleted the flashcards of 1 word")
    check("Options can delete every flashcard", pg.evaluate("cardCount('fa')") == 0)
    pg.evaluate("Persist.write()")
    pg.reload(); pg.wait_for_selector("#view")
    pg.wait_for_timeout(500)
    check("decks and deletions are kept after reloading", pg.evaluate("ensureLang('fa').then(() => cardCount('fa'))") == 0 and pg.evaluate("decksOf('fa').length") == 2)
    b.close()

check("no errors", not errors, errors[:5])
print(f"\n{len(fails)} failures")
for f in fails: print(" -", f)
srv.shutdown()

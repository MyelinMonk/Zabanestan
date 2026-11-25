# Khānesh

Khānesh (خوانش, “reading”) is Zabanestan’s reader for learning languages by reading. [Try it](https://zabanestan.org/khanesh/), or read [the guide](https://zabanestan.org/reader.html).

## What's here

- `src/`: the app. `template.html` and `style.css`, plus the scripts, joined in this order: `core.js`, `store.js`, `ui.js`, `anki.js`, `ui2.js`, `accounts.js`.
- `build.py`: builds `dist/index.html`, the copy that runs inside Claude and loads its fonts and libraries from CDNs. With `--site` it also builds `dist/site/`, the website copy, which keeps everything beside the page and makes no outside requests.
- `tools/khanesh_tools.py`: the helper script for OCR with kraken and Ganjoor recitations. The build copies it into the website copy.
- `site_assets/`: the font packages and the Supabase client for the website copy (`npm install` fetches them).
- `supabase/`: the accounts database (`schema.sql`), its tests, and [how to set accounts up](supabase/SETUP-ACCOUNTS.md).
- `test/`: browser tests.

## Build it

```
cd khanesh
(cd site_assets && npm install) && (cd test && npm install)   # fonts; pdf.js 3.11.174 and sql.js 1.10.3
pip install fonttools brotli                                   # cuts the wordmark font down to its letters
python3 build.py --site     # dist/site/ is the website copy
```

The website copy reads `window.KH_SITE` (set by `build.py`) for its links back to the site and the folder of its libraries. Without it, the page behaves as the Claude copy does.

## Tests

They need Google Chrome at `/usr/bin/google-chrome` (change the path at the top of each test if yours is elsewhere), and Python with `playwright` and `anki` (`pip install playwright anki`).

- `python3 test/run.py`: the Claude copy, with a stand-in for Claude's services (`test/mock.js`). It also imports an exported package into a real Anki collection.
- `python3 test/accounts_test.py`: accounts in the website copy, against a stand-in for Supabase (`test/mock_supabase.js`): signing in, sharing at each visibility, the review team, and deleting an account.
- `python3 test/decks_test.py`, `test/media_test.py`, `test/wikt_test.py` and `test/anki_import_test.py`: decks and the card browser, audio and video lessons, Wiktionary meanings, and importing Anki packages (built by `test/make_anki_fixtures.py`, which needs `pip install zstandard`).
- `python3 test/test_tools.py`: the helper script's caption, Ganjoor and page-XML handling, without the network.
- `cd supabase && npm install && node test_schema.mjs`: the database rules in `schema.sql`, checked in a real Postgres (PGlite).

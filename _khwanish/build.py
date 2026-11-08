#!/usr/bin/env python3
"""Build Khwānish.

  python3 build.py           dist/index.html: the Claude artifact (fonts and libraries from CDNs)
  python3 build.py --site    also dist/site/: the copy for the Zabanestan website. Same page, but its
                             fonts, pdf.js and sql.js sit next to it, so it makes no outside requests.

The website copy needs the font packages (npm install in site_assets/), pdf.js 3.11.174 and
sql.js 1.10.3 in test/node_modules, and Python's fontTools with brotli (for the wordmark font).
"""
import json
import re
import shutil
import sys
from pathlib import Path

root = Path(__file__).parent
src = root / "src"

# Links the website copy shows, relative to the folder it's served from (…/khwanish/).
SITE_CONFIG = {"name": "Zabanestan", "home": "../", "guide": "../reader.html", "lib": "lib/"}


def site_config():
    """SITE_CONFIG, plus the Supabase project from site-config.json when it's filled in (accounts)."""
    cfg = dict(SITE_CONFIG)
    f = root / "site-config.json"
    if f.exists():
        sb = json.loads(f.read_text(encoding="utf-8")).get("supabase") or {}
        url, key = (sb.get("url") or "").strip().rstrip("/"), (sb.get("key") or "").strip()
        if url and key:
            assert url.startswith("https://"), "site-config.json: the Supabase url starts with https://"
            assert not key.startswith(("sb_secret_", "service_role")), "site-config.json: use the publishable (anon) key, never the secret one"
            cfg["supabase"] = {"url": url, "key": key}
    return cfg

# Fonts the page uses: (Fontsource package, weights, subsets). Each subset only downloads
# when text on the page needs it, as with Google Fonts.
LATIN = ["latin", "latin-ext", "vietnamese", "cyrillic", "cyrillic-ext"]  # vietnamese carries combining accents
FONTS = [
    ("ibm-plex-sans", [400, 500, 600], LATIN),
    ("ibm-plex-sans-arabic", [400, 500, 600], ["arabic"]),
    ("noto-serif", [400, 600], LATIN),
    ("noto-naskh-arabic", [400, 600], ["arabic"]),
    ("noto-serif-hebrew", [400, 600], ["hebrew"]),
    ("noto-serif-devanagari", [400, 600], ["devanagari"]),
    ("noto-sans", [400, 600], LATIN),
    ("noto-sans-arabic", [400, 600], ["arabic"]),
    ("noto-sans-hebrew", [400, 600], ["hebrew"]),
    ("noto-sans-devanagari", [400, 600], ["devanagari"]),
    ("noto-nastaliq-urdu", [400, 600], ["arabic"]),
]
WORDMARK = "خوانش"
SUPABASE_VERSION = "2.119.0"

MIT = """MIT License

Copyright (c) 2026 MyelinMonk and Zabanestan contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

THIRD_PARTY = """Khwānish reader: third-party parts
==================================

The reader's own code is under the MIT License (LICENSE.txt). It ships with:

pdf.js 3.11.174, lib/pdfjs/
  Reads PDFs. Copyright Mozilla Foundation. Apache License 2.0, lib/pdfjs/LICENSE.txt.

sql.js 1.10.3, lib/sql.js/
  Builds Anki packages. Copyright (c) 2017 sql.js authors (lib/sql.js/AUTHORS.txt).
  MIT License, lib/sql.js/LICENSE.txt. sql.js is SQLite compiled to JavaScript; SQLite is in the public domain.

supabase-js 2.119.0, lib/supabase/
  Signs people in and talks to the accounts database, when the site has accounts.
  Copyright (c) 2020 Supabase. MIT License, lib/supabase/LICENSE.txt.

Fonts, fonts/
  IBM Plex Sans and IBM Plex Sans Arabic, copyright 2019 IBM Corp.
  Noto Serif, Noto Sans, Noto Naskh Arabic, Noto Sans Arabic, Noto Nastaliq Urdu, Noto Serif and
  Sans Hebrew, Noto Serif and Sans Devanagari, copyright The Noto Project Authors.
  All under the SIL Open Font License 1.1, fonts/OFL.txt. Packaged by Fontsource (fontsource.org).
  khwanish-mark.woff2 is Noto Nastaliq Urdu cut down to the letters of the wordmark.

Sample texts
  The sample texts (Saadi, Rudaki, La Fontaine, the Dhammapada, the Bhagavad Gītā) are in the public domain.

Dictionary links open other websites, which have their own terms. Khwānish isn't affiliated with them.
"""


def build_page(site=False):
    tpl = (src / "template.html").read_text(encoding="utf-8")
    css = (src / "style.css").read_text(encoding="utf-8")
    js = "\n".join((src / f).read_text(encoding="utf-8") for f in ["core.js", "store.js", "ui.js", "anki.js", "ui2.js", "accounts.js"])
    assert "</script" not in js.lower(), "script contains a closing tag"
    fonts = re.compile(r"<!--fonts-->.*?<!--/fonts-->\n?", re.S)
    if site:
        head = ('<meta name="description" content="A free reader for learning languages by reading: tap words, save flashcards, export them to Anki.">\n'
                '<meta name="robots" content="noindex">\n'  # the Zabanestan site is hidden from search engines for now
                '<link rel="icon" href="../favicon.svg" type="image/svg+xml">')
        tpl = tpl.replace("<!--head-extra-->", head, 1)
        tpl = fonts.sub(lambda m: "<style>\n" + site_font_css() + "\n</style>\n", tpl, count=1)
        tpl = tpl.replace("<!--site-config-->", f"<script>window.KH_SITE = {json.dumps(site_config())};</script>", 1)
        css += '\n/* website copy: the wordmark uses a font cut down to its five letters */\n:root { --font-mark: "Khwanish Mark", "Noto Nastaliq Urdu", "Noto Naskh Arabic", serif; }\n'
    else:
        tpl = tpl.replace("<!--head-extra-->\n", "", 1).replace("<!--site-config-->\n", "", 1)
        tpl = tpl.replace("<!--fonts-->\n", "", 1).replace("<!--/fonts-->\n", "", 1)
    assert "<!--" not in tpl.split("<style>")[0].replace("<!DOCTYPE", ""), "a build marker was left in the page head"
    return tpl.replace("/*CSS*/", css, 1).replace("/*JS*/", js, 1)


_font_files = []


def site_font_css():
    """@font-face rules for the fonts in FONTS, pointing at fonts/ next to the page."""
    pkgs = root / "site_assets" / "node_modules" / "@fontsource"
    if not pkgs.exists():
        sys.exit("Font packages missing: run  npm install  in site_assets/ first.")
    out = []
    for pkg, weights, subsets in FONTS:
        for w in weights:
            text = (pkgs / pkg / f"{w}.css").read_text(encoding="utf-8")
            found = set()
            for name, block in re.findall(r"/\*\s*([\w-]+)\s*\*/\s*(@font-face\s*\{.*?\})", text, re.S):
                sub = name[len(pkg) + 1:-len(f"-{w}-normal")]
                if sub not in subsets or not name.endswith(f"-{w}-normal"):
                    continue
                m = re.search(r"url\(\./files/([^)]+?\.woff2)\)", block)
                block = re.sub(r"src:[^;]*;", f"src: url(fonts/{m.group(1)}) format('woff2');", block)
                out.append(re.sub(r"\s+", " ", block).replace("{ ", "{").replace("; }", ";}"))
                _font_files.append(pkgs / pkg / "files" / m.group(1))
                found.add(sub)
            missing = set(subsets) - found
            assert not missing or pkg.startswith(("ibm-plex-sans-arabic", "noto-naskh", "noto-nastaliq")), f"{pkg} {w}: no {missing}"
    out.append("@font-face {font-family: 'Khwanish Mark'; font-style: normal; font-display: swap; font-weight: 600; src: url(fonts/khwanish-mark.woff2) format('woff2');}")
    return "\n".join(out)


def build_site(page):
    out = root / "dist" / "site"
    if out.exists():
        shutil.rmtree(out)
    (out / "fonts").mkdir(parents=True)
    (out / "index.html").write_text(page, encoding="utf-8")
    pkgs = root / "site_assets" / "node_modules" / "@fontsource"
    for f in _font_files:
        shutil.copy(f, out / "fonts" / f.name)
    # the wordmark: Noto Nastaliq Urdu cut down to its letters (with the shaping rules they need)
    from fontTools import subset
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    font = subset.load_font(str(pkgs / "noto-nastaliq-urdu" / "files" / "noto-nastaliq-urdu-arabic-600-normal.woff2"), opts)
    sub = subset.Subsetter(opts)
    sub.populate(text=WORDMARK)
    sub.subset(font)
    subset.save_font(font, str(out / "fonts" / "khwanish-mark.woff2"), opts)
    # one OFL text with every font's copyright line on top
    ofl = (pkgs / "noto-serif" / "LICENSE").read_text(encoding="utf-8")
    body = ofl[ofl.index("This Font Software is licensed"):]
    heads = []
    for pkg, _, _ in FONTS:
        first = (pkgs / pkg / "LICENSE").read_text(encoding="utf-8").splitlines()[0]
        heads.append(re.split(r"\s+\S+\.ttf:", first)[0].strip())
    (out / "fonts" / "OFL.txt").write_text("\n".join(dict.fromkeys(heads)) + "\n\n" + body, encoding="utf-8")
    # libraries, at the versions the Claude artifact loads from the CDNs
    nm = root / "test" / "node_modules"
    for pkg, ver in (("pdfjs-dist", "3.11.174"), ("sql.js", "1.10.3")):
        got = json.loads((nm / pkg / "package.json").read_text())["version"]
        assert got == ver, f"{pkg} is {got}, expected {ver}"
    pdf = out / "lib" / "pdfjs"
    pdf.mkdir(parents=True)
    for f in ("pdf.min.js", "pdf.worker.min.js"):
        shutil.copy(nm / "pdfjs-dist" / "build" / f, pdf / f)
    shutil.copy(nm / "pdfjs-dist" / "LICENSE", pdf / "LICENSE.txt")
    sq = out / "lib" / "sql.js"
    sq.mkdir(parents=True)
    shutil.copy(nm / "sql.js" / "dist" / "sql-asm-memory-growth.js", sq / "sql-asm-memory-growth.js")
    shutil.copy(nm / "sql.js" / "LICENSE", sq / "LICENSE.txt")
    shutil.copy(nm / "sql.js" / "AUTHORS", sq / "AUTHORS.txt")
    # the Supabase client, for accounts (loaded only when someone uses them)
    sbp = root / "site_assets" / "node_modules" / "@supabase" / "supabase-js"
    got = json.loads((sbp / "package.json").read_text())["version"]
    assert got == SUPABASE_VERSION, f"@supabase/supabase-js is {got}, expected {SUPABASE_VERSION} (as in src/accounts.js)"
    sb = out / "lib" / "supabase"
    sb.mkdir(parents=True)
    shutil.copy(sbp / "dist" / "umd" / "supabase.js", sb / "supabase.js")
    shutil.copy(sbp / "LICENSE", sb / "LICENSE.txt")
    # the helper script for OCR, YouTube and Ganjoor, and the licences
    (out / "tools").mkdir()
    shutil.copy(root / "tools" / "khwanish_tools.py", out / "tools" / "khwanish_tools.py")
    (out / "LICENSE.txt").write_text(MIT, encoding="utf-8")
    (out / "THIRD-PARTY.txt").write_text(THIRD_PARTY, encoding="utf-8")
    total = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    fonts = sum(p.stat().st_size for p in (out / "fonts").glob("*.woff2"))
    print(f"dist/site/: {len(list(out.rglob('*')))} files, {total / 1048576:.1f} MiB "
          f"(fonts {fonts / 1048576:.1f} MiB in {len(list((out / 'fonts').glob('*.woff2')))} files, each loaded only when used)")


page = build_page()
(root / "dist").mkdir(exist_ok=True)
(root / "dist" / "index.html").write_text(page, encoding="utf-8")
print(f"dist/index.html: {len(page.encode('utf-8')) / 1024:.1f} KiB")
if "--site" in sys.argv:
    build_site(build_page(site=True))

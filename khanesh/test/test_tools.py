"""Checks for tools/khanesh_tools.py that need no network: captions, Ganjoor (with a fake API) and page XML."""
import sys, json, types, importlib.util, tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
TMP = tempfile.mkdtemp()
spec = importlib.util.spec_from_file_location("kt", str(ROOT / "tools" / "khanesh_tools.py"))
kt = importlib.util.module_from_spec(spec); spec.loader.exec_module(kt)
fails = []
def check(n, c, info=""):
    print(("PASS " if c else "FAIL ") + n + ("" if c else f"  [{str(info)[:300]}]"))
    if not c: fails.append(n)

# 1. YouTube rolling captions
yt = """WEBVTT
Kind: captions
Language: fa

00:00:00.000 --> 00:00:02.000 align:start position:0%
سلام<00:00:00.500><c> به</c><00:00:01.000><c> همه</c>

00:00:02.000 --> 00:00:02.010 align:start position:0%
سلام به همه
 

00:00:02.010 --> 00:00:04.000 align:start position:0%
سلام به همه
امروز<00:00:02.500><c> درس</c><00:00:03.000><c> داریم</c>
"""
cues = kt.vtt_to_cues(yt)
check("vtt dedupe", [c["t"] for c in cues] == ["سلام به همه", "امروز درس داریم"], cues)

# 2. Ganjoor: fake API + recitation + sync file
verses = [{"vOrder": i + 1, "versePosition": i % 2, "text": t} for i, t in enumerate(
    ["الا یا ایها الساقی ادر کاسا و ناولها", "که عشق آسان نمود اول ولی افتاد مشکل‌ها",
     "به بوی نافه‌ای کاخر صبا زان طره بگشاید", "ز تاب جعد مشکینش چه خون افتاد در دل‌ها"])]
poem = {"id": 2131, "fullTitle": "حافظ » غزلیات » غزل ۱", "fullUrl": "/hafez/ghazal/sh1", "verses": verses,
        "recitations": [{"audioArtist": "Reciter A", "audioTitle": "t", "mp3Url": "https://x/1.mp3", "xmlText": "https://x/1.xml"}]}
sync0 = """<?xml version="1.0" encoding="utf-8"?><DesktopGanjoorPoemAudioList><PoemAudio><SyncArray>
<SyncInfo><VerseOrder>-1</VerseOrder><AudioMiliseconds>0</AudioMiliseconds></SyncInfo>
<SyncInfo><VerseOrder>0</VerseOrder><AudioMiliseconds>2000</AudioMiliseconds></SyncInfo>
<SyncInfo><VerseOrder>1</VerseOrder><AudioMiliseconds>6000</AudioMiliseconds></SyncInfo>
<SyncInfo><VerseOrder>2</VerseOrder><AudioMiliseconds>10000</AudioMiliseconds></SyncInfo>
<SyncInfo><VerseOrder>3</VerseOrder><AudioMiliseconds>14000</AudioMiliseconds></SyncInfo>
</SyncArray></PoemAudio></DesktopGanjoorPoemAudioList>"""
class Resp:
    def __init__(self, url):
        self.url = url; self.status_code = 200; self.encoding = "utf-8"
        if "/api/ganjoor/page" in url: self._j = {"poem": poem}
        elif url.endswith(".xml"): self.text = sync0
        else: self._j = poem
    def json(self): return self._j
    def raise_for_status(self): pass
    def iter_content(self, n): yield b"ID3fake"
    def __enter__(self): return self
    def __exit__(self, *a): pass
class Session:
    headers = {}
    def get(self, url, **k): return Resp(url)
fake = types.SimpleNamespace(Session=Session, utils=types.SimpleNamespace(quote=lambda s: s))
kt.need = lambda m, p=None: fake if m == "requests" else __import__(m)
args = types.SimpleNamespace(poem="https://ganjoor.net/hafez/ghazal/sh1", out=TMP + "/g", debug=False, list=False, reciter=1)
kt.cmd_ganjoor(args)
b = json.loads(next(Path(TMP + "/g").glob("*.khanesh.json")).read_text())
check("ganjoor cues for every verse", [c["s"] for c in b["cues"]] == [2000, 6000, 10000, 14000], b["cues"])
check("ganjoor couplet gaps", [c["gap"] for c in b["cues"]] == [False, False, True, False], [c["gap"] for c in b["cues"]])
check("ganjoor credit + source", b["credit"] == "Recited by Reciter A · Ganjoor" and b["source"].endswith("/hafez/ghazal/sh1"), b)
check("ganjoor mp3 saved", any(Path(TMP + "/g").glob("*.mp3")))
# 1-based sync numbering
sync0 = sync0.replace(">3<", ">4<").replace(">2<", ">3<").replace(">1<", ">2<").replace(">0</VerseOrder", ">1</VerseOrder")
import shutil; shutil.rmtree(TMP + "/g")
kt.cmd_ganjoor(args)
b = json.loads(next(Path(TMP + "/g").glob("*.khanesh.json")).read_text())
check("ganjoor 1-based verse numbers", [c["s"] for c in b["cues"]] == [2000, 6000, 10000, 14000] and b["cues"][0]["t"].startswith("الا"), b["cues"])

# 3. ALTO editing for training
alto = """<?xml version="1.0" encoding="UTF-8"?>
<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#"><Layout><Page><PrintSpace><TextBlock ID="b1">
<TextLine ID="line_1" HPOS="10" VPOS="20" WIDTH="300" HEIGHT="40" BASELINE="10 50 310 50"><Shape><Polygon POINTS="10 20 310 20 310 60 10 60"/></Shape><String CONTENT="غلط" HPOS="10" VPOS="20" WIDTH="300" HEIGHT="40"/></TextLine>
<TextLine ID="line_2" HPOS="10" VPOS="70" WIDTH="300" HEIGHT="40" BASELINE="10 100 310 100"><Shape><Polygon POINTS="10 70 310 70 310 110 10 110"/></Shape><String CONTENT="دوم" HPOS="10" VPOS="70" WIDTH="300" HEIGHT="40"/></TextLine>
</TextBlock></PrintSpace></Page></Layout></alto>"""
Path(TMP + "/p.xml").write_text(alto, encoding="utf-8")
lines = kt.alto_lines(TMP + "/p.xml")
check("alto lines read with boxes", [l[0] for l in lines] == ["line_1", "line_2"] and lines[0][2] == (10, 20, 310, 60), lines)
kt.alto_set_text(TMP + "/p.xml", {"line_1": "درست است"})
lines = kt.alto_lines(TMP + "/p.xml")
check("alto correction written", lines[0][1] == "درست است" and lines[1][1] == "دوم", lines)
check("alto keeps namespace", 'xmlns="http://www.loc.gov/standards/alto/ns-v4#"' in Path(TMP + "/p.xml").read_text(), Path(TMP + "/p.xml").read_text()[:200])

# 4. page XML names its image relative to itself (kraken resolves it from the XML's folder)
import re as _re, shutil
d = Path(TMP + "/gt/pages"); d.mkdir(parents=True, exist_ok=True)
(d / "scan1.png").write_bytes(b"\x89PNG fake")
src = alto.replace("<Layout>", "<Description><sourceImageInformation><fileName>gt/pages/scan1.png</fileName></sourceImageInformation></Description><Layout>")
(d / "scan1.xml").write_text(src, encoding="utf-8")
ok = kt.alto_point_to_image(d / "scan1.xml")
fn = _re.search(r"<fileName>([^<]*)</fileName>", (d / "scan1.xml").read_text()).group(1)
check("alto image path repaired", ok and fn == "scan1.png", fn)
(d / "scan1.xml").write_text(src.replace("gt/pages/scan1.png", "/somewhere/else/old-name.png"), encoding="utf-8")
ok = kt.alto_point_to_image(d / "scan1.xml")
fn = _re.search(r"<fileName>([^<]*)</fileName>", (d / "scan1.xml").read_text()).group(1)
check("alto image found by page name", ok and fn == "scan1.png", fn)
(d / "scan1.png").unlink()
check("alto missing image reported", kt.alto_point_to_image(d / "scan1.xml") is False)
shutil.rmtree(TMP + "/gt")
# 'models' runs kraken in UTF-8 mode (on Windows kraken otherwise fails with a UnicodeDecodeError),
# and only blames the connection when the connection is the problem
import os, subprocess, tempfile
fake = Path(tempfile.mkdtemp())
def models_with(body):
    (fake / "kraken").write_text("#!/usr/bin/env python3\nimport os, sys\n" + body)
    (fake / "kraken").chmod(0o755)
    r = subprocess.run([sys.executable, str(ROOT / "tools" / "khanesh_tools.py"), "models"], capture_output=True, text=True, encoding="utf-8",
                       env={**os.environ, "PATH": f"{fake}{os.pathsep}{os.environ['PATH']}"})
    return r.stdout + r.stderr
out = models_with("""if os.environ.get('PYTHONUTF8') != '1':
    sys.stderr.write("UnicodeDecodeError: 'charmap' codec can't decode byte 0x8d\\n"); sys.exit(1)
print('10.5281/zenodo.123  Persian Naskh print  نسخ')
""")
check("models: kraken runs in UTF-8 mode, Persian names come through", "Persian Naskh print  نسخ" in out, out)
out = models_with("""import sys
print('╭──────────────╮')
print('│ ├── 10.5281/zenodo.14585602 │ Printed Urdu Base Model trained on │ recognition │ automatic-text │')
print('│                             │ the OpenITI corpus                 │             │                │')
print('│ ├── 10.5281/zenodo.7050270  │ Persian Base Model (OpenITI)       │ recognition │ automatic-text │')
print('│ ├── 10.5281/zenodo.6657809  │ Medieval Latin                     │ recognition │ latin          │')
print('│ ├── 10.5281/zenodo.8888888  │ Arabic-Script baseline             │ segmentation│ arabic         │')
""")
lines = [l for l in out.splitlines() if l.startswith("10.5281/")]
check("models: one tidy line per model, with its ID, whole name and type",
      lines == ["10.5281/zenodo.14585602  Printed Urdu Base Model trained on the OpenITI corpus  (recognition)",
                "10.5281/zenodo.7050270   Persian Base Model (OpenITI)  (recognition)",
                "10.5281/zenodo.8888888   Arabic-Script baseline  (segmentation)"] and "khanesh_tools.py get" in out, out)
def get_with(body, mid="10.5281/zenodo.7050270"):
    (fake / "kraken").write_text("#!/usr/bin/env python3\nimport os, sys\n" + body)
    (fake / "kraken").chmod(0o755)
    r = subprocess.run([sys.executable, str(ROOT / "tools" / "khanesh_tools.py"), "get", mid], capture_output=True, text=True, encoding="utf-8",
                       env={**os.environ, "PATH": f"{fake}{os.pathsep}{os.environ['PATH']}"})
    return r.stdout + r.stderr
out = get_with("""if os.environ.get('PYTHONUTF8') != '1':
    sys.stderr.write("UnicodeDecodeError: 'charmap' codec can't decode byte 0x8d\\n"); sys.exit(1)
assert sys.argv[1:] == ['get', '10.5281/zenodo.7050270']
print('Model name: Persian Base Model')
print("Model files: ['C:\\\\Users\\\\austi\\\\AppData\\\\Local\\\\htrmopo\\\\abc\\\\persian.safetensors']")
""")
check("get: downloads in UTF-8 mode and says where the file went", "Saved: C:\\Users\\austi\\AppData\\Local\\htrmopo\\abc\\persian.safetensors" in out and "--model" in out, out)
out = get_with("""print('Processing 100%')
print('Model dir: /home/u/.local/share/htrmopo/a4e5e69f (model files: persian_best.mlmodel)')
""")
check("get: newer kraken's 'Model dir … (model files: …)' becomes one full path", "Saved: /home/u/.local/share/htrmopo/a4e5e69f/persian_best.mlmodel" in out and '--model "/home/u/.local/share/htrmopo/a4e5e69f/persian_best.mlmodel"' in out, out)
out = get_with("sys.stderr.write('ValueError: no such model\\n'); sys.exit(1)\n", "10.5281/zenodo.0")
check("get: a failed download says why", "couldn't download that model" in out and "no such model" in out, out)
out = models_with("sys.stderr.write('requests.exceptions.ConnectionError: Max retries exceeded\\n'); sys.exit(1)\n")
check("models: a connection problem is called one", "Couldn't reach kraken's model repository" in out, out)
out = models_with("sys.stderr.write('ValueError: something else\\n'); sys.exit(1)\n")
check("models: other errors aren't blamed on the connection", "kraken couldn't list its models" in out and "ValueError: something else" in out and "internet" not in out, out)
r = subprocess.run([sys.executable, str(ROOT / "tools" / "khanesh_tools.py"), "prepare", "book.pdf", "-p", "16-25", "--model", "C:\\…\\persian_best.mlmodel"],
                   capture_output=True, text=True, encoding="utf-8", cwd=str(fake))
check("prepare: a model path that doesn't exist stops it before any work, explaining the '…'",
      r.returncode != 0 and "Can't find the model" in r.stderr + r.stdout and "whole path" in r.stderr + r.stdout and not (fake / "training").exists(), r.stderr + r.stdout)
# optional holdout: 'train --holdout' sets corrected pages aside, 'check' measures models on them
gt = fake / "gt"; (gt / "pages").mkdir(parents=True)
corr = {}
for n in range(1, 6):
    (gt / "pages" / f"p{n}.png").write_bytes(b"\x89PNG fake")
    (gt / "pages" / f"p{n}.xml").write_text(alto.replace("<Layout>", f"<Description><sourceImageInformation><fileName>p{n}.png</fileName></sourceImageInformation></Description><Layout>"), encoding="utf-8")
    corr[f"p{n}::line_1"] = f"سطر {n}"; corr[f"p{n}::line_2"] = "دوم"
(gt / "corrections.json").write_text(json.dumps({"lines": corr}, ensure_ascii=False), encoding="utf-8")
(fake / "base.mlmodel").write_bytes(b"m")
(fake / "ketos").write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
log = Path(os.environ["KETOS_LOG"]); log.write_text(log.read_text() + json.dumps(args) + "\\n" if log.exists() else json.dumps(args) + "\\n")
if os.environ.get('PYTHONUTF8') != '1': sys.exit(3)
if 'train' in args:
    out = Path(args[args.index('-o') + 1]); out.mkdir(parents=True, exist_ok=True); (out / 'model_best.mlmodel').write_bytes(b'x')
elif 'test' in args:
    m = args[args.index('-m') + 1]
    if os.environ.get('KETOS_STYLE') == 'rich':
        print('│ Character Accuracy │ ' + ('81.20' if 'base' in m else '94.70') + '% │'); print('│ Word Accuracy │ ' + ('60.30' if 'base' in m else '85.10') + '% │')
    else:
        print('=== report ===\\n\\n230\\tCharacters\\n12\\tErrors\\n' + ('81.20' if 'base' in m else '94.70') + '%\\tAccuracy\\n\\n' + ('60.30' if 'base' in m else '85.10') + '%\\tWord Accuracy')
""", encoding="utf-8"); (fake / "ketos").chmod(0o755)
log = fake / "ketos.log"
shutil.copy(ROOT / "tools" / "khanesh_tools.py", fake / "khanesh_tools.py")   # a project folder: the script, a book, what it makes
def tools(*args, style=""):
    if log.exists(): log.unlink()
    r = subprocess.run([sys.executable, str(fake / "khanesh_tools.py"), *args], capture_output=True, text=True, encoding="utf-8", cwd=str(fake),
                       env={**os.environ, "PATH": f"{fake}{os.pathsep}{os.environ['PATH']}", "KETOS_LOG": str(log), "KETOS_STYLE": style})
    calls = [json.loads(l) for l in log.read_text().splitlines()] if log.exists() else []
    return r.stdout + r.stderr, calls
out, calls = tools("train", "gt", "--base", "base.mlmodel", "--name", "mine")
trained = [Path(x).name for x in calls[0] if x.endswith(".xml")]
check("train without --holdout uses every corrected page, as before", trained == [f"p{n}.xml" for n in range(1, 6)] and not (gt / "holdout.txt").exists() and "check" not in out, (trained, out))
out, calls = tools("train", "gt", "--base", "base.mlmodel", "--name", "mine", "--holdout", "2")
trained = [Path(x).name for x in calls[0] if x.endswith(".xml")]
held = (gt / "holdout.txt").read_text().split()
check("--holdout sets pages aside, spread through the book, and never trains on them", len(held) == 2 and not set(held) & set(trained) and len(trained) == 3 and held != ["p4.xml", "p5.xml"], (held, trained))
check("train says how to check the model", "khanesh_tools.py check" in out and "--base" in out, out)
out, calls = tools("train", "gt", "--base", "base.mlmodel", "--name", "mine")
trained = [Path(x).name for x in calls[0] if x.endswith(".xml")]
check("retraining keeps the same pages aside", not set(held) & set(trained) and len(trained) == 3 and "Keeping the 2 pages" in out, (trained, out))
out, _ = tools("check", "gt", "--model", "models/mine/model_best.mlmodel", "--base", "base.mlmodel")
check("check compares both models on the set-aside pages", "Checked on 2 pages" in out and "81.2%" in out and "94.7%" in out and "85.1%" in out and "13.5 more characters" in out, out)
out, _ = tools("check", "gt", "--model", "models/mine/model_best.mlmodel", "--base", "base.mlmodel", style="rich")
check("check reads kraken's newer report layout too", "81.2%" in out and "94.7%" in out and "60.3%" in out, out)
out, _ = tools("train", "gt", "--base", "base.mlmodel", "--name", "mine", "--holdout", "0")
check("--holdout 0 gives the pages back to training", not (gt / "holdout.txt").exists())
out, _ = tools("check", "gt", "--model", "models/mine/model_best.mlmodel")
check("check without set-aside pages says how to set some aside", "No pages were set aside" in out and "--holdout 2" in out, out)
out, _ = tools("train", "gt", "--base", "base.mlmodel", "--name", "mine", "--holdout", "4")
check("too many pages set aside is refused", "would leave 1 to train on" in out, out)
runs_ = json.loads((gt / "history.json").read_text(encoding="utf-8"))
check("train logs each run for stats", len(runs_) >= 3 and runs_[1]["set_aside"] == 2 and runs_[1]["model"].endswith("model_best.mlmodel") and runs_[0]["set_aside"] == 0, runs_)
# optional 'stats': lines per page, what was changed, what the model got wrong, training runs
st = fake / "st" / "training"; st.mkdir(parents=True)
book = "فرهنگ.pdf"; lines_ = []; corr2 = {}
model_ = {16: ["اسب: حيوان", "بهار", "صفحه ۱۶"], 17: ["پيمه: پيمانه"]}
yours_ = {16: ["اسب: حیوان", "بهار", None], 17: ["پیمه: پیمانه"]}
for pg, ls in model_.items():
    for i, t_ in enumerate(ls):
        lid = f"page-{pg:03d}::l{i}"; lines_.append({"id": lid, "img": "x.png", "text": t_, "page": f"{book} page {pg}"}); corr2[lid] = yours_[pg][i]
(st / "correct.html").write_text(kt.CORRECT_HTML.replace("__DATA__", json.dumps({"id": "training", "dir": "rtl", "lang": "mzn", "lines": lines_}, ensure_ascii=False)), encoding="utf-8")
out, _ = tools("stats", str(st))
check("stats before corrections are saved says so", "not corrected yet" in out and "4 lines on 2 pages" in out, out)
(st / "corrections.json").write_text(json.dumps({"lines": corr2}, ensure_ascii=False), encoding="utf-8")
(st / "holdout.txt").write_text("page-017.xml\n")
kt.log_training(st, {"model": "/m/mine_best.mlmodel", "base": "/m/persian_best.mlmodel", "lines": 2, "pages": 1, "set_aside": 1})
out, _ = tools("stats", str(st))
check("stats: where the lines came from", f"Lines from: {book}, pages 16–17" in out, out)
check("stats: lines per page, changed, kept, left out, set aside", "p.16      3        1     1         1" in out and "p.17      1        1     0         0" in out and "set aside" in out, out)
check("stats: totals and what's trained on", "3 lines ready for training: you changed 2 and kept 1" in out and "on the 1 page set aside for 'check', so 2 are trained on" in out, out)
check("stats: the letters you fixed most, named when they look alike", "ي → ی   3×   (yeh → farsi yeh)" in out, out)
check("stats: training runs", "2 lines on 1 page, 1 page set aside from persian_best.mlmodel → /m/mine_best.mlmodel" in out, out)
# a project folder: short names work from anywhere, and what the script makes lands in models/, outputs/, training/
proj = Path(tempfile.mkdtemp()) / "Zabanestan OCR"; proj.mkdir()
shutil.copy(ROOT / "tools" / "khanesh_tools.py", proj / "khanesh_tools.py")
from PIL import Image as _Img
_Img.new("RGB", (400, 120), "white").save(proj / "book.png")
bin_ = Path(tempfile.mkdtemp())
(bin_ / "page.xml").write_text(alto.replace("غلط", "درست"), encoding="utf-8")
(bin_ / "kraken").write_text("""#!/usr/bin/env python3
import sys, os, shutil
from pathlib import Path
a = sys.argv[1:]
if os.environ.get('PYTHONUTF8') != '1': sys.exit(3)
if a and a[0] == 'get':
    d = Path(os.environ['FAKE_STORE']); d.mkdir(parents=True, exist_ok=True); (d / 'persian_best.mlmodel').write_bytes(b'model')
    print(f'Model dir: {d} (model files: persian_best.mlmodel)'); sys.exit(0)
if 'ocr' in a: assert Path(a[a.index('-m') + 1]).is_file(), a
shutil.copy(Path(sys.argv[0]).parent / 'page.xml', a[a.index('-i') + 2])
""", encoding="utf-8"); (bin_ / "kraken").chmod(0o755)
home = Path(tempfile.mkdtemp())
def run_in(cwd, *args):
    r = subprocess.run([sys.executable, str(proj / "khanesh_tools.py"), *args], capture_output=True, text=True, encoding="utf-8", cwd=str(cwd),
                       env={**os.environ, "PATH": f"{bin_}{os.pathsep}{os.environ['PATH']}", "FAKE_STORE": str(home / "store")})
    return r.stdout + r.stderr
out = run_in(home, "get", "10.5281/zenodo.7051644")
check("get keeps a copy in models/ next to the script, and gives its short name", (proj / "models" / "persian_best.mlmodel").read_bytes() == b"model" and "--model models/persian_best.mlmodel" in out, out)
out = run_in(proj, "ocr", "book.png", "--model", "models/persian_best.mlmodel")
check("ocr saves the text in outputs/", (proj / "outputs" / "book.txt").read_text(encoding="utf-8").startswith("درست") and "outputs" in out, out)
out = run_in(home, "ocr", "book.png", "--model", "models/persian_best.mlmodel", "-o", str(home / "elsewhere.txt"))
check("short names work from another folder too", (home / "elsewhere.txt").exists(), out)
out = run_in(proj, "prepare", "book.png", "--model", "models/persian_best.mlmodel")
check("prepare makes training/ next to the script, and its next step uses short names",
      (proj / "training" / "correct.html").exists() and "train training --base models/persian_best.mlmodel --name my-model" in out, out)
# prepare again on the same folder adds pages, keeping corrections; remove takes pages out
_Img.new("RGB", (400, 120), "white").save(proj / "book2.png")
(proj / "training" / "corrections.json").write_text(json.dumps({"lines": {kt.read_gt(proj / "training")["lines"][0]["id"]: "تصحیح"}}, ensure_ascii=False), encoding="utf-8")
first = kt.read_gt(proj / "training")["lines"]
out = run_in(proj, "prepare", "book2.png", "book.png", "--model", "models/persian_best.mlmodel")
d2 = kt.read_gt(proj / "training")
check("prepare adds new pages to an existing folder", len(d2["lines"]) == 2 * len(first) and "already has" in out and "Added" in out, out)
check("prepare skips pages the folder already has", "book.png: already in this folder, skipped" in out, out)
check("earlier corrections ride along in the new correct.html", d2["lines"][0].get("fixed") == "تصحیح" and d2["lines"][0]["text"] != "تصحیح", d2["lines"][0])
check("correct.html prefers what the browser kept, then the carried-over correction", "saved[l.id] ?? l.fixed ?? l.text" in (proj / "training" / "correct.html").read_text(encoding="utf-8"), "")
out = run_in(proj, "remove", "training", "book2.png")
d3 = kt.read_gt(proj / "training")
check("remove takes a page out of correct.html and deletes its files", len(d3["lines"]) == len(first) and not (proj / "training" / "pages" / "book2.xml").exists() and not list((proj / "training" / "lines").glob("book2__*")) and "Removed 1 page" in out, out)
check("remove keeps the corrections for the other pages", json.loads((proj / "training" / "corrections.json").read_text(encoding="utf-8"))["lines"] and d3["lines"][0].get("fixed") == "تصحیح", d3)
out = run_in(proj, "remove", "training", "-p", "40")
check("remove says when the pages aren't there", "None of those pages" in out, out)
shutil.rmtree(proj.parent); shutil.rmtree(bin_); shutil.rmtree(home)
shutil.rmtree(fake)
print(f"\n{len(fails)} failures")

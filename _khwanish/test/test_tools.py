"""Checks for tools/khwanish_tools.py that need no network: captions, Ganjoor (with a fake API) and page XML."""
import sys, json, types, importlib.util, tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
TMP = tempfile.mkdtemp()
spec = importlib.util.spec_from_file_location("kt", str(ROOT / "tools" / "khwanish_tools.py"))
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
b = json.loads(next(Path(TMP + "/g").glob("*.khwanish.json")).read_text())
check("ganjoor cues for every verse", [c["s"] for c in b["cues"]] == [2000, 6000, 10000, 14000], b["cues"])
check("ganjoor couplet gaps", [c["gap"] for c in b["cues"]] == [False, False, True, False], [c["gap"] for c in b["cues"]])
check("ganjoor credit + source", b["credit"] == "Recited by Reciter A · Ganjoor" and b["source"].endswith("/hafez/ghazal/sh1"), b)
check("ganjoor mp3 saved", any(Path(TMP + "/g").glob("*.mp3")))
# 1-based sync numbering
sync0 = sync0.replace(">3<", ">4<").replace(">2<", ">3<").replace(">1<", ">2<").replace(">0</VerseOrder", ">1</VerseOrder")
import shutil; shutil.rmtree(TMP + "/g")
kt.cmd_ganjoor(args)
b = json.loads(next(Path(TMP + "/g").glob("*.khwanish.json")).read_text())
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
print(f"\n{len(fails)} failures")

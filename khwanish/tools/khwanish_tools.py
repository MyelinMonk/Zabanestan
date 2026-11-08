#!/usr/bin/env python3
"""Khwānish tools: get texts and recordings ready for the Khwānish reader.

  ocr      Turn a scanned PDF or photos of pages into a .txt file with kraken.
  prepare  Cut pages into lines and make a correction page (to train a model).
  train    Fine-tune a kraken model on the lines you corrected.
  models   List kraken models for Arabic-script languages.
  youtube  Download a video (or just its audio) with subtitles in its own language.
  ganjoor  Download a Ganjoor poem with a recitation and its verse timings.

Install what you need (tested with kraken 7.1 on Python 3.13):
  pip install kraken pymupdf     # ocr, prepare, train, models
  pip install yt-dlp             # youtube (ffmpeg recommended for HD video)
  pip install requests           # ganjoor

Run any command with --help for its options, e.g.  python khwanish_tools.py ocr --help
"""
import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

# ----------------------------------------------------------------------------
# shared helpers
# ----------------------------------------------------------------------------

def die(msg, code=1):
    print(f"\n{msg}", file=sys.stderr)
    sys.exit(code)


def need(module, pip_name=None):
    try:
        return __import__(module)
    except ImportError:
        die(f"This command needs the '{pip_name or module}' package. Install it with:\n  pip install {pip_name or module}")


def safe_name(s, fallback="untitled"):
    s = unicodedata.normalize("NFC", str(s or "")).strip()
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", s)
    s = re.sub(r"\s+", " ", s).strip(" .")
    return (s or fallback)[:120]


def parse_pages(spec, count):
    """'1-5,8' -> [1,2,3,4,5,8] (1-based, clipped to the document)."""
    if not spec:
        return list(range(1, count + 1))
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            a = int(a) if a else 1
            b = int(b) if b else count
            out.extend(range(a, b + 1))
        else:
            out.append(int(part))
    return [p for p in dict.fromkeys(out) if 1 <= p <= count]


def page_images(inputs, pages_spec, dpi, workdir):
    """Render PDFs (with PyMuPDF) and collect images. Returns [(label, path)]."""
    workdir.mkdir(parents=True, exist_ok=True)
    out = []
    for inp in inputs:
        p = Path(inp)
        if not p.exists():
            die(f"Can't find {p}")
        if p.suffix.lower() == ".pdf":
            fitz = need("fitz", "pymupdf")
            doc = fitz.open(str(p))
            for n in parse_pages(pages_spec, doc.page_count):
                pix = doc[n - 1].get_pixmap(dpi=dpi)
                img = workdir / f"{safe_name(p.stem)}_p{n:04d}.png"
                pix.save(str(img))
                out.append((f"{p.name} page {n}", img))
        else:
            out.append((p.name, p))
    if not out:
        die("No pages to work on. Check the file names and --pages.")
    return out


def kraken_bin(name="kraken"):
    exe = shutil.which(name)
    if not exe:
        here = Path(sys.executable).parent / name
        if here.exists():
            exe = str(here)
    if not exe:
        die(f"Can't find the '{name}' command. Install kraken with:\n  pip install kraken")
    return exe


def run(cmd, quiet=False):
    if not quiet:
        print("  $ " + " ".join(str(c) for c in cmd))
    r = subprocess.run([str(c) for c in cmd], capture_output=quiet, text=True)
    if r.returncode != 0:
        if quiet:
            sys.stderr.write((r.stdout or "") + (r.stderr or ""))
        die(f"'{Path(str(cmd[0])).name}' stopped with an error (exit code {r.returncode}).")
    return r


# ----------------------------------------------------------------------------
# kraken: page XML helpers (ALTO, which kraken writes and trains on)
# ----------------------------------------------------------------------------

def _alto_ns(root):
    m = re.match(r"\{([^}]*)\}", root.tag)
    return m.group(1) if m else ""


def alto_lines(path):
    """[(line_id, text, (x0, y0, x1, y1))] in reading order."""
    import xml.etree.ElementTree as ET
    tree = ET.parse(path)
    root = tree.getroot()
    ns = _alto_ns(root)
    q = (lambda t: f"{{{ns}}}{t}") if ns else (lambda t: t)
    out = []
    for tl in root.iter(q("TextLine")):
        lid = tl.get("ID") or f"line{len(out)}"
        words = [s.get("CONTENT", "") for s in tl.iter(q("String"))]
        text = " ".join(w for w in words if w)
        box = None
        poly = tl.find(f"{q('Shape')}/{q('Polygon')}")
        if poly is not None and poly.get("POINTS"):
            nums = [float(v) for v in re.split(r"[\s,]+", poly.get("POINTS").strip()) if v]
            xs, ys = nums[0::2], nums[1::2]
            box = (min(xs), min(ys), max(xs), max(ys))
        elif tl.get("HPOS") is not None:
            x, y = float(tl.get("HPOS")), float(tl.get("VPOS"))
            box = (x, y, x + float(tl.get("WIDTH", 0)), y + float(tl.get("HEIGHT", 0)))
        out.append((lid, text, box))
    return out


def alto_set_text(path, texts):
    """Replace each TextLine's text with texts[line_id] (one String per line)."""
    import xml.etree.ElementTree as ET
    tree = ET.parse(path)
    root = tree.getroot()
    ns = _alto_ns(root)
    if ns:
        ET.register_namespace("", ns)
    q = (lambda t: f"{{{ns}}}{t}") if ns else (lambda t: t)
    changed = 0
    for tl in root.iter(q("TextLine")):
        lid = tl.get("ID")
        if lid not in texts:
            continue
        for child in list(tl):
            if child.tag in (q("String"), q("SP")):
                tl.remove(child)
        s = ET.SubElement(tl, q("String"))
        s.set("CONTENT", texts[lid])
        for attr in ("HPOS", "VPOS", "WIDTH", "HEIGHT"):
            if tl.get(attr) is not None:
                s.set(attr, tl.get(attr))
        changed += 1
    tree.write(path, encoding="utf-8", xml_declaration=True)
    return changed


IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp")


def alto_point_to_image(xml, img=None):
    """Make the page XML name its image relative to the XML's own folder.

    kraken resolves <fileName> against the XML's folder when it trains, so a path
    written relative to wherever the command ran ends up pointing nowhere. Saving
    just the relative path also keeps a training folder working after it's moved.
    """
    import xml.etree.ElementTree as ET
    xml = Path(xml)
    tree = ET.parse(xml)
    root = tree.getroot()
    ns = _alto_ns(root)
    if ns:
        ET.register_namespace("", ns)
    q = (lambda t: f"{{{ns}}}{t}") if ns else (lambda t: t)
    node = root.find(f".//{q('sourceImageInformation')}/{q('fileName')}")
    if node is None:
        return False
    if img is None:
        # find the image next to the XML: the name it already records, else the same stem
        named = xml.parent / Path((node.text or "").strip()).name
        if named.name and named.exists():
            img = named
        else:
            img = next((p for p in sorted(xml.parent.glob(xml.stem + ".*")) if p.suffix.lower() in IMAGE_SUFFIXES), None)
        if img is None:
            return False
    rel = os.path.relpath(Path(img).resolve(), xml.resolve().parent)
    if node.text == rel:
        return True
    node.text = rel
    tree.write(xml, encoding="utf-8", xml_declaration=True)
    return True


def segment_to_alto(img, xml_out, model=None, text_direction="horizontal-rl"):
    """Run kraken's baseline segmenter (and recognition, if a model is given) into ALTO."""
    img, xml_out = Path(img).resolve(), Path(xml_out).resolve()
    cmd = [kraken_bin(), "-a", "-i", str(img), str(xml_out), "segment", "-bl", "-d", text_direction]
    if model:
        cmd += ["ocr", "-m", str(Path(model).resolve()), "--base-dir", "R" if text_direction.endswith("-rl") else "L"]
    run(cmd, quiet=True)
    alto_point_to_image(xml_out, img)


# ----------------------------------------------------------------------------
# ocr
# ----------------------------------------------------------------------------

def cmd_ocr(a):
    if not a.model:
        die("Choose a recognition model with --model (a .mlmodel or .safetensors file).\n"
            "Run 'python khwanish_tools.py models' to find one, or train your own with 'prepare' and 'train'.")
    if not Path(a.model).exists():
        die(f"Can't find the model {a.model}")
    work = Path(a.workdir or (Path(a.inputs[0]).with_suffix("").as_posix() + "_ocr"))
    pages = page_images(a.inputs, a.pages, a.dpi, work)
    out_txt = Path(a.out or (Path(a.inputs[0]).with_suffix(".txt")))
    texts = []
    for i, (label, img) in enumerate(pages, 1):
        print(f"[{i}/{len(pages)}] {label}")
        xml = work / (Path(img).stem + ".xml")
        segment_to_alto(img, xml, a.model, a.direction)
        lines = [t for _, t, _ in alto_lines(xml) if t.strip()]
        texts.append("\n".join(lines))
    out_txt.write_text("\n\n".join(t for t in texts if t).strip() + "\n", encoding="utf-8")
    print(f"\nSaved {out_txt}\nImport it in Khwānish with “Import a file”.")


# ----------------------------------------------------------------------------
# prepare: line images + a correction page
# ----------------------------------------------------------------------------

CORRECT_HTML = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Correct lines · Khwānish</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f3f4f1;color:#1b2131}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #d8dce3;padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:2}
header b{margin-inline-end:auto}
main{max-width:1100px;margin:0 auto;padding:16px}
.line{background:#fff;border:1px solid #d8dce3;border-radius:12px;padding:10px;margin:0 0 10px;display:grid;gap:6px}
.line img{max-width:100%;height:auto;background:#fff;image-rendering:auto}
.line input:not([type]){font:22px/1.6 "Noto Naskh Arabic","Noto Serif",serif;padding:6px 10px;border:1px solid #d8dce3;border-radius:8px;width:100%;box-sizing:border-box}
.meta input{margin:0}
.line.skip{opacity:.45}
.meta{display:flex;gap:10px;align-items:center;font-size:12px;color:#5d6578}
button{font:inherit;padding:8px 14px;border-radius:10px;border:1px solid #27449f;background:#27449f;color:#fff;cursor:pointer}
button.ghost{background:#fff;color:#27449f}
</style></head><body>
<header><b>Correct the text under each line, then save</b><span id="count"></span>
<button class="ghost" id="restore" type="button">Load a saved file</button><button id="save" type="button">Save corrections</button></header>
<main id="lines"></main>
<script>
const DATA = __DATA__;
const box = document.getElementById('lines');
const key = 'khwanish-corrections-' + DATA.id;
let saved = {};
try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) {}
for (const l of DATA.lines) {
  const d = document.createElement('div'); d.className = 'line';
  const img = document.createElement('img'); img.src = l.img; img.alt = l.id; img.loading = 'lazy';
  const inp = document.createElement('input'); inp.dir = DATA.dir; inp.lang = DATA.lang; inp.value = saved[l.id] ?? l.text; inp.dataset.id = l.id;
  const meta = document.createElement('label'); meta.className = 'meta';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!(saved['__skip__' + l.id]);
  cb.onchange = () => { d.classList.toggle('skip', cb.checked); store(); };
  d.classList.toggle('skip', cb.checked);
  meta.append(cb, document.createTextNode(' Leave this line out (bad cut, picture, page number) · ' + l.page));
  inp.oninput = store; inp.dataset.skip = '';
  d.append(img, inp, meta); d._cb = cb; box.append(d);
}
function collect() {
  const out = {};
  for (const d of box.children) { const inp = d.querySelector('input:not([type])'); out[inp.dataset.id] = d._cb.checked ? null : inp.value; }
  return out;
}
function store() {
  const o = {};
  for (const d of box.children) { const inp = d.querySelector('input:not([type])'); o[inp.dataset.id] = inp.value; if (d._cb.checked) o['__skip__' + inp.dataset.id] = 1; }
  try { localStorage.setItem(key, JSON.stringify(o)); } catch (e) {}
  document.getElementById('count').textContent = DATA.lines.length + ' lines';
}
store();
document.getElementById('save').onclick = () => {
  const blob = new Blob([JSON.stringify({ app: 'khwanish-gt', id: DATA.id, lines: collect() }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'corrections.json'; a.click();
};
document.getElementById('restore').onclick = () => {
  const f = document.createElement('input'); f.type = 'file'; f.accept = '.json';
  f.onchange = async () => { const j = JSON.parse(await f.files[0].text()); for (const d of box.children) { const inp = d.querySelector('input:not([type])'); const v = j.lines[inp.dataset.id]; if (v === null) { d._cb.checked = true; d.classList.add('skip'); } else if (typeof v === 'string') inp.value = v; } store(); };
  f.click();
};
</script></body></html>
"""


def cmd_prepare(a):
    need("PIL", "pillow")
    from PIL import Image
    out = Path(a.out)
    (out / "lines").mkdir(parents=True, exist_ok=True)
    pages = page_images(a.inputs, a.pages, a.dpi, out / "pages")
    data = {"id": out.resolve().name, "dir": "ltr" if a.direction == "horizontal-lr" else "rtl", "lang": a.lang, "lines": []}
    for i, (label, img) in enumerate(pages, 1):
        print(f"[{i}/{len(pages)}] {label}")
        img = Path(img)
        if img.parent != out / "pages":
            dst = out / "pages" / img.name
            shutil.copy(img, dst)
            img = dst
        xml = img.with_suffix(".xml")
        segment_to_alto(img, xml, a.model, a.direction)
        with Image.open(img) as im:
            for lid, text, box in alto_lines(xml):
                if not box:
                    continue
                x0, y0, x1, y1 = box
                pad = max(4, int((y1 - y0) * 0.15))
                crop = im.crop((max(0, int(x0) - pad), max(0, int(y0) - pad), min(im.width, int(x1) + pad), min(im.height, int(y1) + pad)))
                name = f"{img.stem}__{lid}.png"
                crop.save(out / "lines" / name)
                data["lines"].append({"id": f"{img.stem}::{lid}", "img": f"lines/{name}", "text": text, "page": label})
    page = CORRECT_HTML.replace("__DATA__", json.dumps(data, ensure_ascii=False))
    (out / "correct.html").write_text(page, encoding="utf-8")
    print(f"\n{len(data['lines'])} lines ready in {out}/"
          f"\n1. Open {out / 'correct.html'} in your browser and fix the text under each line."
          f"\n   (Your edits are remembered in that browser. Tick “Leave this line out” for bad cuts.)"
          f"\n2. Click “Save corrections” and move corrections.json into {out}/"
          f"\n3. Run:  python khwanish_tools.py train {out}" + (f" --base {a.model}" if a.model else " --base YOUR_MODEL") + " --name my-model")


# ----------------------------------------------------------------------------
# train: write corrections into the page XML, then ketos
# ----------------------------------------------------------------------------

def cmd_train(a):
    gt = Path(a.folder)
    corr_path = Path(a.corrections) if a.corrections else gt / "corrections.json"
    if not corr_path.exists():
        die(f"Can't find {corr_path}. Save it from correct.html first (or pass --corrections PATH).")
    corr = json.loads(corr_path.read_text(encoding="utf-8")).get("lines", {})
    by_page = {}
    for lid, text in corr.items():
        stem, _, line = lid.partition("::")
        by_page.setdefault(stem, {})[line] = text
    xmls = []
    skipped = kept = 0
    import xml.etree.ElementTree as ET
    for stem, lines in by_page.items():
        xml = gt / "pages" / f"{stem}.xml"
        if not xml.exists():
            print(f"  (no page file for {stem}, skipping)")
            continue
        keep = {k: v.strip() for k, v in lines.items() if isinstance(v, str) and v.strip()}
        drop = {k for k, v in lines.items() if v is None or not str(v).strip()}
        alto_set_text(xml, keep)
        # remove lines that were left out so they don't train on empty text
        tree = ET.parse(xml)
        root = tree.getroot()
        ns = _alto_ns(root)
        if ns:
            ET.register_namespace("", ns)
        q = (lambda t: f"{{{ns}}}{t}") if ns else (lambda t: t)
        for parent in root.iter():
            for tl in list(parent):
                if tl.tag == q("TextLine") and tl.get("ID") in drop:
                    parent.remove(tl)
        tree.write(xml, encoding="utf-8", xml_declaration=True)
        if not alto_point_to_image(xml):
            print(f"  (can't find the page image for {stem} next to {xml.name}, skipping)")
            continue
        kept += len(keep)
        skipped += len(drop)
        xmls.append(xml)
    if not xmls:
        die("No corrected pages found.")
    print(f"{kept} corrected lines on {len(xmls)} pages ({skipped} left out).")
    if kept < 50:
        print("Tip: fine-tuning works best with a few hundred corrected lines; more pages give better results.")
    outdir = Path(a.name)
    cmd = [kraken_bin("ketos")]
    if a.device:
        cmd += ["-d", a.device]
    cmd += ["train", "-f", "alto", "-o", str(outdir)]
    if a.epochs:
        cmd += ["-q", "fixed", "-N", str(a.epochs)]
    if a.base:
        if not Path(a.base).exists():
            die(f"Can't find the base model {a.base}")
        cmd += ["-i", a.base, "--resize", "union"]
    cmd += [str(x) for x in xmls]
    print("Training. This can take a while on a laptop; a GPU makes it much faster.")
    run(cmd)
    weights = [p for p in outdir.rglob("*") if p.suffix in (".safetensors", ".mlmodel")]
    best = sorted([p for p in weights if "best" in p.name.lower()] or weights, key=lambda p: p.stat().st_mtime)
    if not best:
        die(f"Training finished but no model file was found in {outdir}/.")
    print(f"\nDone. Your model: {best[-1]}\nUse it with:\n  python khwanish_tools.py ocr BOOK.pdf --model {best[-1]}")
    if any(p.suffix == ".ckpt" for p in outdir.glob("*")):
        print(f"(The .ckpt files in {outdir}/ are only for resuming training; delete them to free up space.)")


# ----------------------------------------------------------------------------
# models
# ----------------------------------------------------------------------------

def cmd_models(a):
    r = subprocess.run([kraken_bin(), "list"], capture_output=True, text=True)
    if r.returncode != 0:
        err = [l.strip(" │╰╮╭╯─") for l in (r.stderr or r.stdout or "").splitlines()]
        err = [l for l in err if l]
        start = max((i for i, l in enumerate(err) if re.match(r"^[A-Za-z_.]*(Error|Exception)\b", l)), default=max(0, len(err) - 3))
        reason = re.sub(r"\s+", " ", " ".join(err[start:]))[:400]
        die("Couldn't reach kraken's model repository (it lives on zenodo.org). "
            "Check your internet connection and try again.\n  " + reason)
    words = [w.lower() for w in (a.search or ["arab", "persian", "farsi", "fas", "urdu", "urd", "ara", "nastaliq", "naskh", "openiti", "kitab"])]
    hits = [l for l in r.stdout.splitlines() if any(w in l.lower() for w in words)]
    print("\n".join(hits) if hits else "No matching models. Run 'kraken list' to see everything.")
    print("\nDownload one with:  kraken get <ID from the first column>\n"
          "Then use it with:   python khwanish_tools.py ocr BOOK.pdf --model <the downloaded file>")


# ----------------------------------------------------------------------------
# timed text helpers (shared by youtube and ganjoor)
# ----------------------------------------------------------------------------

def vtt_to_cues(text):
    def tc(s):
        m = re.match(r"^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$", s.strip())
        if not m:
            return None
        return ((int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3))) * 1000
                + (int(m.group(4).ljust(3, "0")) if m.group(4) else 0))

    def strip(t):
        t = re.sub(r"<\d{1,2}:\d{2}[:.\d]*>", "", t)
        t = re.sub(r"</?[a-zA-Z][^>]*>", "", t)
        t = re.sub(r"\{\\[^}]*\}", "", t)
        return re.sub(r"[ \t]+", " ", html.unescape(t)).strip()

    cues, prev = [], []
    for block in re.split(r"\n{2,}", text.replace("\r\n", "\n").replace("\r", "\n")):
        lines = [l for l in block.split("\n") if l.strip()]
        ti = next((i for i, l in enumerate(lines) if "-->" in l), -1)
        if ti < 0:
            continue
        a, _, rest = lines[ti].partition("-->")
        s, e = tc(a), tc(rest.strip().split()[0] if rest.strip() else "")
        if s is None or e is None:
            continue
        tl = [strip(l) for l in lines[ti + 1:]]
        tl = [l for l in tl if l]
        fresh = [l for l in tl if l not in prev]
        prev = tl
        t = " ".join(fresh).strip()
        if t:
            cues.append({"s": s, "e": max(e, s + 1), "t": t})
    merged = []
    for c in cues:
        if merged and merged[-1]["t"] == c["t"] and c["s"] - merged[-1]["e"] < 1500:
            merged[-1]["e"] = max(merged[-1]["e"], c["e"])
        else:
            merged.append(c)
    return merged


def write_bundle(folder, title, lang, cues, source, credit):
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{safe_name(title)}.khwanish.json"
    path.write_text(json.dumps({"app": "khwanish-media", "v": 1, "title": title, "lang": lang,
                                "source": source, "credit": credit, "cues": cues}, ensure_ascii=False, indent=1),
                    encoding="utf-8")
    return path


# ----------------------------------------------------------------------------
# youtube
# ----------------------------------------------------------------------------

def cmd_youtube(a):
    yt_dlp = need("yt_dlp", "yt-dlp")
    out = Path(a.out)
    with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True, "noplaylist": True}) as ydl:
        info = ydl.extract_info(a.url, download=False)
    title = info.get("title") or "video"
    lang = (a.lang or info.get("language") or "").split("-")[0]
    manual = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}

    def find(d, *keys):
        for k in keys:
            if k in d:
                return k
        return None

    chosen, kind = None, None
    if lang:
        chosen = find(manual, lang, *[k for k in manual if k.split("-")[0] == lang])
        kind = "manual" if chosen else None
        if not chosen:
            chosen = find(auto, f"{lang}-orig", lang)
            kind = "automatic" if chosen else None
    elif len(manual) == 1:
        chosen, kind = next(iter(manual)), "manual"
    if not chosen:
        print(f"“{title}”")
        print("Subtitles on this video: " + (", ".join(sorted(manual)) or "none"))
        origs = sorted(k for k in auto if k.endswith("-orig"))
        print("Automatic captions in the spoken language: " + (", ".join(origs) or "none"))
        die("No subtitles in the video's own language were found." + ("" if lang else " Pass --lang (e.g. --lang fa) to choose one."))
    print(f"“{title}”: using {kind} subtitles ({chosen})")
    has_ffmpeg = bool(shutil.which("ffmpeg"))
    if a.audio_only:
        fmt = "ba[ext=m4a]/ba"
    elif has_ffmpeg:
        fmt = f"bv*[height<={a.height}][ext=mp4]+ba[ext=m4a]/b[height<={a.height}][ext=mp4]/b[height<={a.height}]/b"
    else:
        fmt = f"b[height<={a.height}][ext=mp4]/b[ext=mp4]/b"
        print("(ffmpeg isn't installed, so the video may be lower quality. Install ffmpeg for HD.)")
    base = safe_name(title)
    opts = {
        "format": fmt, "outtmpl": str(out / f"{base}.%(ext)s"), "noplaylist": True,
        "writesubtitles": kind == "manual", "writeautomaticsub": kind == "automatic",
        "subtitleslangs": [chosen], "subtitlesformat": "vtt", "quiet": False,
    }
    if has_ffmpeg and not a.audio_only:
        opts["merge_output_format"] = "mp4"
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([a.url])
    vtts = sorted(out.glob(f"{base}*.vtt"), key=lambda p: p.stat().st_mtime)
    if not vtts:
        die("The subtitles didn't download. Try again, or check the video page.")
    cues = vtt_to_cues(vtts[-1].read_text(encoding="utf-8"))
    credit = " · ".join(x for x in [info.get("channel") or info.get("uploader"), "YouTube"] if x)
    bundle = write_bundle(out, title, lang or chosen.split("-")[0], cues, info.get("webpage_url") or a.url, credit)
    media = [p for p in out.glob(f"{base}.*") if p.suffix.lower() in (".mp4", ".m4a", ".webm", ".mkv", ".mp3", ".opus")]
    print(f"\n{len(cues)} subtitle lines.\nIn Khwānish choose “Audio or video”, then pick:\n  {media[0] if media else '(the downloaded file)'}\n  {bundle}")


# ----------------------------------------------------------------------------
# ganjoor
# ----------------------------------------------------------------------------

GANJOOR_API = "https://api.ganjoor.net"


def _get(d, *names, default=None):
    """Case-insensitive field lookup."""
    if not isinstance(d, dict):
        return default
    low = {k.lower(): v for k, v in d.items()}
    for n in names:
        if n.lower() in low and low[n.lower()] not in (None, ""):
            return low[n.lower()]
    return default


def fetch_poem(requests, target, debug_dir=None):
    s = requests.Session()
    s.headers["User-Agent"] = "khwanish-tools/1 (personal language study)"
    tries = []
    if re.fullmatch(r"\d+", target):
        tries.append(f"{GANJOOR_API}/api/ganjoor/poem/{target}?catInfo=false&rhymes=false&recitations=true&images=false&songs=false&comments=false&verseDetails=true&navigation=false")
    else:
        path = re.sub(r"^https?://(www\.)?ganjoor\.net", "", target.strip()).split("#")[0].split("?")[0]
        path = "/" + path.strip("/")
        tries.append(f"{GANJOOR_API}/api/ganjoor/page?url={requests.utils.quote(path)}")
        tries.append(f"{GANJOOR_API}/api/ganjoor/poem?url={requests.utils.quote(path)}&recitations=true&verseDetails=true")
    last = None
    for url in tries:
        try:
            r = s.get(url, timeout=30)
        except Exception as e:
            last = e
            continue
        if r.status_code != 200:
            last = f"HTTP {r.status_code} from {url}"
            continue
        j = r.json()
        if debug_dir:
            Path(debug_dir).mkdir(parents=True, exist_ok=True)
            (Path(debug_dir) / "ganjoor-response.json").write_text(json.dumps(j, ensure_ascii=False, indent=1), encoding="utf-8")
        poem = _get(j, "poem") if isinstance(_get(j, "poem"), dict) else j
        if _get(poem, "verses"):
            # the page endpoint may leave recitations out: ask the poem endpoint by id
            if not _get(poem, "recitations") and _get(poem, "id"):
                r2 = s.get(f"{GANJOOR_API}/api/ganjoor/poem/{_get(poem, 'id')}?catInfo=false&rhymes=false&recitations=true&images=false&songs=false&comments=false&verseDetails=true&navigation=false", timeout=30)
                if r2.status_code == 200 and _get(r2.json(), "verses"):
                    poem = r2.json()
            return s, poem
    die(f"Couldn't get that poem from Ganjoor ({last}). Check the address, e.g. https://ganjoor.net/hafez/ghazal/sh1")


def parse_sync(xml_text):
    """Ganjoor's recitation sync file → [(verse_order, ms)]."""
    import xml.etree.ElementTree as ET
    root = ET.fromstring(xml_text.encode("utf-8") if isinstance(xml_text, str) else xml_text)
    out = []
    for el in root.iter():
        if el.tag.split("}")[-1] != "SyncInfo":
            continue
        vo = ms = None
        for c in el:
            name = c.tag.split("}")[-1]
            if name == "VerseOrder":
                vo = int(c.text)
            elif name in ("AudioMiliseconds", "AudioMilliseconds"):
                ms = int(c.text)
        if vo is not None and ms is not None:
            out.append((vo, ms))
    return out


def cmd_ganjoor(a):
    requests = need("requests")
    s, poem = fetch_poem(requests, a.poem, a.out if a.debug else None)
    title = _get(poem, "fullTitle", "title", default="Ganjoor poem")
    verses = sorted(_get(poem, "verses", default=[]), key=lambda v: _get(v, "vOrder", "order", default=0))
    texts = [str(_get(v, "text", default="")).strip() for v in verses]
    positions = [_get(v, "versePosition", default=0) for v in verses]
    source = "https://ganjoor.net" + str(_get(poem, "fullUrl", "url", default=""))
    recs = [r for r in _get(poem, "recitations", default=[]) if _get(r, "mp3Url")]
    if a.list:
        if not recs:
            print("No recitations for this poem.")
        for i, r in enumerate(recs, 1):
            print(f"{i}. {_get(r, 'audioArtist', default='?')} · {_get(r, 'audioTitle', default='')}")
        return
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    base = safe_name(title)
    if not recs:
        lines = []
        for i, (t, pos) in enumerate(zip(texts, positions)):
            if i and pos in (0, 2):
                lines.append("")
            lines.append(t)
        p = out / f"{base}.txt"
        p.write_text("\n".join(lines) + "\n", encoding="utf-8")
        die(f"This poem has no recitation, so only the text was saved:\n  {p}\nImport it in Khwānish with “Import a file”.", 0)
    rec = recs[min(max(a.reciter, 1), len(recs)) - 1]
    artist = _get(rec, "audioArtist", default="")
    print(f"“{title}” recited by {artist or 'unknown'}")
    mp3 = out / f"{base}.mp3"
    with s.get(_get(rec, "mp3Url"), timeout=120, stream=True) as r:
        r.raise_for_status()
        with open(mp3, "wb") as f:
            for chunk in r.iter_content(1 << 16):
                f.write(chunk)
    sync = []
    xml_url = _get(rec, "xmlText", "xmlUrl")
    if xml_url:
        r = s.get(xml_url, timeout=60)
        if r.status_code == 200:
            r.encoding = r.encoding or "utf-8"
            sync = parse_sync(r.text)
    sync = sorted((vo, ms) for vo, ms in sync if vo >= 0)
    if not sync:
        die(f"Saved the recording ({mp3}) but Ganjoor has no verse timings for it, so it can't be synced.")
    # Ganjoor counts verses from 0 or 1 depending on the file: detect which
    orders = [vo for vo, _ in sync]
    one_based = 0 not in orders and max(orders) == len(texts)
    starts = {}
    for vo, ms in sync:
        idx = vo - 1 if one_based else vo
        if 0 <= idx < len(texts):
            starts.setdefault(idx, ms)
    timed = sorted(starts.items())
    cues = []
    for n, (idx, ms) in enumerate(timed):
        end = timed[n + 1][1] if n + 1 < len(timed) else ms + 8000
        # verses between two timed ones share the earlier timing
        nxt = timed[n + 1][0] if n + 1 < len(timed) else len(texts)
        group = list(range(idx, nxt))
        span = max(1, (end - ms) // max(1, len(group)))
        for k, vi in enumerate(group):
            cues.append({"s": ms + k * span, "e": ms + (k + 1) * span, "t": texts[vi],
                         "gap": bool(cues) and positions[vi] in (0, 2)})
    credit = " · ".join(x for x in [f"Recited by {artist}" if artist else "", "Ganjoor"] if x)
    bundle = write_bundle(out, title, "fa", cues, source, credit)
    print(f"\n{len(cues)} timed verses.\nIn Khwānish choose “Audio or video”, then pick:\n  {mp3}\n  {bundle}")


# ----------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    o = sub.add_parser("ocr", help="scanned PDF or photos → .txt with kraken")
    o.add_argument("inputs", nargs="+", help="PDF files or page images")
    o.add_argument("-m", "--model", help="kraken recognition model (.mlmodel or .safetensors)")
    o.add_argument("-p", "--pages", help="pages to read, e.g. 1-20,25 (PDFs only)")
    o.add_argument("-o", "--out", help="output .txt (default: next to the first input)")
    o.add_argument("--dpi", type=int, default=300)
    o.add_argument("--direction", default="horizontal-rl", choices=["horizontal-rl", "horizontal-lr"],
                   help="reading direction (horizontal-rl for Perso-Arabic)")
    o.add_argument("--workdir", help="where to keep page images and page XML")
    o.set_defaults(fn=cmd_ocr)

    pr = sub.add_parser("prepare", help="cut pages into lines and make a correction page")
    pr.add_argument("inputs", nargs="+", help="PDF files or page images")
    pr.add_argument("-o", "--out", default="training", help="folder for the training material")
    pr.add_argument("-p", "--pages", help="pages to use, e.g. 1-10")
    pr.add_argument("-m", "--model", help="existing model, to pre-fill the text so you only fix mistakes")
    pr.add_argument("--lang", default="fa", help="language code for the correction page")
    pr.add_argument("--dpi", type=int, default=300)
    pr.add_argument("--direction", default="horizontal-rl", choices=["horizontal-rl", "horizontal-lr"])
    pr.set_defaults(fn=cmd_prepare)

    t = sub.add_parser("train", help="fine-tune a model on your corrected lines")
    t.add_argument("folder", help="the folder made by 'prepare'")
    t.add_argument("-b", "--base", help="model to fine-tune (recommended); leave out to train from scratch")
    t.add_argument("-n", "--name", default="my-model", help="folder for the new model")
    t.add_argument("--corrections", help="path to corrections.json (default: FOLDER/corrections.json)")
    t.add_argument("-N", "--epochs", type=int, help="train for exactly this many epochs (default: stop when it stops improving)")
    t.add_argument("-d", "--device", help="e.g. cpu, cuda:0 or mps")
    t.set_defaults(fn=cmd_train)

    m = sub.add_parser("models", help="list kraken models for Arabic-script text")
    m.add_argument("search", nargs="*", help="words to look for (default: Arabic, Persian, Urdu…)")
    m.set_defaults(fn=cmd_models)

    y = sub.add_parser("youtube", help="video + subtitles in its own language")
    y.add_argument("url")
    y.add_argument("--lang", help="language code of the video, e.g. fa, tg, ckb (default: YouTube's guess)")
    y.add_argument("--audio-only", action="store_true", help="download only the sound (smaller)")
    y.add_argument("--height", type=int, default=720, help="maximum video height")
    y.add_argument("-o", "--out", default=".", help="folder to save into")
    y.set_defaults(fn=cmd_youtube)

    g = sub.add_parser("ganjoor", help="poem + recitation + verse timings")
    g.add_argument("poem", help="Ganjoor address (https://ganjoor.net/hafez/ghazal/sh1) or poem id")
    g.add_argument("-r", "--reciter", type=int, default=1, help="which recitation to use (see --list)")
    g.add_argument("--list", action="store_true", help="list the poem's recitations and stop")
    g.add_argument("-o", "--out", default=".", help="folder to save into")
    g.add_argument("--debug", action="store_true", help="also save Ganjoor's raw answer (to report problems)")
    g.set_defaults(fn=cmd_ganjoor)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()

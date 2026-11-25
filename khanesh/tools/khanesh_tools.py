#!/usr/bin/env python3
"""Khānesh tools: get texts and recordings ready for the Khānesh reader.

  ocr      Turn a scanned PDF or photos of pages into a .txt file with kraken.
  prepare  Cut pages into lines and make a correction page (to train a model).
  train    Fine-tune a kraken model on the lines you corrected.
  check    Optional: measure how well a model reads pages you set aside.
  stats    Optional: count your corrected lines, where they came from, and what you fixed.
  models   List kraken models for Arabic-script languages.
  ganjoor  Download a Ganjoor poem with a recitation and its verse timings.

Install what you need (tested with kraken 7.1 on Python 3.13):
  pip install kraken pymupdf     # ocr, prepare, train, models
  pip install requests           # ganjoor

Run any command with --help for its options, e.g.  python khanesh_tools.py ocr --help
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

# Persian text in our own messages, on a Windows console that isn't set to UTF-8
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# ----------------------------------------------------------------------------
# shared helpers
# ----------------------------------------------------------------------------

# Everything the script makes goes in folders next to it, so a project folder holding the script and a
# book keeps it all together:  models/ (downloaded and trained models), outputs/ (text from your books),
# training/ (lines to correct, and training files).
HERE = Path(__file__).resolve().parent


def find(path):
    """A file or folder you named: where you ran the command, or else next to the script."""
    p = Path(path)
    if p.exists() or p.is_absolute():
        return p
    q = HERE / p
    return q if q.exists() else p


def shown(path):
    """A location to print in a command to copy: short inside the project folder, whole elsewhere."""
    path = Path(path).resolve()
    try:
        t = path.relative_to(HERE).as_posix()   # names inside the project folder work from anywhere (see find)
    except ValueError:
        t = str(path)
    return f'"{t}"' if (" " in t or not t.isascii() or "\\" in t) else t


def die(msg, code=1):
    print(f"\n{msg}", file=sys.stderr)
    sys.exit(code)


def open_command(path):
    """The command that opens a file in its usual app, for this computer."""
    if os.name == "nt":
        return f'start "" "{path}"'      # start takes a first quoted argument as the window's title
    return f'{"open" if sys.platform == "darwin" else "xdg-open"} "{path}"'


def model_file(path, what="model"):
    """The model file, checked before any work starts. Returns where it is."""
    path = find(path)
    if not Path(path).is_file():
        hint = ("\n  The '…' in the guide's examples stands for the folder: give the model's whole path."
                if "…" in str(path) or "..." in str(path) else
                "\n  'python khanesh_tools.py get <ID>' prints a downloaded model's whole path.")
        die(f"Can't find the {what} {path}{hint}")
    return str(path)


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
        p = find(inp)
        if not p.exists():
            die(f"Can't find {p}")
        if p.suffix.lower() == ".pdf":
            try:
                import pymupdf as fitz   # its current name; older releases only have "fitz"
            except ImportError:
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


# kraken and ketos are Python programs too. On Windows, Python reads text in the system's old code page
# unless told otherwise, and kraken then fails on the first character outside it (a UnicodeDecodeError).
# UTF-8 mode makes every file and pipe UTF-8, as on Linux and macOS.
def utf8_env():
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def run(cmd, quiet=False):
    if not quiet:
        print("  $ " + " ".join(str(c) for c in cmd))
    r = subprocess.run([str(c) for c in cmd], capture_output=quiet, text=True, encoding="utf-8", errors="replace", env=utf8_env())
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
            "Run 'python khanesh_tools.py models' to find one, or train your own with 'prepare' and 'train'.")
    a.model = model_file(a.model)
    stem = Path(a.inputs[0]).stem
    work = Path(a.workdir) if a.workdir else HERE / "outputs" / f"{stem}_pages"
    pages = page_images(a.inputs, a.pages, a.dpi, work)
    out_txt = Path(a.out) if a.out else HERE / "outputs" / f"{stem}.txt"
    out_txt.parent.mkdir(parents=True, exist_ok=True)
    texts = []
    for i, (label, img) in enumerate(pages, 1):
        print(f"[{i}/{len(pages)}] {label}")
        xml = work / (Path(img).stem + ".xml")
        segment_to_alto(img, xml, a.model, a.direction)
        lines = [t for _, t, _ in alto_lines(xml) if t.strip()]
        texts.append("\n".join(lines))
    out_txt.write_text("\n\n".join(t for t in texts if t).strip() + "\n", encoding="utf-8")
    print(f"\nSaved {out_txt.resolve()}\nImport it in Khānesh with “Import a file”.")


# ----------------------------------------------------------------------------
# prepare: line images + a correction page
# ----------------------------------------------------------------------------

CORRECT_HTML = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Correct lines · Khānesh</title>
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
    if a.model:
        a.model = model_file(a.model)
    need("PIL", "pillow")
    from PIL import Image
    out = Path(a.out) if a.out else HERE / "training"
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
    full = out.resolve()
    print(f"\n{len(data['lines'])} lines ready in {full}"
          f"\n1. Open {full / 'correct.html'} in your browser and fix the text under each line."
          f"\n   To open it from here, type:  {open_command(full / 'correct.html')}"
          f"\n   (Your edits are remembered in that browser. Tick “Leave this line out” for bad cuts.)"
          f"\n2. Click “Save corrections”, then move corrections.json from your Downloads folder into {full}"
          f"\n3. Run:  python khanesh_tools.py train {shown(full)}" + (f" --base {shown(a.model)}" if a.model else " --base YOUR_MODEL") + " --name my-model")


# ----------------------------------------------------------------------------
# train: write corrections into the page XML, then ketos
# ----------------------------------------------------------------------------

def cmd_train(a):
    gt = find(a.folder)
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
    # optional: pages set aside to check the model on afterwards ('check'), never trained on
    xmls, held = holdout_split(gt, sorted(xmls), a.holdout)
    if held:
        kept -= sum(len([1 for _, t, _ in alto_lines(x) if t.strip()]) for x in held)
    print(f"{kept} corrected lines on {len(xmls)} pages ({skipped} left out).")
    if kept < 50:
        print("Tip: fine-tuning works best with a few hundred corrected lines; more pages give better results.")
    outdir = Path(a.name) if Path(a.name).is_absolute() else HERE / "models" / a.name
    cmd = [kraken_bin("ketos")]
    if a.device:
        cmd += ["-d", a.device]
    cmd += ["train", "-f", "alto", "-o", str(outdir)]
    if a.epochs:
        cmd += ["-q", "fixed", "-N", str(a.epochs)]
    if a.base:
        a.base = model_file(a.base, "base model")
        cmd += ["-i", a.base, "--resize", "union"]
    cmd += [str(x) for x in xmls]
    print("Training. This can take a while on a laptop; a GPU makes it much faster.")
    run(cmd)
    weights = [p for p in outdir.rglob("*") if p.suffix in (".safetensors", ".mlmodel")]
    best = sorted([p for p in weights if "best" in p.name.lower()] or weights, key=lambda p: p.stat().st_mtime)
    if not best:
        die(f"Training finished but no model file was found in {outdir}/.")
    print(f"\nDone. Your model: {best[-1].resolve()}\nUse it with:\n  python khanesh_tools.py ocr BOOK.pdf --model {shown(best[-1])}")
    log_training(gt, {"model": str(best[-1].resolve()), "base": str(Path(a.base).resolve()) if a.base else None,
                      "lines": kept, "pages": len(xmls), "set_aside": len(held)})
    if held:
        print(f"\nTo see how well it reads the {len(held)} pages you set aside:\n  python khanesh_tools.py check {shown(gt)} --model {shown(best[-1])}"
              + (f" --base {shown(a.base)}" if a.base else ""))
    if any(p.suffix == ".ckpt" for p in outdir.glob("*")):
        print(f"(The .ckpt files in {outdir}/ are only for resuming training; delete them to free up space.)")


def holdout_split(gt, xmls, n):
    """Set n pages aside for 'check' (spread through the book, so they're typical of it).

    The choice is saved in holdout.txt, and later training keeps the same pages aside unless asked
    otherwise (--holdout 0 gives them back), so a checked page never slips into training."""
    saved = gt / "holdout.txt"
    if n is None and saved.exists():
        names = {l.strip() for l in saved.read_text(encoding="utf-8").splitlines() if l.strip()}
        held = [x for x in xmls if x.name in names]
        if held:
            print(f"Keeping the {len(held)} pages you set aside out of training (listed in {saved.name}; --holdout 0 to use them).")
        return [x for x in xmls if x not in held], held
    if not n:
        if saved.exists():
            saved.unlink()
        return xmls, []
    if len(xmls) < n + 2:
        die(f"Setting {n} pages aside would leave {len(xmls) - n} to train on. Correct more pages, or set fewer aside.")
    idx = sorted({min(len(xmls) - 1, int((i + 0.5) * len(xmls) / n)) for i in range(n)})
    held = [xmls[i] for i in idx]
    saved.write_text("\n".join(x.name for x in held) + "\n", encoding="utf-8")
    print(f"Setting {len(held)} pages aside to check the model on afterwards: " + ", ".join(x.stem for x in held))
    return [x for x in xmls if x not in held], held


def log_training(gt, run):
    """Add a training run to FOLDER/history.json, for 'stats'."""
    import datetime
    path = Path(gt) / "history.json"
    try:
        runs = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        runs = []
    runs.append({"date": datetime.date.today().isoformat(), **run})
    path.write_text(json.dumps(runs, ensure_ascii=False, indent=1), encoding="utf-8")


def char_edits(model_text, your_text):
    """How many characters you changed in a line, and which: (count, [(model wrote, you wrote), ...])."""
    import difflib
    n, pairs = 0, []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, model_text, your_text, autojunk=False).get_opcodes():
        if op == "equal":
            continue
        a, b = model_text[i1:i2], your_text[j1:j2]
        n += max(len(a), len(b))
        if op == "replace" and len(a) == len(b):
            pairs += list(zip(a, b))
        else:
            pairs.append((a, b))
    return n, pairs


def show_chars(t):
    """A few characters, readable in a console: spaces and invisible marks named."""
    if t == "":
        return "nothing"
    names = {" ": "space", "\u200c": "ZWNJ (half-space)", "\u200d": "ZWJ", "\u0640": "kashida"}
    if len(t) == 1 and (t in names or unicodedata.category(t).startswith("M")):
        return names.get(t) or f"{t} ({unicodedata.name(t, 'mark').lower()})"
    return "".join(names.get(c, c) if len(t) == 1 else c for c in t)


def plural(n, word, many=None):
    return f"{n} {word if n == 1 else (many or word + 's')}"


def letter_names(was, now):
    """Names for a one-letter fix, since some pairs look the same (Arabic ي and Persian ی)."""
    if len(was) == 1 and len(now) == 1:
        short = lambda c: unicodedata.name(c, "?").lower().replace("arabic letter ", "").replace("arabic ", "")
        return f"   ({short(was)} → {short(now)})"
    return ""


def cmd_stats(a):
    from collections import Counter
    folders = [find(f) for f in (a.folders or ["training"])]
    total = Counter()
    for gt in folders:
        page_file = gt / "correct.html"
        if not page_file.exists():
            print(f"\n{gt}: no correct.html here. Make one with 'prepare'.")
            continue
        m = re.search(r"const DATA = (\{.*?\});\n", page_file.read_text(encoding="utf-8"), re.S)
        data = json.loads(m.group(1)) if m else {"lines": []}
        corr_path = gt / "corrections.json"
        try:
            corr = json.loads(corr_path.read_text(encoding="utf-8")).get("lines", {})
        except (OSError, ValueError):
            corr = None
        held = set()
        if (gt / "holdout.txt").exists():
            held = {l.strip()[:-4] for l in (gt / "holdout.txt").read_text(encoding="utf-8").splitlines() if l.strip()}
        print(f"\nTraining folder: {gt.resolve()}")
        # one row per page, grouped by the book it came from
        pages, books = {}, {}
        fixes, chars_read, chars_changed = Counter(), 0, 0
        for line in data["lines"]:
            stem = line["id"].split("::")[0]
            label = line.get("page") or stem
            mm = re.match(r"^(.*) page (\d+)$", label)
            book, page = (mm.group(1), int(mm.group(2))) if mm else (label, None)
            row = pages.setdefault(stem, Counter(book=0))
            row["lines"] += 1
            books.setdefault(book, set()).add(page)
            pages[stem].setdefault("_book", book); pages[stem].setdefault("_page", page)
            if corr is None:
                continue
            got = corr.get(line["id"], line["text"])
            if got is None or not str(got).strip():
                row["left out"] += 1
                continue
            n, pairs = char_edits(line["text"].strip(), str(got).strip())
            chars_read += len(str(got).strip())
            chars_changed += n
            row["changed" if n else "kept"] += 1
            row["chars"] += n
            if stem in held:
                row["set aside"] += 1
            fixes.update(pairs)
        for book, nums in books.items():
            nums = sorted(n for n in nums if n is not None)
            span = (f", pages {nums[0]}–{nums[-1]}" if len(nums) > 1 else f", page {nums[0]}") if nums else ""
            print(f"Lines from: {book}{span}")
        if corr is None:
            print(f"{len(data['lines'])} lines on {len(pages)} pages, not corrected yet.\n"
                  f"Correct them in {page_file.resolve()}, then tap Save corrections and put corrections.json in this folder.")
            continue
        print(f"\n{'page':>8}  {'lines':>5}  {'changed':>7}  {'kept':>4}  {'left out':>8}  {'letters fixed':>13}")
        for stem, r in sorted(pages.items(), key=lambda kv: (kv[1]["_book"], kv[1]["_page"] or 0, kv[0])):
            name = f"p.{r['_page']}" if r["_page"] is not None else stem[:8]
            print(f"{name:>8}  {r['lines']:5d}  {r['changed']:7d}  {r['kept']:4d}  {r['left out']:8d}  {r['chars']:13d}" + ("  set aside" if stem in held else ""))
        t = Counter()
        for r in pages.values():
            for k in ("lines", "changed", "kept", "left out", "set aside"):
                t[k] += r[k]
        used = t["changed"] + t["kept"]
        print(f"{'total':>8}  {t['lines']:5d}  {t['changed']:7d}  {t['kept']:4d}  {t['left out']:8d}  {chars_changed:13d}")
        print(f"\n{used} lines ready for training: you changed {t['changed']} and kept {t['kept']} as the model read them; {t['left out']} left out.")
        if t["set aside"]:
            print(f"{t['set aside']} of them are on the {plural(len(held), 'page')} set aside for 'check', so {used - t['set aside']} are trained on.")
        if chars_read:
            print(f"You changed {chars_changed} of {chars_read} characters, so the model you started from read about "
                  f"{max(0.0, 100 * (1 - chars_changed / chars_read)):.0f}% of them right.")
        common = [(k, v) for k, v in fixes.most_common() if k[0] != k[1]][:a.top]
        if common:
            print("\nWhat you fixed most (the model wrote → you wrote):")
            for (was, now), n in common:
                print(f"  {show_chars(was)} → {show_chars(now)}   {n}×{letter_names(was, now)}")
        runs = []
        try:
            runs = json.loads((gt / "history.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        if runs:
            print("\nTraining runs:")
            for r in runs:
                aside = f", {plural(r['set_aside'], 'page')} set aside" if r.get("set_aside") else ""
                base = f" from {Path(r['base']).name}" if r.get("base") else ""
                print(f"  {r['date']}: {plural(r['lines'], 'line')} on {plural(r['pages'], 'page')}{aside}{base} → {r['model']}")
        total.update({"lines": t["lines"], "used": used, "changed": t["changed"], "folders": 1})
    if len(folders) > 1 and total["folders"]:
        print(f"\nAll {total['folders']} folders: {total['used']} lines ready for training, {total['changed']} of them changed by you.")
    if total["used"] and total["used"] < 200:
        print("\nTip: a few hundred corrected lines give good results; correct a few more pages with 'prepare'.")


def accuracy_report(text):
    """Character and word accuracy (%) from ketos test's report, whichever way this kraken prints it."""
    flat = text.replace("│", " ")
    def grab(*pats):
        for pat in pats:
            m = re.search(pat, flat, re.I)
            if m:
                return float(m.group(1))
        return None
    sp = r"[ \t]*"   # within one line: a number belongs to the label beside it, not the one below
    char = grab(rf"([\d.]+){sp}%{sp}(?:Character[ \t]+)?Accuracy", r"Character[ \t]+Accuracy[^\d\n]{0,12}([\d.]+)[ \t]*%",
                r"(?<!Word )Accuracy[^\d\n]{0,12}([\d.]+)[ \t]*%")
    word = grab(rf"([\d.]+){sp}%{sp}Word[ \t]+Accuracy", r"Word[ \t]+Accuracy[^\d\n]{0,12}([\d.]+)[ \t]*%")
    return char, word


def cmd_check(a):
    gt = find(a.folder)
    saved = gt / "holdout.txt"
    if not saved.exists():
        die("No pages were set aside in this folder. To check a model, train it with some pages set aside, e.g.:\n"
            f"  python khanesh_tools.py train \"{gt}\" --base MODEL_FILE --name my-model --holdout 2")
    xmls = [gt / "pages" / l.strip() for l in saved.read_text(encoding="utf-8").splitlines() if l.strip()]
    xmls = [x for x in xmls if x.exists()]
    if not xmls:
        die(f"The pages listed in {saved} aren't in {gt / 'pages'} any more.")
    lines = sum(len([1 for _, t, _ in alto_lines(x) if t.strip()]) for x in xmls)
    models = ([("Before training", model_file(a.base, "base model"))] if a.base else []) + [("Your model", model_file(a.model))]
    rows = []
    for label, m in models:
        model_file(m)
        print(f"Reading the set-aside pages with {Path(m).name}…")
        cmd = [kraken_bin("ketos")] + (["-d", a.device] if a.device else []) + ["test", "-m", str(m), "-f", "alto"] + [str(x) for x in xmls]
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", env=utf8_env())
        out = (r.stdout or "") + (r.stderr or "")
        char, word = accuracy_report(out)
        if r.returncode != 0 or char is None:
            tail = [l.strip(" │╰╮╭╯─") for l in out.splitlines() if l.strip(" │╰╮╭╯─")][-15:]
            die("kraken couldn't check that model. This is what it said:\n  " + "\n  ".join(tail))
        rows.append((label, Path(m).name, char, word))
    print(f"\nChecked on {len(xmls)} pages you set aside ({lines} lines), which training never saw.\n")
    w = max(len(f"{l} ({n})") for l, n, _, _ in rows)
    print(f"{'':{w}}  characters right  words right")
    for label, name, char, word in rows:
        print(f"{label + ' (' + name + ')':{w}}  {char:15.1f}%  " + (f"{word:10.1f}%" if word is not None else "         –"))
    if len(rows) == 2:
        d = rows[1][2] - rows[0][2]
        if d > 0.05:
            print(f"\nYour model gets {d:.1f} more characters in every 100 right than before training.")
        else:
            print("\nYour model doesn't read these pages better than before training yet. Correct more pages and train again.")
    print("Most readers find text comfortable to fix by hand from about 95% of characters right.")


# ----------------------------------------------------------------------------
# models
# ----------------------------------------------------------------------------

def model_rows(text):
    """kraken list's table, one (id, name, kind) per model. The table is drawn wide, but a long name can
    still wrap onto lines of its own, which carry no id and are joined to the row above."""
    rows = []
    for line in text.splitlines():
        cells = [c.strip(" ├└─╭╮╰╯┃") for c in line.split("│")]
        cells = [c for c in cells if c]
        if not cells:
            continue
        m = re.match(r"^(10\.\d{4,9}/\S+)$", cells[0])
        if m:
            rows.append([m.group(1), cells[1] if len(cells) > 1 else "", cells[2] if len(cells) > 2 else ""])
        elif rows and cells and not re.match(r"^(DOI|ID|Name|summary)\b", cells[0], re.I):
            rows[-1][1] = (rows[-1][1] + " " + cells[0]).strip()
    return [tuple(r) for r in rows]


def cmd_models(a):
    env = utf8_env()
    env["COLUMNS"] = "400"     # kraken draws its table to fit; wide enough that rows don't wrap
    r = subprocess.run([kraken_bin(), "list"], capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
    if r.returncode != 0:
        err = [l.strip(" │╰╮╭╯─") for l in (r.stderr or r.stdout or "").splitlines()]
        err = [l for l in err if l]
        start = max((i for i, l in enumerate(err) if re.match(r"^[A-Za-z_.]*(Error|Exception)\b", l)), default=max(0, len(err) - 3))
        reason = re.sub(r"\s+", " ", " ".join(err[start:]))[:400]
        if re.search(r"Connection|Timeout|timed out|resolve|Max retries|SSLError|HTTPError|NameResolution|getaddrinfo|Network", reason, re.I):
            die("Couldn't reach kraken's model repository (it lives on zenodo.org). "
                "Check your internet connection and try again.\n  " + reason)
        die("kraken couldn't list its models. This is what it said:\n  " + reason)
    words = [w.lower() for w in (a.search or ["arab", "persian", "farsi", "fas", "urdu", "urd", "ara", "nastaliq", "naskh", "openiti", "kitab"])]
    rows = model_rows(r.stdout)
    if rows:
        hits = [x for x in rows if any(w in (x[1] + " " + x[2]).lower() for w in words)]
        if not hits:
            print("No matching models. Run 'kraken list' to see everything.")
            return
        width = max(len(x[0]) for x in hits)
        for mid, name, kind in hits:
            print(f"{mid.ljust(width)}  {name}" + (f"  ({kind})" if kind else ""))
        print("\nFor reading text, choose one marked 'recognition'.")
    else:   # a kraken whose list we can't read as a table: show its matching lines as they are
        hits = [l for l in r.stdout.splitlines() if any(w in l.lower() for w in words)]
        print("\n".join(hits) if hits else "No matching models. Run 'kraken list' to see everything.")
    print("\nDownload one with:  python khanesh_tools.py get <its ID, from the first column>\n"
          "Then use it with:   python khanesh_tools.py ocr BOOK.pdf --model \"<the file it downloads>\"")


def cmd_get(a):
    """kraken get, in UTF-8 mode, then say where the model file went."""
    print(f"Downloading {a.id}…")
    env = utf8_env()
    env["COLUMNS"] = "400"     # so kraken doesn't wrap the long "Model dir: …" line
    r = subprocess.run([kraken_bin(), "get", a.id], capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode != 0:
        lines = [l.strip(" │╰╮╭╯─") for l in out.splitlines() if l.strip(" │╰╮╭╯─")]
        die("kraken couldn't download that model. This is what it said:\n  " + " ".join(lines[-3:])[:400])
    files = re.findall(r"([A-Za-z]:\\[^\s'\"│]+\.(?:mlmodel|safetensors)|/[^\s'\"│]+\.(?:mlmodel|safetensors))", out)
    # newer kraken: "Model dir: <folder> (model files: a.mlmodel, b.safetensors)"
    m = re.search(r"Model dir:\s*(.+?)\s*\(model files?:\s*([^)]+)\)", out)
    if m:
        names = [n.strip(" '\"") for n in m.group(2).split(",") if n.strip()]
        files += [os.path.join(m.group(1), n) for n in names if re.search(r"\.(mlmodel|safetensors)$", n)]
    if files:
        src = Path(files[-1])
        dest = HERE / "models" / src.name
        if src.exists():   # a copy beside the script, so the model has a short name
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists() and dest.stat().st_size != src.stat().st_size:
                dest = dest.with_name(f"{src.stem}-{re.sub(r'[^0-9A-Za-z]+', '-', a.id).strip('-')}{src.suffix}")
            shutil.copyfile(src, dest)
            src = dest
        print(f"Saved: {src.resolve() if src.exists() else src}\n\nUse it with:\n  python khanesh_tools.py ocr BOOK.pdf --model {shown(src) if src.exists() else chr(34) + str(src) + chr(34)}")
    else:
        print(out.strip() + "\n\nUse the model file named above with --model.")


# ----------------------------------------------------------------------------
# timed text helpers
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
    path = folder / f"{safe_name(title)}.khanesh.json"
    path.write_text(json.dumps({"app": "khwanish-media", "v": 1, "title": title, "lang": lang,
                                "source": source, "credit": credit, "cues": cues}, ensure_ascii=False, indent=1),
                    encoding="utf-8")
    return path


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
    s.headers["User-Agent"] = "khanesh-tools/1 (personal language study)"
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
        die(f"This poem has no recitation, so only the text was saved:\n  {p}\nImport it in Khānesh with “Import a file”.", 0)
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
    print(f"\n{len(cues)} timed verses.\nIn Khānesh choose “Audio or video”, then pick:\n  {mp3}\n  {bundle}")


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
    pr.add_argument("-o", "--out", help="folder for the training material (default: training, next to this script)")
    pr.add_argument("-p", "--pages", help="pages to use, e.g. 1-10")
    pr.add_argument("-m", "--model", help="existing model, to pre-fill the text so you only fix mistakes")
    pr.add_argument("--lang", default="fa", help="language code for the correction page")
    pr.add_argument("--dpi", type=int, default=300)
    pr.add_argument("--direction", default="horizontal-rl", choices=["horizontal-rl", "horizontal-lr"])
    pr.set_defaults(fn=cmd_prepare)

    t = sub.add_parser("train", help="fine-tune a model on your corrected lines")
    t.add_argument("folder", help="the folder made by 'prepare'")
    t.add_argument("-b", "--base", help="model to fine-tune (recommended); leave out to train from scratch")
    t.add_argument("-n", "--name", default="my-model", help="name for the new model's folder, in models/ next to this script")
    t.add_argument("--corrections", help="path to corrections.json (default: FOLDER/corrections.json)")
    t.add_argument("-N", "--epochs", type=int, help="train for exactly this many epochs (default: stop when it stops improving)")
    t.add_argument("-d", "--device", help="e.g. cpu, cuda:0 or mps")
    t.add_argument("--holdout", type=int, metavar="PAGES",
                   help="optional: set this many corrected pages aside, not trained on, to measure the model with 'check' (0 uses them again)")
    t.set_defaults(fn=cmd_train)

    st = sub.add_parser("stats", help="optional: count your corrected lines, where they came from, and what you fixed")
    st.add_argument("folders", nargs="*", help="folders made by 'prepare' (default: training)")
    st.add_argument("--top", type=int, default=10, help="how many of the most common fixes to list (default 10)")
    st.set_defaults(fn=cmd_stats)

    c = sub.add_parser("check", help="optional: measure how well a model reads the pages you set aside with train --holdout")
    c.add_argument("folder", help="the folder made by 'prepare'")
    c.add_argument("-m", "--model", required=True, help="the model to measure, usually the one 'train' made")
    c.add_argument("-b", "--base", help="also measure this model, to compare (usually the one you started from)")
    c.add_argument("-d", "--device", help="e.g. cpu, cuda:0 or mps")
    c.set_defaults(fn=cmd_check)

    m = sub.add_parser("models", help="list kraken models for Arabic-script text")
    m.add_argument("search", nargs="*", help="words to look for (default: Arabic, Persian, Urdu…)")
    m.set_defaults(fn=cmd_models)

    gm = sub.add_parser("get", help="download a kraken model by its ID (from 'models')")
    gm.add_argument("id", help="the model's ID, like 10.5281/zenodo.14585602")
    gm.set_defaults(fn=cmd_get)

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

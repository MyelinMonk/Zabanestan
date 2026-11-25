"""Builds two small Anki packages for anki_import_test.py: an old-style one (collection.anki2,
JSON media list) and a new-style one (zstd collection.anki21b, protobuf media list, stub .anki2)."""
import io, json, sqlite3, struct, time, wave, zipfile, tempfile, os
import zstandard
OUT = os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)
CRT = int(time.time()) // 86400 * 86400 - 100 * 86400   # collection made 100 days ago
TODAY = 100

def wav():
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000); w.writeframes(b"\0\0" * 800)
    return b.getvalue()

CARDS = "CREATE TABLE cards (id integer primary key, nid int, did int, ord int, mod int, usn int, type int, queue int, due int, ivl int, factor int, reps int, lapses int, left int, odue int, odid int, flags int, data text)"
NOTES = "CREATE TABLE notes (id integer primary key, guid text, mid int, mod int, usn int, tags text, flds text, sfld text, csum int, flags int, data text)"
REVLOG = "CREATE TABLE revlog (id integer primary key, cid int, usn int, ease int, ivl int, lastIvl int, factor int, time int, type int)"
COL = "CREATE TABLE col (id integer primary key, crt int, mod int, scm int, ver int, dty int, usn int, ls int, conf text, models text, decks text, dconf text, tags text)"

def fill(db, notes):
    nid = 1000; cid = 5000
    for mid, did, flds, cards in notes:
        nid += 1
        db.execute("INSERT INTO notes VALUES (?,?,?,0,0,'',?,'',0,0,'')", (nid, "g%d" % nid, mid, "\x1f".join(flds)))
        for ord_, typ, queue, due, ivl, data, revs in cards:
            cid += 1
            db.execute("INSERT INTO cards VALUES (?,?,?,?,0,0,?,?,?,?,2500,?,0,0,0,0,0,?)", (cid, nid, did, ord_, typ, queue, due, ivl, len(revs), data))
            for i, (ease, iv, last, ty) in enumerate(revs):
                db.execute("INSERT INTO revlog VALUES (?,?,0,?,?,?,2500,5000,?)", ((CRT + (TODAY - 20 + i) * 86400) * 1000 + cid, cid, ease, iv, last, ty))

def legacy():
    path = tempfile.mktemp()
    db = sqlite3.connect(path)
    for t in (COL, NOTES, CARDS, REVLOG): db.execute(t)
    models = {
        "1": {"id": 1, "name": "Basic", "type": 0, "flds": [{"name": "Front", "ord": 0}, {"name": "Back", "ord": 1}]},
        "2": {"id": 2, "name": "Basic (and reversed card)", "type": 0, "flds": [{"name": "Front", "ord": 0}, {"name": "Back", "ord": 1}, {"name": "Notes", "ord": 2}]},
        "3": {"id": 3, "name": "Cloze", "type": 1, "flds": [{"name": "Text", "ord": 0}, {"name": "Back Extra", "ord": 1}]},
    }
    decks = {"1": {"id": 1, "name": "Default"}, "10": {"id": 10, "name": "Persian::Food"}}
    db.execute("INSERT INTO col VALUES (1,?,0,0,11,0,0,0,'{}',?,?,'{}','{}')", (CRT, json.dumps(models), json.dumps(decks)))
    fill(db, [
        (1, 10, ["<b>نان</b>[sound:nan.wav]", "bread<br>loaf"], [(0, 2, 2, TODAY + 5, 12, "", [(3, -600, 0, 0), (3, 4, -600, 1), (3, 12, 4, 1)])]),
        (2, 10, ["آب", "water", "a basic word"], [(0, 2, 2, TODAY - 1, 30, json.dumps({"s": 33.5, "d": 4.2}), []), (1, 0, 0, 7, 0, "", [])]),
        (1, 1, ["سیب", "apple"], [(0, 0, 0, 3, 0, "", [])]),
        (1, 1, ["<img src='x.png'>", "a picture"], [(0, 0, 0, 4, 0, "", [])]),
        (3, 1, ["{{c1::کتاب}} خوب است", ""], [(0, 0, 0, 5, 0, "", [])]),
        (1, 1, ["میز", "desk"], [(0, 0, 0, 6, 0, "", [])]),
    ])
    db.commit(); db.close()
    with zipfile.ZipFile(os.path.join(OUT, "old.apkg"), "w", zipfile.ZIP_DEFLATED) as z:
        z.write(path, "collection.anki2")
        z.writestr("media", json.dumps({"0": "nan.wav"}))
        z.writestr("0", wav())

def varint(n):
    out = b""
    while True:
        b = n & 0x7f; n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n: return out

def modern():
    path = tempfile.mktemp()
    db = sqlite3.connect(path)
    for t in (COL, NOTES, CARDS, REVLOG): db.execute(t)
    db.execute("CREATE TABLE notetypes (id integer primary key, name text, mtime_secs int, usn int, config blob)")
    db.execute("CREATE TABLE fields (ntid int, ord int, name text, config blob)")
    db.execute("CREATE TABLE decks (id integer primary key, name text, mtime_secs int, usn int, common blob, kind blob)")
    db.execute("INSERT INTO col VALUES (1,?,0,0,18,0,0,0,'','','','','')", (CRT,))
    db.execute("INSERT INTO notetypes VALUES (7,'Vocab',0,0,x'')")
    for i, n in enumerate(["Word", "Picture", "Meaning", "Sentence"]): db.execute("INSERT INTO fields VALUES (7,?,?,x'')", (i, n))
    db.execute("INSERT INTO decks VALUES (1,'Default',0,0,x'',x'')")
    db.execute("INSERT INTO decks VALUES (20,'Mazandarani\x1fUnit 1',0,0,x'',x'')")
    fill(db, [
        (7, 20, ["دار[sound:dar.wav]", "", "tree", "این دار بلنده"], [(0, 1, 1, int(time.time()) + 300, 0, "", [(1, -60, 0, 0)])]),
        (7, 20, ["  ", "<img src=a.png>", "picture only", ""], [(0, 0, 0, 1, 0, "", [])]),
    ])
    db.commit(); db.close()
    stub = tempfile.mktemp()
    s = sqlite3.connect(stub)
    for t in (COL, NOTES, CARDS, REVLOG): s.execute(t)
    s.execute("INSERT INTO col VALUES (1,0,0,0,11,0,0,0,'{}','{\"1\":{\"id\":1,\"name\":\"Basic\",\"type\":0,\"flds\":[{\"name\":\"Front\",\"ord\":0}]}}','{\"1\":{\"id\":1,\"name\":\"Default\"}}','{}','{}')")
    s.execute("INSERT INTO notes VALUES (1,'x',1,0,0,'','Please update to the latest Anki version, then import the .colpkg/.apkg file again.','',0,0,'')")
    s.commit(); s.close()
    cz = zstandard.ZstdCompressor()
    name = b"dar.wav"
    entry = b"\x0a" + varint(len(name)) + name + b"\x10" + varint(1600)
    media = b"\x0a" + varint(len(entry)) + entry
    with zipfile.ZipFile(os.path.join(OUT, "new.apkg"), "w", zipfile.ZIP_STORED) as z:
        z.write(stub, "collection.anki2")
        z.writestr("collection.anki21b", cz.compress(open(path, "rb").read()))
        z.writestr("media", cz.compress(media))
        z.writestr("0", cz.compress(wav()))

legacy(); modern()
print("made", os.path.join(OUT, "old.apkg"), os.path.join(OUT, "new.apkg"))

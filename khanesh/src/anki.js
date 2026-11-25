/* =====================================================================
   Khānesh · Anki package (.apkg) with schedules and review history
   ===================================================================== */
const SQLJS_CDN = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-asm-memory-growth.js';
// The website copy keeps its own sql.js next to the page and only falls back to the CDN.
const SQLJS_URLS = SITE ? [SITE.lib + 'sql.js/sql-asm-memory-growth.js', SQLJS_CDN] : [SQLJS_CDN];
let sqlPromise = null;
function loadSqlJs() {
  if (sqlPromise) return sqlPromise;
  sqlPromise = (async () => {
    let fetched = false;
    for (const url of SQLJS_URLS) {
      if (typeof window.initSqlJs === 'function') break;
      try { await loadScript(url); fetched = true; } catch { /* try the next copy */ }
    }
    if (typeof window.initSqlJs !== 'function') {
      throw new Error(fetched ? 'The Anki packager didn’t load.' : 'Couldn’t load the Anki packager. Check your connection and try again.');
    }
    try { return await window.initSqlJs(); } catch { throw new Error('The Anki packager couldn’t start.'); }
  })();
  sqlPromise.catch(() => { sqlPromise = null; });
  return sqlPromise;
}

/* ---------- a minimal zip writer (stored, no compression) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files) {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/* ---------- Anki's collection format (schema 11, which every Anki version imports) ---------- */
const ANKI_SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);`;
const ANKI_MODEL_ID = 1731000000123; // fixed, so later exports reuse the same note type
const ANKI_FIELDS = ['Term', 'Meaning', 'Root', 'Notes', 'Sentence', 'Source', 'Language'];
const ANKI_CSS = `.card { font-family: "Noto Serif", "Noto Naskh Arabic", "Noto Serif Devanagari", serif; font-size: 20px; text-align: center; color: black; background-color: white; line-height: 1.6; }
.kw-term { font-size: 1.9em; }
.kw-sent { font-size: .9em; opacity: .75; margin-top: .6em; }
.kw-meaning { font-size: 1.25em; }
.kw-root, .kw-src { opacity: .7; font-size: .85em; margin-top: .4em; }
.kw-notes { margin-top: .5em; font-size: .95em; }`;
const noteGuid = (code, k) => 'kw' + code.replace(/[^a-z0-9]/gi, '') + hash32(k).toString(36) + hash32(code + '\u0000' + k).toString(36);
const ankiId = (salt, s) => 1500000000000 + (hash32(salt + s) % 4000000000) * 10 + (hash32(s + salt) % 10);
const stripHtml = s => String(s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
async function sha1Csum(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-1', enc.encode(text));
    const hex = [...new Uint8Array(buf)].slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('');
    return parseInt(hex, 16);
  } catch { return 0; }
}
function ankiModel(nowS, did) {
  const q = '<div class="kw-term" dir="auto">{{Term}}</div>{{#Sentence}}<div class="kw-sent" dir="auto">{{Sentence}}</div>{{/Sentence}}';
  const a = '{{FrontSide}}<hr id="answer"><div class="kw-meaning" dir="auto">{{Meaning}}</div>{{#Root}}<div class="kw-root" dir="auto">from {{Root}}</div>{{/Root}}{{#Notes}}<div class="kw-notes" dir="auto">{{Notes}}</div>{{/Notes}}{{#Source}}<div class="kw-src" dir="auto">{{Source}}</div>{{/Source}}';
  const q2 = '{{#Meaning}}<div class="kw-meaning" dir="auto">{{Meaning}}</div>{{/Meaning}}';
  const a2 = '{{FrontSide}}<hr id="answer"><div class="kw-term" dir="auto">{{Term}}</div>{{#Root}}<div class="kw-root" dir="auto">from {{Root}}</div>{{/Root}}{{#Sentence}}<div class="kw-sent" dir="auto">{{Sentence}}</div>{{/Sentence}}{{#Notes}}<div class="kw-notes" dir="auto">{{Notes}}</div>{{/Notes}}{{#Source}}<div class="kw-src" dir="auto">{{Source}}</div>{{/Source}}';
  return {
    id: ANKI_MODEL_ID, name: 'Khwānish word', type: 0, mod: nowS, usn: -1, sortf: 0, did,
    tmpls: [
      { name: 'Word → meaning', ord: 0, qfmt: q, afmt: a, did: null, bqfmt: '', bafmt: '' },
      { name: 'Meaning → word', ord: 1, qfmt: q2, afmt: a2, did: null, bqfmt: '', bafmt: '' },
    ],
    flds: ANKI_FIELDS.map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
    css: ANKI_CSS,
    latexPre: '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
    latexPost: '\\end{document}', latexsvg: false,
    req: [[0, 'any', [0]], [1, 'any', [1]]], tags: [], vers: [],
  };
}
function ankiDeck(id, name, nowS) {
  return { id, name, mod: nowS, usn: -1, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0],
    collapsed: false, browserCollapsed: false, desc: '', dyn: 0, conf: 1, extendNew: 0, extendRev: 0 };
}
const ANKI_DCONF = { 1: {
  id: 1, mod: 0, name: 'Default', usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
  new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20 },
  lapse: { delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0 },
  rev: { bury: false, ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200, hardFactor: 1.2 },
} };

// rows: [code, key, entry]; deckFor(code) → deck name; reverse: include meaning→word cards
async function buildApkg(rows, deckFor, reverse) {
  const SQL = await loadSqlJs();
  const db = new SQL.Database();
  try {
    db.run(ANKI_SCHEMA);
    const now = Date.now(), nowS = Math.floor(now / 1000);
    const today0 = dayStart(now);
    const decks = { 1: ankiDeck(1, 'Default', nowS) };
    const deckIds = new Map();
    const deckOf = code => {
      const name = deckFor(code);
      if (!deckIds.has(name)) {
        const id = ankiId('deck:', name);
        deckIds.set(name, id);
        decks[id] = ankiDeck(id, name, nowS);
        // parent decks must exist too
        const parts = name.split('::');
        for (let i = 1; i < parts.length; i++) {
          const pn = parts.slice(0, i).join('::');
          const pid = ankiId('deck:', pn);
          if (!decks[pid]) decks[pid] = ankiDeck(pid, pn, nowS);
        }
      }
      return deckIds.get(name);
    };
    const usedIds = new Set();
    const uniq = id => { while (usedIds.has(id)) id++; usedIds.add(id); return id; };
    const ret = S.settings.retention;
    let newPos = 0, nCards = 0, nReviews = 0;
    const sorted = [...rows].sort((a, b) => (a[2].a || a[2].u || 0) - (b[2].a || b[2].u || 0));
    db.run('BEGIN');
    const insNote = db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const insCard = db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insRev = db.prepare('INSERT INTO revlog VALUES (?,?,?,?,?,?,?,?,?)');
    for (const [code, k, e] of sorted) {
      const lang = langOrStub(code);
      const did = deckOf(code);
      const form = e.f || k;
      const flds = [escHtml(form), escHtml(e.m || ''), escHtml(e.r || ''), escHtml(e.n || ''), e.x ? markHtml(e.x, e.f || '') : '', escHtml(e.o || ''), escHtml(lang.name)];
      const nid = uniq(ankiId('note:', code + '\u0000' + k));
      const sfld = stripHtml(flds[0]);
      insNote.run([nid, noteGuid(code, k), ANKI_MODEL_ID, nowS, -1, ` khwanish lang::${code} `, flds.join('\x1f'), sfld, await sha1Csum(sfld), 0, '']);
      const dirs = [1];
      if (reverse && e.m) dirs.push(2);
      for (const dir of dirs) {
      const c = e.s === 1 ? cardOf(e, dir) : null;
      const cid = uniq(ankiId('card:', code + '\u0000' + k + (dir === 2 ? '\u0000r' : '')));
      let type = 0, queue = 0, due, ivl = 0, factor = 0, left = 0, data = '';
      if (!c || !c.q) { due = ++newPos; }
      else {
        factor = 2500;
        data = JSON.stringify({ s: Math.round(c.S * 1e4) / 1e4, d: Math.round(c.D * 1e4) / 1e4, dr: ret });
        if (c.q === 2) {
          type = 2; queue = 2;
          ivl = c.ivl || Math.max(1, Math.round((c.due - (c.lr || now)) / DAY));
          due = Math.round((dayStart(c.due) - today0) / DAY);
        } else {
          type = c.q === 3 ? 3 : 1; queue = 1;
          due = Math.floor(c.due / 1000);
          const remaining = c.q === 3 ? 1 : Math.max(1, 2 - (c.st || 0));
          left = remaining * 1000 + remaining;
          ivl = c.q === 3 ? Math.max(1, Math.round(c.S)) : 0;
        }
      }
      insCard.run([cid, nid, did, dir - 1, nowS, -1, type, queue, due, ivl, factor, c ? c.rp || 0 : 0, c ? c.lp || 0 : 0, left, 0, 0, 0, data]);
      nCards++;
      for (const r of (c && c.h) || []) {
        const [t, g, ty, iv, liv] = r;
        insRev.run([uniq(t * 1000), cid, -1, g, iv, liv, ty === 1 || ty === 2 ? 2500 : 0, 0, ty]);
        nReviews++;
      }
      }
    }
    insNote.free(); insCard.free(); insRev.free();
    db.run('COMMIT');
    const firstDeck = deckIds.size ? [...deckIds.values()][0] : 1;
    const conf = { activeDecks: [firstDeck], curDeck: firstDeck, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true,
      dueCounts: true, curModel: String(ANKI_MODEL_ID), nextPos: newPos + 1, sortType: 'noteFld', sortBackwards: false, addToCur: true, schedVer: 2 };
    db.run('INSERT INTO col VALUES (1,?,?,?,11,0,0,0,?,?,?,?,?)', [
      Math.floor(today0 / 1000), now, now, JSON.stringify(conf),
      JSON.stringify({ [ANKI_MODEL_ID]: ankiModel(nowS, firstDeck) }), JSON.stringify(decks), JSON.stringify(ANKI_DCONF), '{}']);
    const bytes = db.export();
    const blob = zipStore([{ name: 'collection.anki2', data: bytes }, { name: 'media', data: enc.encode('{}') }]);
    return { blob, cards: nCards, reviews: nReviews };
  } finally { db.close(); }
}

/* =====================================================================
   Importing from Anki (.apkg and .colpkg)
   Old packages hold collection.anki2 (or .anki21); new ones hold collection.anki21b,
   compressed with zstd, beside a stub .anki2 that only says "please update Anki".
   ===================================================================== */
const FZSTD_CDN = 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/umd/index.js';
const FZSTD_URLS = SITE ? [SITE.lib + 'fzstd/index.js', FZSTD_CDN] : [FZSTD_CDN];
async function loadZstd() {
  for (const url of FZSTD_URLS) {
    if (window.fzstd) break;
    try { await loadScript(url); } catch { /* try the next copy */ }
  }
  if (!window.fzstd) throw new Error('Couldn’t load what reads new Anki packages. Check your connection and try again.');
  return window.fzstd;
}
const isZstd = u8 => u8.length > 4 && u8[0] === 0x28 && u8[1] === 0xb5 && u8[2] === 0x2f && u8[3] === 0xfd;
async function unzstd(u8) { return isZstd(u8) ? (await loadZstd()).decompress(u8) : u8; }

// A small zip reader: lists the entries and inflates the ones asked for.
function zipEntries(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('That file isn’t an Anki package.');
  let n = dv.getUint16(eocd + 10, true), off = dv.getUint32(eocd + 16, true);
  const out = new Map();
  const dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true), extra = dv.getUint16(off + 30, true), comment = dv.getUint16(off + 32, true);
    const local = dv.getUint32(off + 42, true);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
    out.set(name, { method, csize, local });
    off += 46 + nameLen + extra + comment;
  }
  const read = async name => {
    const e = out.get(name);
    if (!e) return null;
    const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
    const raw = u8.subarray(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new Error('That Anki package uses a kind of compression Khānesh can’t read.');
    const ds = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(ds).arrayBuffer());
  };
  return { names: [...out.keys()], read };
}
// The media list in new packages: zstd-compressed protobuf, entries { 1: name, 255: file number in the zip }
function readMediaProto(u8) {
  const out = {};
  let p = 0, idx = 0;
  const varint = () => { let x = 0, s = 0, b; do { b = u8[p++]; x += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return x; };
  const dec = new TextDecoder();
  while (p < u8.length) {
    const tag = varint();
    if ((tag & 7) !== 2) { if ((tag & 7) === 0) varint(); else break; continue; }
    const len = varint(), end = p + len;
    let name = '', zipName = String(idx);
    while (p < end) {
      const t = varint(), f = Math.floor(t / 8), w = t & 7;
      if (w === 0) { const v = varint(); if (f === 255) zipName = String(v); }
      else if (w === 2) { const l = varint(); if (f === 1) name = dec.decode(u8.subarray(p, p + l)); p += l; }
      else { p = end; }
    }
    p = end;
    if (name) out[zipName] = name;
    idx++;
  }
  return out;
}
// Text of a field: line breaks kept as "; ", sounds and pictures dropped.
function ankiText(html) {
  const s = String(html || '').replace(/\[sound:[^\]]*\]/g, ' ').replace(/<br\s*\/?>|<\/(div|p|li)>/gi, '\n');
  const t = new DOMParser().parseFromString(s, 'text/html').body.textContent || '';
  return t.split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join('; ');
}
const ankiSound = html => { const m = String(html || '').match(/\[sound:([^\]]+)\]/); return m ? m[1] : ''; };
const ANKI_AUDIO = /\.(mp3|m4a|aac|ogg|oga|opus|wav|webm|flac)$/i;

// Read a package: note types with their fields, decks, notes with their cards and review history.
async function readAnkiPackage(file) {
  const zip = zipEntries(await file.arrayBuffer());
  const pick = ['collection.anki21b', 'collection.anki21', 'collection.anki2'].find(n => zip.names.includes(n));
  if (!pick) throw new Error('That file isn’t an Anki package.');
  const bytes = await unzstd(await zip.read(pick));
  const SQL = await loadSqlJs();
  const db = new SQL.Database(bytes);
  try {
    const all = (sql, args) => { const st = db.prepare(sql); if (args) st.bind(args); const r = []; while (st.step()) r.push(st.getAsObject()); st.free(); return r; };
    const tables = new Set(all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name));
    const col = all('SELECT * FROM col')[0] || {};
    const crt = +col.crt || 0;
    const types = new Map(), decks = new Map();
    if (col.models && String(col.models).length > 2) {
      for (const m of Object.values(JSON.parse(col.models)))
        types.set(String(m.id), { id: String(m.id), name: m.name, cloze: m.type === 1, fields: (m.flds || []).sort((a, b) => a.ord - b.ord).map(f => f.name) });
    } else if (tables.has('notetypes')) {
      for (const t of all('SELECT id, name FROM notetypes'))
        types.set(String(t.id), { id: String(t.id), name: t.name, cloze: false, fields: all('SELECT name FROM fields WHERE ntid = ? ORDER BY ord', [t.id]).map(f => f.name) });
    }
    if (col.decks && String(col.decks).length > 2) {
      for (const d of Object.values(JSON.parse(col.decks))) decks.set(String(d.id), d.name);
    } else if (tables.has('decks')) {
      for (const d of all('SELECT id, name FROM decks')) decks.set(String(d.id), String(d.name).replace(/\x1f/g, '::'));
    }
    const notes = all('SELECT id, mid, flds FROM notes').map(n => ({ id: String(n.id), mid: String(n.mid), flds: String(n.flds).split('\x1f'), cards: [] }));
    const byId = new Map(notes.map(n => [n.id, n]));
    for (const c of all('SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, odue, odid, data FROM cards')) {
      const n = byId.get(String(c.nid));
      if (n) n.cards.push({ ...c, id: String(c.id) });
    }
    const hist = new Map();
    if (tables.has('revlog')) for (const r of all('SELECT id, cid, ease, ivl, lastIvl, type FROM revlog ORDER BY id')) {
      const k = String(r.cid);
      if (!hist.has(k)) hist.set(k, []);
      hist.get(k).push([Math.round(r.id / 1000), r.ease, r.type, r.ivl, r.lastIvl]);
    }
    // a stub left by new Anki versions for old ones
    if (pick === 'collection.anki2' && notes.length === 1 && /update|newer version/i.test(notes[0].flds.join(' ')) && !zip.names.includes('media'))
      throw new Error('This package was made by a newer Anki and couldn’t be read. In Anki, export it again with “Support older Anki versions” ticked.');
    let media = {};
    const mf = await zip.read('media');
    if (mf && mf.length) {
      const m = await unzstd(mf);
      try { media = JSON.parse(new TextDecoder().decode(m)); } catch { media = readMediaProto(m); }
    }
    const byName = new Map(Object.entries(media).map(([z, name]) => [name, z]));
    const audio = async name => {
      const z = byName.get(name);
      if (!z || !ANKI_AUDIO.test(name)) return null;
      const raw = await zip.read(z);
      if (!raw) return null;
      const ext = name.split('.').pop().toLowerCase();
      const mime = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm', flac: 'audio/flac' }[ext];
      return new Blob([await unzstd(raw)], { type: mime });
    };
    return { crt, types, decks, notes, hist, audio };
  } finally { db.close(); }
}
// An Anki card's schedule as a Khānesh card. FSRS memory states come across when Anki has them;
// otherwise stability is taken from the interval and difficulty from the ease.
function ankiCard(c, crt, hist) {
  const now = Date.now();
  const due0 = +c.odid ? +c.odue : +c.due;
  const type = +c.type;
  if (!type) return newCard();
  let data = {};
  try { data = c.data ? JSON.parse(c.data) : {}; } catch { data = {}; }
  const ivl = Math.max(0, +c.ivl || 0);
  const D = data.d ? clamp(+data.d, 1, 10) : clamp(5 + (2500 - (+c.factor || 2500)) / 200, 1, 10);
  // Anki counts review days from when the collection was made; count from today's number instead
  const ankiToday = crt ? Math.floor((now / 1000 - crt) / 86400) : 0;
  const dayDue = d => dayStart(now) + (crt ? d - ankiToday : 0) * DAY;
  const n = { q: 0, due: now, S: 0, D, rp: +c.reps || 0, lp: +c.lapses || 0, lr: 0, st: 0 };
  if (type === 2) {
    n.q = 2; n.ivl = Math.max(1, ivl); n.due = dayDue(due0);
    n.S = data.s ? +data.s : Math.max(1, ivl);
    n.lr = n.due - n.ivl * DAY;
  } else {
    n.q = type === 3 ? 3 : 1;
    n.due = +c.queue === 3 || due0 < 1e8 ? dayDue(due0) : due0 * 1000;
    n.S = data.s ? +data.s : type === 3 ? Math.max(1, ivl) : 1;
  }
  const h = hist.get(c.id);
  if (h && h.length) { n.h = h.slice(-200); n.lr = Math.max(n.lr, h[h.length - 1][0] * 1000); }
  if (!n.lr) n.lr = Math.min(now, n.due);
  return n;
}

/* =====================================================================
   Khwānish · Anki package (.apkg) with schedules and review history
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

/* =====================================================================
   Khwānish · storage: this device (IndexedDB) + your account (db)
   ===================================================================== */

/* ---------- local (IndexedDB → localStorage → memory) ---------- */
const Local = {
  mode: 'memory', idb: null, mem: new Map(),
  async open() {
    try {
      if (!('indexedDB' in window) || !window.indexedDB) throw new Error('no idb');
      this.idb = await withTimeout(new Promise((res, rej) => {
        const r = indexedDB.open('khwanish', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('blocked'));
      }), 4000, 'local storage');
      this.mode = 'idb';
      return;
    } catch { this.idb = null; }
    try { localStorage.setItem('kw:t', '1'); localStorage.removeItem('kw:t'); this.mode = 'ls'; }
    catch { this.mode = 'memory'; }
  },
  async get(k) {
    try {
      if (this.mode === 'idb') return await new Promise((res, rej) => {
        const r = this.idb.transaction('kv').objectStore('kv').get(k);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      if (this.mode === 'ls') { const v = localStorage.getItem('kw:' + k); return v == null ? undefined : JSON.parse(v); }
    } catch (e) { console.warn('local read failed', k, e); }
    return this.mem.get(k);
  },
  async set(k, v) {
    try {
      if (this.mode === 'idb') return await new Promise((res, rej) => {
        const tx = this.idb.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(v, k);
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
      });
      if (this.mode === 'ls') { localStorage.setItem('kw:' + k, JSON.stringify(v)); return; }
    } catch (e) { console.warn('local write failed', k, e); }
    this.mem.set(k, v);
  },
  async del(k) {
    try {
      if (this.mode === 'idb') return await new Promise((res, rej) => {
        const tx = this.idb.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(k);
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
      if (this.mode === 'ls') { localStorage.removeItem('kw:' + k); return; }
    } catch (e) { console.warn('local delete failed', k, e); }
    this.mem.delete(k);
  },
};

/* ---------- app state ---------- */
const S = {
  settings: null,
  stats: { days: {}, u: 0 },
  lessons: new Map(),      // id → meta (tombstones have del:1)
  vocab: new Map(),        // lang → Map(key → entry)
  loaded: new Set(),       // languages read from this device
  cloudLoaded: new Set(),  // languages read from your account
  texts: new Map(),        // lesson id → text (cache)
  media: new Map(),        // lesson id → recording (Blob), this device only
  meta: {},                // device-only: lastLesson, cloudSeen
};
function defaultSettings() {
  return {
    v: APPV, u: 0, cur: 'fa',
    langs: DEFAULT_LANGS.map(c => makeLang(CATALOG_BY_CODE[c])),
    font: 'serif', size: 21, lh: 1.95, pageWords: 220,
    autoKnown: true, autoCard: true, highlight: true,
    retention: 0.9, newPerDay: 20, frontSentence: true, maxIvl: 36500, reverse: true,
    ai: true, aiTier: 'quick', scope: 'lang', shards: {},
  };
}
function fixSettings(s) {
  const d = defaultSettings();
  const out = { ...d, ...(s || {}) };
  out.langs = Array.isArray(out.langs) && out.langs.length ? out.langs.map(fixLang) : d.langs;
  out.shards = { ...(out.shards || {}) };
  if (!out.langs.some(l => l.code === out.cur)) out.cur = out.langs[0].code;
  if ((out.v || 1) < 2) {
    // v2: Abadis for Persian, Dari and Hazaragi
    for (const l of out.langs) {
      if (!['fa', 'prs', 'haz'].includes(l.code) || l.dicts.some(d => /abadis\.ir/.test(d.u))) continue;
      const i = l.dicts.findIndex(d => /vajehyab/.test(d.u));
      l.dicts.splice(i + 1, 0, DICTS.abadis());
    }
  }
  out.v = APPV;
  return out;
}
const L = (code = S.settings.cur) => S.settings.langs.find(l => l.code === code) || null;
function langOrStub(code) { return L(code) || fixLang({ code, name: (CATALOG_BY_CODE[code] || {}).name || code }); }
function vmap(code) { let m = S.vocab.get(code); if (!m) S.vocab.set(code, m = new Map()); return m; }
function entry(code, key) { const e = vmap(code).get(key); return e && !e.d ? e : null; }
const shardCount = code => (S.settings.shards && S.settings.shards[code]) || 8;

/* ---------- entry encoding for your account (compact arrays) ---------- */
// [s, u, a, m, r, n, x, f, o, p, c, ex, c2]; deleted = [-1, u]. c = word→meaning card, c2 = meaning→word card
const E_DEF = [0, 0, 0, '', '', '', '', '', '', 0, null, 0, null];
function encC(c) {
  const r4 = x => Math.round((x || 0) * 1e4) / 1e4;
  const a = [c.q || 0, c.due || 0, r4(c.S), r4(c.D), c.rp || 0, c.lp || 0, c.lr || 0, c.st || 0];
  if (c.h && c.h.length) a.push(c.h);
  return a;
}
function decC(a) {
  if (!Array.isArray(a)) return null;
  const c = { q: a[0] || 0, due: a[1] || 0, S: a[2] || 0, D: a[3] || 0, rp: a[4] || 0, lp: a[5] || 0, lr: a[6] || 0, st: a[7] || 0 };
  if (Array.isArray(a[8]) && a[8].length) c.h = a[8];
  return c;
}
function encE(e) {
  if (!e || e.d) return [-1, (e && e.u) || 0];
  const a = [e.s || 0, e.u || 0, e.a || 0, e.m || '', e.r || '', e.n || '', e.x || '', e.f || '', e.o || '', e.p ? 1 : 0, e.c ? encC(e.c) : null, e.ex || 0, e.c2 ? encC(e.c2) : null];
  let n = a.length;
  while (n > 2 && a[n - 1] === E_DEF[n - 1]) n--;
  return a.slice(0, n);
}
function decE(a) {
  if (!Array.isArray(a)) return null;
  if (a[0] === -1) return { d: 1, u: a[1] || 0 };
  const e = { s: a[0] || 0, u: a[1] || 0 };
  if (a[2]) e.a = a[2];
  if (a[3]) e.m = a[3];
  if (a[4]) e.r = a[4];
  if (a[5]) e.n = a[5];
  if (a[6]) e.x = a[6];
  if (a[7]) e.f = a[7];
  if (a[8]) e.o = a[8];
  if (a[9]) e.p = 1;
  if (a[10]) e.c = decC(a[10]);
  if (a[11]) e.ex = a[11];
  if (a[12]) e.c2 = decC(a[12]);
  return e;
}

/* ---------- saving to this device ---------- */
const Persist = {
  langs: new Set(), core: false, t: 0, writing: null,
  touch(lang) {
    if (lang) this.langs.add(lang); else this.core = true;
    clearTimeout(this.t);
    this.t = setTimeout(() => this.write(), 700);
  },
  async write() {
    clearTimeout(this.t);
    const langs = [...this.langs]; this.langs.clear();
    const core = this.core; this.core = false;
    const job = (async () => {
      if (core) {
        await Local.set('settings', S.settings);
        await Local.set('stats', S.stats);
        await Local.set('lessons', [...S.lessons.values()]);
        await Local.set('meta', S.meta);
      }
      for (const c of langs) await Local.set('v:' + c, Object.fromEntries(S.vocab.get(c) || []));
      await Local.set('pending', Sync.serialize());
    })();
    this.writing = job;
    try { await job; } finally { if (this.writing === job) this.writing = null; }
  },
};

/* ---------- state changes ---------- */
function putEntry(code, key, patch) {
  const m = vmap(code);
  const prev = m.get(key);
  const now = Date.now();
  const base = prev && !prev.d ? prev : { s: 0, a: now };
  const e = { ...base, ...patch, u: now };
  delete e.d;
  for (const k of ['m', 'r', 'n', 'x', 'f', 'o']) if (e[k] == null || e[k] === '') delete e[k];
  if (!e.c) delete e.c;
  if (!e.c2) delete e.c2;
  if (!e.p) delete e.p;
  if (!e.ex) delete e.ex;
  if ((e.s === 2 || e.s === 3) && !e.m && !e.r && !e.n && !e.p) { delete e.a; delete e.x; delete e.o; delete e.f; }
  m.set(key, e);
  Sync.markEntry(code, key);
  Persist.touch(code);
  return e;
}
function deleteEntry(code, key) {
  const m = vmap(code);
  if (!m.has(key)) return;
  m.set(key, { d: 1, u: Date.now() });
  Sync.markEntry(code, key);
  Persist.touch(code);
}
function restoreEntry(code, key, prev) {
  if (prev) { vmap(code).set(key, { ...prev, u: Date.now() }); Sync.markEntry(code, key); Persist.touch(code); }
  else deleteEntry(code, key);
}
function setSettings(patch) {
  Object.assign(S.settings, patch, { u: Date.now() });
  Sync.markDirty('settings');
  Persist.touch();
}
function setMeta(patch) { Object.assign(S.meta, patch); Persist.touch(); }
function putLesson(meta) {
  meta.u = Date.now();
  S.lessons.set(meta.id, meta);
  Sync.markDirty('lm.' + meta.id);
  Persist.touch();
}
function bumpStat(field, n = 1) {
  const d = dayKey();
  const day = S.stats.days[d] || (S.stats.days[d] = {});
  day[field] = Math.max(0, (day[field] || 0) + n);
  S.stats.u = Date.now();
  Sync.markDirty('stats', 5000);
  Persist.touch();
}
const today = () => S.stats.days[dayKey()] || {};
function pruneDays(days) {
  const keys = Object.keys(days).sort();
  const out = {};
  for (const k of keys.slice(-400)) out[k] = days[k];
  return out;
}

/* ---------- your account (the artifact's private db) ---------- */
const Cloud = {
  state: 'init', // init | ready | local | offline
  db: null, user: null, uid: null, col: null,
  known: new Set(), failing: new Set(),
  sample: null, downloads: null, imageOCR: false, plainFiles: false,
  async connect() {
    const C = window.claude;
    if (!C || typeof C.use !== 'function') return false;
    let db = null, user = null;
    try { [db, user] = await Promise.all([C.use('db'), C.use('user')]); } catch { return false; }
    if (!db || !user) return false;
    let id = null;
    try { id = await user.id(); } catch { id = null; }
    if (!id) return false;
    this.db = db; this.user = user; this.uid = id;
    try { this.col = db.collection('data/users/' + id); } catch { return false; }
    return true;
  },
  doc(id) { return this.col.doc(id); },
  async write(id) {
    if (id === 'settings') return this.doc('settings').set({ t: 'set', s: S.settings, u: S.settings.u || 0 });
    if (id === 'stats') return this.doc('stats').set({ t: 'stats', days: pruneDays(S.stats.days), u: S.stats.u || 0 });
    if (id.startsWith('lm.')) {
      const m = S.lessons.get(id.slice(3));
      if (!m) return;
      return this.doc(id).set({ ...m, t: 'lm' });
    }
  },
};
// Outside Claude (the website copy, or the page opened as a file) the browser saves files itself,
// so packages keep their real .apkg name.
const BrowserFiles = {
  async save({ filename, data }) {
    const type = /\.json$/i.test(filename) ? 'application/json' : /\.txt$/i.test(filename) ? 'text/plain;charset=utf-8' : 'application/octet-stream';
    // re-wrap binary data so no browser renames an .apkg after its zip contents
    const blob = data instanceof Blob && !/\.apkg$/i.test(filename) ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60e3);
  },
};
async function connectExtras() {
  const C = window.claude;
  if (!C || typeof C.use !== 'function') {
    Cloud.downloads = BrowserFiles;
    Cloud.plainFiles = true;
    UI.capsChanged();
    return;
  }
  const [sample, downloads] = await Promise.all([
    C.use('sample').catch(() => null),
    C.use('downloads').catch(() => null),
  ]);
  Cloud.sample = sample || null;
  Cloud.downloads = downloads || null;
  if (sample && sample.limits) {
    try { const lim = await sample.limits(); Cloud.imageOCR = !!(lim && lim.images); } catch { Cloud.imageOCR = false; }
  }
  UI.capsChanged();
}

/* ---------- the sync queue ---------- */
const Sync = {
  v: new Map(),       // shard doc id → Set(keys)
  dirty: new Set(),   // 'settings' | 'stats' | 'lm.<id>'
  texts: new Set(),   // lesson ids whose text must be uploaded
  dels: new Set(),    // doc ids to delete
  running: false, timer: 0, backoff: 0, lastErr: null,
  shardDoc(code, key) { const n = shardCount(code); return `v.${code}.${n}.${hash32(key) % n}`; },
  markEntry(code, key) {
    const id = this.shardDoc(code, key);
    let s = this.v.get(id);
    if (!s) this.v.set(id, s = new Set());
    s.add(key);
    this.kick();
  },
  markDirty(id, delay) { this.dirty.add(id); this.kick(delay); },
  has() { return this.v.size + this.dirty.size + this.texts.size + this.dels.size > 0; },
  kick(delay = 1500) {
    UI.syncStatus();
    if (Cloud.state !== 'ready') return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  },
  serialize() {
    return { v: [...this.v].map(([id, s]) => [id, [...s]]), dirty: [...this.dirty], texts: [...this.texts], dels: [...this.dels] };
  },
  restore(p) {
    if (!p) return;
    for (const [id, keys] of p.v || []) { const s = this.v.get(id) || new Set(); keys.forEach(k => s.add(k)); this.v.set(id, s); }
    (p.dirty || []).forEach(x => this.dirty.add(x));
    (p.texts || []).forEach(x => this.texts.add(x));
    (p.dels || []).forEach(x => this.dels.add(x));
  },
  requeue(groups) {
    for (const [id, keys] of groups) {
      let s = this.v.get(id);
      if (!s) this.v.set(id, s = new Set());
      keys.forEach(k => s.add(k));
    }
  },
  async flush() {
    if (this.running || Cloud.state !== 'ready' || !this.has()) { UI.syncStatus(); return; }
    this.running = true; this.lastErr = null; UI.syncStatus();
    let groups = null;
    try {
      // 1. lesson texts (before their metadata, so other devices never see a lesson without text)
      for (const lid of [...this.texts]) { await uploadText(lid); this.texts.delete(lid); }
      // 2. settings, stats, lesson metadata
      for (const id of [...this.dirty]) {
        this.dirty.delete(id);
        try { await withTimeout(Cloud.write(id), 20000, 'save'); }
        catch (e) { this.dirty.add(id); throw e; }
      }
      // 3. words, grouped by their current shard document
      groups = new Map();
      for (const [id, keys] of this.v) {
        const code = id.split('.')[1];
        for (const k of keys) {
          const nid = this.shardDoc(code, k);
          let s = groups.get(nid);
          if (!s) groups.set(nid, s = new Set());
          s.add(k);
        }
      }
      this.v = new Map();
      const codes = new Set([...groups.keys()].map(id => id.split('.')[1]));
      for (const code of codes) {
        if (maxShardBytes(code) > 190000) {
          await reshard(code);
          const regroup = new Map();
          for (const [id, keys] of groups) {
            if (id.split('.')[1] !== code) { regroup.set(id, keys); continue; }
            for (const k of keys) {
              const nid = this.shardDoc(code, k);
              let s = regroup.get(nid);
              if (!s) regroup.set(nid, s = new Set());
              s.add(k);
            }
          }
          groups = regroup;
        }
      }
      let firstErr = null;
      const ids = [...groups.keys()].filter(id => !Cloud.failing.has(id));
      const skipped = [...groups.keys()].filter(id => Cloud.failing.has(id));
      this.requeue(skipped.map(id => [id, groups.get(id)]));
      await pool(ids, 3, async id => {
        const keys = groups.get(id);
        try { await writeShard(id, keys); }
        catch (e) {
          firstErr = firstErr || e;
          if (e && e.code === 'invalid_argument') Cloud.failing.add(id);
          this.requeue([[id, keys]]);
        }
      });
      groups = null;
      if (firstErr) throw firstErr;
      // 4. deletions
      for (const id of [...this.dels]) { await withTimeout(Cloud.doc(id).delete(), 20000, 'delete'); this.dels.delete(id); }
      this.backoff = 0;
    } catch (e) {
      if (groups) this.requeue(groups);
      this.lastErr = e;
      console.warn('sync failed', e);
      const code = e && e.code;
      if (code === 'revoked' || code === 'not_granted' || code === 'capability_disabled' || code === 'capability_removed') {
        Cloud.state = 'local';
      } else if (code === 'quota_exceeded') {
        UI.notice('Your saved data has reached its storage limit, so new changes are only on this device. Back up from Options, then delete old texts to free space.');
      } else {
        this.backoff = Math.min(60000, (this.backoff || 2500) * 2);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), this.backoff);
      }
    } finally {
      this.running = false;
      Persist.touch();
      UI.syncStatus();
      if (this.has() && !this.lastErr) this.kick(400);
    }
  },
};
function maxShardBytes(code) {
  const n = shardCount(code);
  const sizes = new Array(n).fill(0);
  for (const [k, e] of vmap(code)) sizes[hash32(k) % n] += (k.length + JSON.stringify(encE(e)).length + 4) * 2.2;
  return Math.max(0, ...sizes);
}
function mergeRemoteEntries(code, w) {
  const m = vmap(code);
  let changed = false;
  const seen = [];
  for (const k in w) {
    const r = decE(w[k]);
    if (!r) continue;
    seen.push(k);
    const l = m.get(k);
    if (!l || (r.u || 0) > (l.u || 0)) { m.set(k, r); changed = true; }
    else if ((l.u || 0) > (r.u || 0)) Sync.markEntry(code, k);
  }
  return { changed, seen };
}
async function writeShard(id, keys) {
  const [, code, nStr, iStr] = id.split('.');
  const n = +nStr, i = +iStr;
  const m = vmap(code);
  const ref = Cloud.doc(id);
  if (!Cloud.known.has(id)) {
    const snap = await withTimeout(ref.get(), 20000, 'read');
    if (snap.exists) {
      if (mergeRemoteEntries(code, (snap.data() || {}).w || {}).changed) { Persist.touch(code); UI.vocabChanged(code); }
      Cloud.known.add(id);
    } else {
      const w = {};
      for (const [k, e] of m) if (hash32(k) % n === i) w[k] = encE(e);
      await withTimeout(ref.set({ t: 'v', vl: code, n, i, w }), 20000, 'save');
      Cloud.known.add(id);
      return;
    }
  }
  const w = {};
  for (const k of keys) { const e = m.get(k); if (e) w[k] = encE(e); }
  if (!Object.keys(w).length) return;
  try { await withTimeout(ref.update({ w }), 20000, 'save'); }
  catch (e) {
    if (e && e.code === 'invalid_argument' && !keys.__retried) {
      // the document may have been removed elsewhere: read it again and recreate
      Cloud.known.delete(id);
      keys.__retried = true;
      return writeShard(id, keys);
    }
    throw e;
  }
}
async function reshard(code) {
  const n = shardCount(code), n2 = n * 2;
  const shards = Array.from({ length: n2 }, () => ({}));
  for (const [k, e] of vmap(code)) shards[hash32(k) % n2][k] = encE(e);
  for (let i = 0; i < n2; i++) {
    const id = `v.${code}.${n2}.${i}`;
    await withTimeout(Cloud.doc(id).set({ t: 'v', vl: code, n: n2, i, w: shards[i] }), 20000, 'save');
    Cloud.known.add(id);
  }
  S.settings.shards = { ...S.settings.shards, [code]: n2 };
  S.settings.u = Date.now();
  await withTimeout(Cloud.write('settings'), 20000, 'save');
  for (let i = 0; i < n; i++) Sync.dels.add(`v.${code}.${n}.${i}`);
}
async function uploadText(lid) {
  const m = S.lessons.get(lid);
  if (!m || m.del) return;
  let text = S.texts.get(lid);
  if (text == null) text = await Local.get('lt:' + lid);
  if (text == null) return;
  const chunks = chunkText(text, 180000);
  for (let i = 0; i < chunks.length; i++) {
    await withTimeout(Cloud.doc(`lt.${lid}.${i}`).set({ t: 'lt', s: chunks[i] }), 30000, 'upload');
  }
  if (m.chunks !== chunks.length) { m.chunks = chunks.length; Sync.dirty.add('lm.' + lid); }
}

/* ---------- loading ---------- */
async function ensureLangLocal(code) {
  if (S.loaded.has(code)) return;
  S.loaded.add(code);
  const obj = await Local.get('v:' + code);
  if (obj) {
    const m = vmap(code);
    for (const k in obj) { const l = m.get(k), r = obj[k]; if (!l || (r.u || 0) > (l.u || 0)) m.set(k, r); }
  }
}
async function ensureLang(code) {
  await ensureLangLocal(code);
  if (Cloud.state === 'ready' && !S.cloudLoaded.has(code)) await loadLangCloud(code);
}
async function loadLangCloud(code) {
  if (S.cloudLoaded.has(code)) return;
  S.cloudLoaded.add(code);
  try {
    const snap = await withTimeout(Cloud.col.where('vl', '==', code).limit(1000).get(), 25000, 'load words');
    const seen = new Set();
    let changed = false;
    for (const d of snap.docs) {
      Cloud.known.add(d.id);
      const r = mergeRemoteEntries(code, (d.data() || {}).w || {});
      r.seen.forEach(k => seen.add(k));
      changed = changed || r.changed;
    }
    for (const k of vmap(code).keys()) if (!seen.has(k)) Sync.markEntry(code, k);
    Persist.touch(code);
    if (changed) UI.vocabChanged(code);
  } catch (e) {
    S.cloudLoaded.delete(code);
    console.warn('loading words failed', code, e);
  }
}
async function getText(lid) {
  if (S.texts.has(lid)) return S.texts.get(lid);
  let t = await Local.get('lt:' + lid);
  if (t == null && Cloud.state === 'ready') {
    const m = S.lessons.get(lid);
    const n = (m && m.chunks) || 1;
    const parts = [];
    try {
      for (let i = 0; i < n; i++) {
        const snap = await withTimeout(Cloud.doc(`lt.${lid}.${i}`).get(), 20000, 'load text');
        if (!snap.exists) { parts.length = 0; break; }
        parts.push((snap.data() || {}).s || '');
      }
    } catch (e) { parts.length = 0; console.warn('loading text failed', e); }
    if (parts.length) { t = parts.join(''); await Local.set('lt:' + lid, t); }
  }
  if (t != null) S.texts.set(lid, t);
  return t;
}
async function cloudSync() {
  UI.syncStatus();
  const ok = await Cloud.connect();
  if (!ok) { Cloud.state = 'local'; UI.syncStatus(); UI.capsChanged(); return; }
  try {
    const snap = await withTimeout(Cloud.col.where('t', 'in', ['set', 'stats', 'lm']).limit(1000).get(), 25000, 'load');
    let rs = null, rst = null;
    const rl = new Map();
    for (const d of snap.docs) {
      const x = d.data() || {};
      Cloud.known.add(d.id);
      if (x.t === 'set') rs = x;
      else if (x.t === 'stats') rst = x;
      else if (x.t === 'lm' && x.id) rl.set(x.id, x);
    }
    // settings: a device's first sync adopts the account's settings
    if (rs && rs.s && (!S.meta.cloudSeen || (rs.u || 0) > (S.settings.u || 0))) {
      const cur = S.settings.cur;
      S.settings = fixSettings(rs.s);
      if (S.meta.cloudSeen && cur && S.settings.langs.some(l => l.code === cur)) S.settings.cur = cur;
      resetLangCaches();
    } else if (!rs || (S.settings.u || 0) > (rs.u || 0)) Sync.dirty.add('settings');
    // stats: keep the larger count for each day
    if (rst && rst.days) {
      for (const [d, v] of Object.entries(rst.days)) {
        const l = S.stats.days[d] || (S.stats.days[d] = {});
        for (const f in v) l[f] = Math.max(l[f] || 0, v[f] || 0);
      }
    }
    if (!rst || (S.stats.u || 0) > (rst.u || 0)) Sync.dirty.add('stats');
    // lessons
    for (const [id, x] of rl) {
      const { t, ...rm } = x;
      const lm = S.lessons.get(id);
      if (!lm || (rm.u || 0) > (lm.u || 0)) {
        S.lessons.set(id, rm);
        if (rm.del) { S.texts.delete(id); Local.del('lt:' + id); }
      } else if ((lm.u || 0) > (rm.u || 0)) Sync.dirty.add('lm.' + id);
    }
    for (const [id, lm] of S.lessons) {
      if (!rl.has(id)) { Sync.dirty.add('lm.' + id); if (!lm.del) Sync.texts.add(id); }
    }
    Cloud.state = 'ready';
    S.meta.cloudSeen = true;
    Persist.touch();
    await Promise.all([...S.loaded].map(c => loadLangCloud(c)));
    UI.refresh();
    Sync.kick(300);
  } catch (e) {
    console.warn('connecting to your account failed', e);
    const code = e && e.code;
    Cloud.state = (code === 'not_granted' || code === 'revoked' || code === 'capability_disabled' || code === 'capability_removed') ? 'local' : 'offline';
    UI.syncStatus();
    if (Cloud.state === 'local') UI.capsChanged(); // the library and options explain browser-only saving
    if (Cloud.state === 'offline') setTimeout(cloudSync, 30000);
  }
}

/* ---------- lessons ---------- */
async function createLesson(code, title, text, src) {
  const lang = langOrStub(code);
  const id = uid();
  const meta = {
    id, lang: code, title: (title || 'Untitled').slice(0, 140),
    words: countWords(text, lang), chunks: chunkText(text, 180000).length,
    page: 0, created: Date.now(), opened: 0, src: src || '',
  };
  S.texts.set(id, text);
  await Local.set('lt:' + id, text);
  putLesson(meta);
  Sync.texts.add(id);
  Sync.kick();
  return meta;
}
function deleteLesson(id) {
  const m = S.lessons.get(id);
  if (!m) return;
  for (let i = 0; i < (m.chunks || 1); i++) Sync.dels.add(`lt.${id}.${i}`);
  S.lessons.set(id, { id, lang: m.lang, del: 1, u: Date.now() });
  S.texts.delete(id);
  Local.del('lt:' + id);
  S.media.delete(id);
  Local.del('media:' + id);
  Sync.texts.delete(id);
  Sync.markDirty('lm.' + id);
  if (S.meta.lastLesson === id) S.meta.lastLesson = null;
  Persist.touch();
}
function splitLong(text, lang, target) {
  const parts = [];
  let cur = [], cw = 0;
  const tok = tokenizer(lang);
  for (const line of text.split('\n')) {
    const w = tok(line).filter(t => t.w).length;
    if (cw + w > target && cw > target * 0.5) { parts.push(cur.join('\n')); cur = []; cw = 0; }
    cur.push(line); cw += w;
  }
  if (cur.length) parts.push(cur.join('\n'));
  return parts.map(p => p.trim()).filter(Boolean);
}

/* ---------- recordings for audio/video texts (kept on this device) ---------- */
function mediaInfo(file) {
  const video = /^video\//.test(file.type) || /\.(mp4|m4v|webm|mkv|mov)$/i.test(file.name);
  return { kind: video ? 'video' : 'audio', name: file.name, type: file.type || '', size: file.size || 0 };
}
async function storeMedia(id, blob) {
  S.media.set(id, blob);
  if (Local.mode !== 'idb') return false;
  try {
    await new Promise((res, rej) => {
      const tx = Local.idb.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(blob, 'media:' + id);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
    return true;
  } catch (e) { console.warn('could not keep the recording', e); return false; }
}
async function getMedia(id) {
  if (S.media.has(id)) return S.media.get(id);
  if (Local.mode !== 'idb') return null;
  const b = await Local.get('media:' + id);
  if (b instanceof Blob) { S.media.set(id, b); return b; }
  return null;
}

/* ---------- backup ---------- */
async function buildBackup() {
  const codes = new Set([...S.settings.langs.map(l => l.code), ...S.vocab.keys()]);
  for (const c of codes) await ensureLang(c);
  const lessons = [];
  for (const m of S.lessons.values()) {
    if (m.del) continue;
    lessons.push({ ...m, text: await getText(m.id) });
  }
  const vocab = {};
  for (const c of codes) {
    const o = {};
    for (const [k, e] of vmap(c)) if (!e.d) o[k] = encE(e);
    if (Object.keys(o).length) vocab[c] = o;
  }
  return JSON.stringify({ app: 'khwanish', v: 1, at: new Date().toISOString(), settings: S.settings, stats: S.stats, lessons, vocab });
}
async function restoreBackup(json) {
  let b;
  try { b = JSON.parse(json); } catch { throw new Error('That file isn’t valid JSON.'); }
  if (!b || b.app !== 'khwanish') throw new Error('That file isn’t a Khwānish backup.');
  const have = new Set(S.settings.langs.map(l => l.code));
  const langs = [...S.settings.langs];
  for (const l of (b.settings && b.settings.langs) || []) if (l && l.code && !have.has(l.code)) langs.push(fixLang(l));
  setSettings({ langs });
  let nl = 0, nw = 0;
  for (const m of b.lessons || []) {
    if (!m || !m.id) continue;
    const cur = S.lessons.get(m.id);
    if (cur && (cur.u || 0) >= (m.u || 0)) continue;
    const { text, ...meta } = m;
    if (text != null) { S.texts.set(meta.id, text); await Local.set('lt:' + meta.id, text); Sync.texts.add(meta.id); }
    S.lessons.set(meta.id, meta);
    Sync.markDirty('lm.' + meta.id);
    nl++;
  }
  for (const [c, o] of Object.entries(b.vocab || {})) {
    await ensureLang(c);
    const m = vmap(c);
    for (const [k, a] of Object.entries(o)) {
      const r = decE(a);
      if (!r) continue;
      const l = m.get(k);
      if (!l || (r.u || 0) > (l.u || 0)) { m.set(k, r); Sync.markEntry(c, k); nw++; }
    }
    Persist.touch(c);
  }
  if (b.stats && b.stats.days) {
    for (const [d, v] of Object.entries(b.stats.days)) {
      const l = S.stats.days[d] || (S.stats.days[d] = {});
      for (const f in v) l[f] = Math.max(l[f] || 0, v[f] || 0);
    }
    Sync.markDirty('stats');
  }
  Persist.touch();
  return { lessons: nl, words: nw };
}

/* ---------- changing a language's matching rules ---------- */
async function rekeyLang(code) {
  await ensureLang(code);
  const lang = L(code);
  if (!lang) return 0;
  const kf = keyFn(lang);
  const m = vmap(code);
  const now = Date.now();
  let moved = 0;
  for (const [k, e] of [...m]) {
    if (e.d) continue;
    const nk = e.p ? k.split(' ').map(kf).filter(Boolean).join(' ') : kf(k);
    if (!nk || nk === k) continue;
    const tgt = m.get(nk);
    if (!tgt || tgt.d || (e.u || 0) > (tgt.u || 0)) { m.set(nk, { ...e, u: now }); Sync.markEntry(code, nk); }
    m.set(k, { d: 1, u: now });
    Sync.markEntry(code, k);
    moved++;
  }
  Persist.touch(code);
  return moved;
}

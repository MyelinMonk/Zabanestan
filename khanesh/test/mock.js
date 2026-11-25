// Stand-in for the claude.ai artifact runtime: db, user, sample, downloads.
(() => {
  if (window.__noClaude) return;
  const KEY = '__mockdb';
  const seed = sessionStorage.getItem('__seed');
  if (seed && !sessionStorage.getItem('__seeded')) { localStorage.setItem(KEY, seed); sessionStorage.setItem('__seeded', '1'); }
  const store = JSON.parse(localStorage.getItem(KEY) || '{}');
  const save = () => localStorage.setItem(KEY, JSON.stringify(store));
  const delay = () => new Promise(r => setTimeout(r, 5));
  const segs = p => p.split('/');
  const clone = x => JSON.parse(JSON.stringify(x));
  function deepMerge(t, s) {
    for (const k in s) {
      const v = s[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object' && !Array.isArray(t[k])) deepMerge(t[k], v);
      else t[k] = clone(v);
    }
    return t;
  }
  const snap = (path, data) => ({ id: path.split('/').pop(), exists: data !== undefined, data: () => data === undefined ? undefined : clone(data), metadata: { fromCache: false, hasPendingWrites: false } });
  window.__dbStats = { set: 0, update: 0, get: 0, query: 0, del: 0 };
  function doc(path) {
    if (segs(path).length % 2) throw new TypeError('doc path must have an even number of segments: ' + path);
    return {
      id: path.split('/').pop(), path,
      async get() { await delay(); __dbStats.get++; return snap(path, store[path]); },
      async set(d) {
        await delay(); __dbStats.set++;
        const s = JSON.stringify(d);
        if (new TextEncoder().encode(s).length > 262144) throw { code: 'invalid_argument', message: 'document too large' };
        store[path] = JSON.parse(s); save();
      },
      async update(d) {
        await delay(); __dbStats.update++;
        if (!store[path]) throw { code: 'invalid_argument', message: 'document missing' };
        deepMerge(store[path], d);
        save();
      },
      async delete() { await delay(); __dbStats.del++; delete store[path]; save(); },
      collection(p) { return collection(path + '/' + p); },
    };
  }
  function collection(path, filters = [], lim = 1000) {
    if (segs(path).length % 2 === 0) throw new TypeError('collection path must have an odd number of segments: ' + path);
    const q = {
      path,
      where(f, op, v) { return collection(path, [...filters, [f, op, v]], lim); },
      limit(n) { return collection(path, filters, n); },
      orderBy() { return q; },
      doc(id) { return doc(path + '/' + (id || Math.random().toString(36).slice(2))); },
      async get() {
        await delay(); __dbStats.query++;
        const depth = segs(path).length + 1;
        const docs = Object.keys(store).filter(k => k.startsWith(path + '/') && segs(k).length === depth).sort()
          .filter(k => filters.every(([f, op, v]) => { const x = store[k][f]; return op === '==' ? x === v : op === 'in' ? v.includes(x) : true; }))
          .slice(0, lim).map(k => snap(k, store[k]));
        return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
      },
    };
    return q;
  }
  const db = { doc, collection };
  const user = { id: async () => 'u_test', isOwner: async () => true, canEdit: async () => true, can: async () => true };
  const sample = async (input, opts = {}) => {
    await delay();
    window.__samples = (window.__samples || 0) + 1;
    if (opts.images) window.__imgCalls = (window.__imgCalls || []).concat([{ n: opts.images.length, tier: opts.modelTier }]);
    const text = opts.images ? 'نمونهٔ متن اسکن‌شده\nخط دوم از صفحه' : 'Mock translation of the sentence.\nword — gloss';
    if (opts.onText) opts.onText({ text, delta: text });
    return { text, truncated: false, modelTierApplied: 'default' };
  };
  sample.json = async () => { await delay(); return { meaning: 'mock meaning', root: 'mockroot', notes: 'mock note' }; };
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 4, maxInputBytes: 20e6, mediaTypes: ['image/jpeg', 'image/png'] } });
  const downloads = { save: async ({ filename, data }) => {
    let out = data;
    if (data instanceof Blob) {
      const b = new Uint8Array(await data.arrayBuffer());
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      out = '@b64:' + btoa(s);
    }
    window.__dl = { filename, data: typeof out === 'string' ? out : '[binary]' };
    return { status: 'saved' };
  } };
  const caps = { db, user, sample, downloads };
  window.claude = { use: async name => { await new Promise(r => setTimeout(r, 30)); return caps[name] || null; } };
})();

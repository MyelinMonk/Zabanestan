// A stand-in for supabase-js in tests: the calls src/accounts.js makes, with the database's rules
// (supabase/schema.sql) followed closely enough to test the reader against. The data lives in the
// test process (window.__mockLoad / __mockSave), so several browser profiles share it.
// Signing in "with Google" comes back with ?code=mock-<user>, the user set in localStorage 'mock-user'.
(() => {
  const err = message => ({ data: null, error: { message } });
  const load = async () => JSON.parse(await window.__mockLoad());
  const save = db => window.__mockSave(JSON.stringify(db));
  const uuid = () => crypto.randomUUID();
  const stamp = () => new Date().toISOString();

  function createClient(url, key, opts) {
    const storeKey = (opts && opts.auth && opts.auth.storageKey) || 'sb-auth';
    let session = null;
    const listeners = [];
    const emit = (ev) => listeners.forEach(cb => cb(ev, session));
    const me = () => (session ? session.user.id : null);

    async function init() {
      const code = new URLSearchParams(location.search).get('code');
      if (code && code.startsWith('mock-')) {
        const id = code.slice(5);
        const db = await load();
        if (!db.users[id]) {
          db.users[id] = { id, email: id.toLowerCase() + '@example.com' };
          db.profiles[id] = { id, display_name: '', is_moderator: false };
          await save(db);
        }
        session = { user: { id, email: db.users[id].email } };
        localStorage.setItem(storeKey, JSON.stringify(session));
        setTimeout(() => emit('SIGNED_IN'), 0);
      } else {
        try { session = JSON.parse(localStorage.getItem(storeKey)); } catch { session = null; }
        if (session) { const db = await load(); if (!db.users[session.user.id]) { session = null; localStorage.removeItem(storeKey); } }
      }
    }
    const ready = init();

    const team = db => !!(me() && db.profiles[me()] && db.profiles[me()].is_moderator);
    const canSee = (db, r) => r.owner === me() || (r.visibility === 'public' && r.review === 'approved') || (r.visibility !== 'private' && team(db));
    const fileShared = (db, path) => db.resources.some(r => r.file_path === path && r.visibility !== 'private');
    function check(r) {
      if (!r.title || r.title.length > 200) return 'title';
      if (!/^([a-z]{2,3}(-[a-z0-9]{1,8})*|x-[a-z0-9-]{1,30})$/.test(r.lang)) return 'lang';
      if (r.kind === 'text' && !(r.content && typeof r.content.text === 'string')) return 'violates check constraint "content_fits_kind"';
      if (r.kind === 'wordlist' && !(r.content && Array.isArray(r.content.words))) return 'violates check constraint "content_fits_kind"';
      if (r.kind === 'ocr_model' && !r.file_path) return 'violates check constraint "content_fits_kind"';
      if (r.visibility !== 'private' && !(r.license && r.rights_confirmed)) return 'violates check constraint "shared_needs_rights"';
      return null;
    }
    function guard(db, row, old) { // resources_guard
      const t = team(db);
      if (row.visibility === 'public') {
        const changed = !old || old.visibility !== 'public' || ['title', 'description', 'source', 'license', 'lang', 'file_path'].some(k => row[k] !== old[k]) || JSON.stringify(row.content) !== JSON.stringify(old.content);
        if (changed) { row.review = t ? 'approved' : 'pending'; row.review_note = ''; } else { row.review = old.review; row.review_note = old.review_note; }
      } else { row.review = 'none'; row.review_note = ''; }
      row.updated_at = stamp();
    }

    class Query {
      constructor(table) { Object.assign(this, { table, op: 'select', cols: '*', filters: [], ord: null, lim: null, one: null, values: null, returning: false }); }
      select(cols) { if (this.op === 'select') this.cols = cols || '*'; else this.returning = true; return this; }
      insert(v) { this.op = 'insert'; this.values = v; return this; }
      update(v) { this.op = 'update'; this.values = v; return this; }
      delete() { this.op = 'delete'; return this; }
      eq(c, v) { this.filters.push(r => r[c] === v); return this; }
      not(c, op, v) { this.filters.push(r => !(op === 'is' && v === null ? r[c] == null : r[c] === v)); return this; }
      order(c, o) { this.ord = [c, !o || o.ascending !== false]; return this; }
      limit(n) { this.lim = n; return this; }
      single() { this.one = 'single'; return this; }
      maybeSingle() { this.one = 'maybe'; return this; }
      then(res, rej) { return this.run().then(res, rej); }
      async run() {
        await ready;
        const db = await load();
        let out;
        if (this.table === 'profiles') {
          const mine = Object.values(db.profiles).filter(p => p.id === me());
          if (this.op === 'select') out = mine.filter(r => this.filters.every(f => f(r)));
          else if (this.op === 'update') {
            if (Object.keys(this.values).some(k => k !== 'display_name')) return err('permission denied for table profiles');
            out = mine.filter(r => this.filters.every(f => f(r)));
            out.forEach(p => { p.display_name = String(this.values.display_name).slice(0, 60); });
            await save(db);
          } else return err('permission denied for table profiles');
        } else if (this.table === 'resources') {
          if (this.op === 'insert') {
            if (!me()) return err('new row violates row-level security policy for table "resources"');
            const row = { id: uuid(), owner: me(), lang_name: '', description: '', source: '', license: '', rights_confirmed: false, visibility: 'private', review_note: '', content: null, word_count: 0, file_path: null, file_name: null, file_size: null, created_at: stamp(), ...this.values };
            row.owner = me();
            const bad = check(row);
            if (bad) return err(bad);
            guard(db, row, null);
            db.resources.push(row);
            await save(db);
            out = [row];
          } else {
            const visible = db.resources.filter(r => canSee(db, r) && this.filters.every(f => f(r)));
            if (this.op === 'select') out = visible;
            else if (this.op === 'update') {
              out = [];
              for (const r of visible) {
                if (r.owner === me()) {
                  const next = { ...r, ...this.values, owner: r.owner, kind: r.kind };
                  const bad = check(next);
                  if (bad) return err(bad);
                  guard(db, next, r);
                  Object.assign(r, next);
                  out.push(r);
                } else if (team(db) && r.visibility !== 'private') {
                  if (!['approved', 'rejected'].includes(this.values.review)) return err('A review approves or rejects.');
                  r.review = this.values.review; r.review_note = this.values.review_note || ''; r.updated_at = stamp();
                  out.push(r);
                }
              }
              await save(db);
            } else if (this.op === 'delete') {
              out = visible.filter(r => r.owner === me() || (team(db) && r.visibility !== 'private'));
              db.resources = db.resources.filter(r => !out.includes(r));
              await save(db);
            }
          }
        } else return err('relation "' + this.table + '" does not exist');
        out = out.map(r => ({ ...r }));
        if (this.ord) { const [c, asc] = this.ord; out.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1)); }
        if (this.lim != null) out = out.slice(0, this.lim);
        if (this.op !== 'select' && !this.returning && !this.one) return { data: null, error: null };
        if (this.one === 'single') return out.length === 1 ? { data: out[0], error: null } : err('JSON object requested, multiple (or no) rows returned');
        if (this.one === 'maybe') return { data: out[0] || null, error: null };
        return { data: out, error: null };
      }
    }

    const files = {
      from(bucket) {
        return {
          async upload(path, file) {
            await ready;
            if (!me() || path.split('/')[0] !== me()) return err('new row violates row-level security policy');
            const db = await load();
            if (db.files[path]) return err('The resource already exists');
            const buf = new Uint8Array(await file.arrayBuffer());
            let s = ''; for (const b of buf) s += String.fromCharCode(b);
            db.files[path] = btoa(s);
            await save(db);
            return { data: { path }, error: null };
          },
          async download(path) {
            await ready;
            const db = await load();
            if (!db.files[path] || !(path.split('/')[0] === me() || fileShared(db, path))) return err('Object not found');
            const bin = atob(db.files[path]);
            return { data: new Blob([Uint8Array.from(bin, ch => ch.charCodeAt(0))]), error: null };
          },
          async remove(paths) {
            await ready;
            const db = await load();
            for (const p of paths) if (p.split('/')[0] === me() || (team(db) && fileShared(db, p))) delete db.files[p];
            await save(db);
            return { data: [], error: null };
          },
        };
      },
    };

    return {
      auth: {
        async getSession() { await ready; return { data: { session }, error: null }; },
        onAuthStateChange(cb) { listeners.push(cb); ready.then(() => cb('INITIAL_SESSION', session)); return { data: { subscription: { unsubscribe() {} } } }; },
        async signInWithOAuth({ provider, options }) {
          if (provider !== 'google') return err('Unsupported provider');
          location.href = options.redirectTo + '?code=mock-' + (localStorage.getItem('mock-user') || 'A');
          return { data: {}, error: null };
        },
        async signOut() { session = null; localStorage.removeItem(storeKey); emit('SIGNED_OUT'); return { error: null }; },
      },
      from: t => new Query(t),
      storage: files,
      async rpc(name, args) {
        await ready;
        const db = await load();
        if (name === 'get_resource') return { data: db.resources.filter(r => r.id === args.rid && (r.visibility !== 'private' || r.owner === me())).map(r => ({ ...r })), error: null };
        if (name === 'display_names') return { data: (args.ids || []).filter(id => db.profiles[id]).map(id => ({ id, display_name: db.profiles[id].display_name })), error: null };
        if (name === 'delete_my_account') {
          if (!me()) return err('Not signed in.');
          db.resources = db.resources.filter(r => r.owner !== me());
          delete db.profiles[me()]; delete db.users[me()];
          await save(db);
          return { data: null, error: null };
        }
        return err('function ' + name + ' does not exist');
      },
    };
  }
  window.supabase = { createClient };
})();

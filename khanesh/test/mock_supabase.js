// A stand-in for supabase-js in tests: the calls src/accounts.js makes, with the database's rules
// (supabase/schema.sql) followed closely enough to test the reader against. The data lives in the
// test process (window.__mockLoad / __mockSave), so several browser profiles share it.
// Signing in "with Google" comes back with ?code=mock-<user>, the user set in localStorage 'mock-user'.
(() => {
  const err = message => ({ data: null, error: { message } });
  const load = async () => JSON.parse(await window.__mockLoad());
  // one call at a time, as a real database would keep them apart: each call reads and saves the whole store
  let chain = Promise.resolve();
  const serial = fn => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };
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
        const was = session;
        if (was) { const db = await load(); if (!db.users[was.user.id] && session === was) { session = null; localStorage.removeItem(storeKey); } }
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

    // the forum: schema.sql's forum section
    function forum(db, Q) {
      db.forum_threads = db.forum_threads || []; db.forum_posts = db.forum_posts || []; db.forum_reports = db.forum_reports || [];
      const t = team(db), u = me();
      const thread = id => db.forum_threads.find(x => x.id === id);
      const match = r => Q.filters.every(f => f(r));
      const no = m => ({ error: { message: m } });
      if (Q.table === 'forum_boards') return Q.op === 'select' ? { rows: db.forum_boards.filter(match) } : no('permission denied for table forum_boards');
      if (Q.table === 'forum_threads') {
        const seen = db.forum_threads.filter(x => !x.hidden || x.author === u || t);
        if (Q.op === 'select') return { rows: seen.filter(match) };
        if (!t) return { rows: [] };
        const hit = seen.filter(match);
        if (Q.op === 'update') { for (const x of hit) for (const k of ['pinned', 'locked', 'hidden']) if (k in Q.values) x[k] = Q.values[k]; return { rows: hit, changed: true }; }
        if (Q.op === 'delete') { const ids = hit.map(x => x.id); db.forum_threads = db.forum_threads.filter(x => !ids.includes(x.id)); db.forum_posts = db.forum_posts.filter(p => !ids.includes(p.thread)); return { rows: hit, changed: true }; }
        return no('permission denied for table forum_threads');
      }
      if (Q.table === 'forum_posts') {
        const seen = db.forum_posts.filter(p => { const x = thread(p.thread); return x && (!x.hidden || t) && (!p.hidden || p.author === u || t); });
        if (Q.op === 'select') return { rows: seen.filter(match) };
        if (!u) return no('new row violates row-level security policy for table "forum_posts"');
        if (Q.op === 'insert') {
          const x = thread(Q.values.thread);
          if (!x || x.hidden || (x.locked && !t)) return no('new row violates row-level security policy for table "forum_posts"');
          if (!String(Q.values.body || '').trim()) return no('violates check constraint "forum_posts_body_check"');
          const row = { id: uuid(), thread: x.id, author: u, body: Q.values.body, hidden: false, created_at: stamp(), edited_at: null };
          db.forum_posts.push(row); x.post_count++; x.last_post_at = row.created_at;
          const b = db.forum_boards.find(b => b.id === x.board); if (b) b.last_post_at = row.created_at;
          return { rows: [row], changed: true };
        }
        const hit = seen.filter(match).filter(p => p.author === u || t);
        if (Q.op === 'update') {
          for (const p of hit) {
            if (p.author === u) { if ('body' in Q.values && Q.values.body !== p.body) { p.body = Q.values.body; p.edited_at = stamp(); } if (t && 'hidden' in Q.values) p.hidden = Q.values.hidden; }
            else if ('hidden' in Q.values) p.hidden = Q.values.hidden;
          }
          return { rows: hit, changed: true };
        }
        if (Q.op === 'delete') { const ids = hit.map(p => p.id); db.forum_posts = db.forum_posts.filter(p => !ids.includes(p.id)); hit.forEach(p => { const x = thread(p.thread); if (x) x.post_count--; }); return { rows: hit, changed: true }; }
      }
      if (Q.table === 'forum_reports') {
        if (Q.op === 'insert') {
          if (!u) return no('new row violates row-level security policy');
          if (db.forum_reports.some(r => r.post === Q.values.post && r.reporter === u)) return no('duplicate key value violates unique constraint "forum_reports_post_reporter_key"');
          const row = { id: uuid(), post: Q.values.post, reporter: u, reason: Q.values.reason || '', resolved: false, created_at: stamp() };
          db.forum_reports.push(row); return { rows: [row], changed: true };
        }
        if (!t) return { rows: [] };
        const hit = db.forum_reports.filter(match);
        if (Q.op === 'update') { hit.forEach(r => { if ('resolved' in Q.values) r.resolved = Q.values.resolved; }); return { rows: hit, changed: true }; }
        return { rows: hit };
      }
      return no('unknown table');
    }

    class Query {
      constructor(table) { Object.assign(this, { table, op: 'select', cols: '*', filters: [], ord: [], lim: null, one: null, values: null, returning: false }); }
      select(cols) { if (this.op === 'select') this.cols = cols || '*'; else this.returning = true; return this; }
      insert(v) { this.op = 'insert'; this.values = v; return this; }
      update(v) { this.op = 'update'; this.values = v; return this; }
      upsert(v) { this.op = 'upsert'; this.values = v; return this; }
      delete() { this.op = 'delete'; return this; }
      eq(c, v) { this.filters.push(r => r[c] === v); return this; }
      not(c, op, v) { this.filters.push(r => !(op === 'is' && v === null ? r[c] == null : r[c] === v)); return this; }
      order(c, o) { this.ord.push([c, !o || o.ascending !== false]); return this; }
      in(c, vals) { this.filters.push(r => vals.includes(r[c])); return this; }
      limit(n) { this.lim = n; return this; }
      single() { this.one = 'single'; return this; }
      maybeSingle() { this.one = 'maybe'; return this; }
      then(res, rej) { return serial(() => this.run()).then(res, rej); }
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
        } else if (this.table === 'glosses') { // shared meanings: yours to change; everyone reads the visible ones
          db.glosses = db.glosses || [];
          if (this.op === 'upsert') {
            const v = this.values;
            if (!me() || v.author !== me()) return err('new row violates row-level security policy for table "glosses"');
            if (!String(v.meaning || '').trim()) return err('new row for relation "glosses" violates check constraint "glosses_meaning_check"');
            const old = db.glosses.find(g => g.author === me() && g.lang === v.lang && g.word_key === v.word_key);
            if (old) Object.assign(old, { meaning: v.meaning.trim(), dialect: v.dialect || '', persian: v.persian || '', source: v.source || '', word: v.word });
            else db.glosses.push({ id: (db.glossSeq = (db.glossSeq || 0) + 1), author: me(), lang: v.lang, word_key: v.word_key, word: v.word,
              meaning: v.meaning.trim(), dialect: v.dialect || '', persian: v.persian || '', source: v.source || '', hidden: false, created_at: stamp() });
            await save(db); out = [];
          } else if (this.op === 'delete') {
            const hit = db.glosses.filter(g => g.author === me() && this.filters.every(f => f(g)));
            db.glosses = db.glosses.filter(g => !hit.includes(g));
            await save(db); out = hit;
          } else if (this.op === 'select') {
            out = db.glosses.filter(g => (!g.hidden || g.author === me()) && this.filters.every(f => f(g)));
          } else return err('permission denied');
        } else if (this.table === 'gloss_reports') {
          if (!me()) return err('permission denied');
          db.gloss_reports = db.gloss_reports || [];
          for (const v of [].concat(this.values || [])) {
            if (!db.gloss_reports.some(r => r.gloss === v.gloss && r.reporter === me())) db.gloss_reports.push({ gloss: v.gloss, reporter: me(), reason: v.reason || '' });
          }
          await save(db); out = [];
        } else if (this.table === 'gloss_votes') { // your own votes only
          if (!me()) return err('permission denied');
          db.gloss_votes = db.gloss_votes || [];
          if (this.op === 'upsert') {
            const v = this.values;
            if (v.voter !== me()) return err('new row violates row-level security policy for table "gloss_votes"');
            const mk = String(v.meaning_key).trim().toLowerCase();
            const old = db.gloss_votes.find(x => x.voter === me() && x.lang === v.lang && x.word_key === v.word_key && x.meaning_key === mk);
            if (old) old.vote = v.vote; else db.gloss_votes.push({ voter: me(), lang: v.lang, word_key: v.word_key, meaning_key: mk, vote: v.vote });
            out = [];
          } else {
            const hit = db.gloss_votes.filter(x => x.voter === me() && this.filters.every(f => f(x)));
            if (this.op === 'delete') db.gloss_votes = db.gloss_votes.filter(x => !hit.includes(x));
            out = hit;
          }
          await save(db);
        } else if (this.table === 'reader_docs') { // the owner-only policies and the 50 MB quota
          db.reader_docs = db.reader_docs || {};
          window.__readerCalls = (window.__readerCalls || 0) + 1;
          const mine = Object.values(db.reader_docs).filter(r => r.owner === me());
          if (this.op === 'upsert') {
            if (!me() || this.values.owner !== me()) return err('new row violates row-level security policy for table "reader_docs"');
            const data = this.values.data;
            const size = r => JSON.stringify(r.data).length;
            const others = mine.filter(r => r.id !== this.values.id);
            const used = others.reduce((n, r) => n + size(r), 0);
            const usedTexts = others.filter(r => r.data.t === 'lt').reduce((n, r) => n + size(r), 0);
            const full = { data: null, error: { message: 'Your reader storage is full.', hint: 'quota_exceeded' } };
            if (data.t === 'lt' && usedTexts + JSON.stringify(data).length > (window.__readerTextQuota || 47185920)) return full;
            if (used + JSON.stringify(data).length > (window.__readerQuota || 52428800)) return full;
            db.reader_docs[me() + '/' + this.values.id] = { owner: me(), id: this.values.id, t: data.t || null, vl: data.vl || null, data: JSON.parse(JSON.stringify(data)), updated_at: stamp() };
            await save(db);
            out = [];
          } else {
            const hit = mine.filter(r => this.filters.every(f => f(r)));
            if (this.op === 'select') out = hit;
            else if (this.op === 'delete') { hit.forEach(r => delete db.reader_docs[r.owner + '/' + r.id]); await save(db); out = hit; }
            else return err('permission denied');
          }
        } else if (this.table.startsWith('forum_')) {
          const r = forum(db, this);
          if (r.error) return r;
          out = r.rows;
          if (r.changed) await save(db);
        } else return err('relation "' + this.table + '" does not exist');
        out = out.map(r => ({ ...r }));
        if (this.ord.length) out.sort((a, b) => { for (const [c, asc] of this.ord) { const d = (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1); if (d) return d; } return 0; });
        if (this.lim != null) out = out.slice(0, this.lim);
        if (this.op !== 'select' && !this.returning && !this.one) return { data: null, error: null };
        if (this.one === 'single') return out.length === 1 ? { data: out[0], error: null } : err('JSON object requested, multiple (or no) rows returned');
        if (this.one === 'maybe') return { data: out[0] || null, error: null };
        return { data: out, error: null };
      }
    }

    const files = {
      from(bucket) {
        if (bucket === 'recordings') return recordings;
        if (bucket === 'avatars') return avatars;
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

    // forum pictures: public to read; your own folder to add to; the team may remove any
    const avatars = {
      getPublicUrl(path) { return { data: { publicUrl: 'https://mock.supabase.co/storage/v1/object/public/avatars/' + path } }; },
      async upload(path, file, opts) {
        await ready;
        if (!me() || path.split('/')[0] !== me()) return err('new row violates row-level security policy');
        const type = (opts && opts.contentType) || file.type;
        if (!['image/webp', 'image/jpeg', 'image/png'].includes(type)) return err(`mime type ${type} is not supported`);
        if (file.size > 204800) return err('The object exceeded the maximum allowed size');
        const db = await load();
        db.avatar_files = db.avatar_files || {};
        if (db.avatar_files[path]) return err('The resource already exists');
        const buf = new Uint8Array(await file.arrayBuffer());
        let s = ''; for (const b of buf) s += String.fromCharCode(b);
        db.avatar_files[path] = { type, b64: btoa(s), size: file.size };
        await save(db);
        return { data: { path }, error: null };
      },
      async remove(paths) {
        await ready;
        const db = await load();
        for (const p of paths) if (p.split('/')[0] === me() || team(db)) delete (db.avatar_files || {})[p];
        await save(db);
        return { data: [], error: null };
      },
    };

    // the consent form's bucket: anyone may add up to 10 files to a speaker's folder on the day the form was sent
    const recordings = {
      async upload(path, file, opts) {
        await ready;
        if (window.__consentDown) return err('Failed to fetch');
        const db = await load();
        const folder = path.split('/')[0];
        const c = (db.speaker_consents || []).find(x => x.speaker_id === folder);
        const inFolder = Object.keys(db.files).filter(k => k.startsWith(folder + '/')).length;
        if (!/^ZB-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(path) || !c || c.withdrawn_at
            || Date.now() - Date.parse(c.created_at) > 86400000 || inFolder >= 10) return err('new row violates row-level security policy');
        const type = (opts && opts.contentType) || file.type;
        if (!/^(audio|video)\//.test(type)) return err(`mime type ${type} is not supported`);
        if (file.size > 52428800) return err('The object exceeded the maximum allowed size');
        if (db.files[path]) return err('The resource already exists');
        const buf = new Uint8Array(await file.arrayBuffer());
        let s = ''; for (const b of buf) s += String.fromCharCode(b);
        db.files[path] = btoa(s);
        db.file_meta = db.file_meta || {};
        db.file_meta[path] = { size: file.size, mimetype: type };
        await save(db);
        return { data: { path }, error: null };
      },
    };
    const EMAIL_RE = /^([^@\s]+@[^@\s]+\.[^@\s]+)?$/;
    function consentProblem(a) {  // the checks in submit_consent and the speaker_consents table
      if (!(a.understood === true && a.agreed === true)) return 'Please tick both boxes at the end of the form.';
      if (!EMAIL_RE.test(a.email || '')) return "That email address doesn't look right.";
      if (!EMAIL_RE.test(a.guardian_email || '')) return "The parent's or guardian's email address doesn't look right.";
      if (!['anonymous', 'nickname', 'full_name'].includes(a.credit) || !['public', 'restricted', 'private'].includes(a.access)
          || !['13-17', '18-29', '30-44', '45-59', '60-74', '75+'].includes(a.age_range) || !['face', 'no_face', 'audio_only', 'no_video'].includes(a.video)
          || !(a.language || '').trim() || !(a.uses || []).every(u => ['lessons', 'dictionaries', 'archive', 'wikimedia', 'other'].includes(u)))
        return 'Some answers are missing or don’t fit together. Please check the form and try again.';
      if (a.credit !== 'anonymous' && !(a.credit_name || '').trim()) return 'Add the nickname or name you’d like to be credited by.';
      if ((a.uses || []).includes('other') && !(a.uses_other || '').trim()) return 'Say what else we may use your recording for.';
      if (a.access !== 'public' && (a.uses || []).some(u => ['lessons', 'dictionaries', 'wikimedia'].includes(u))) return 'Lessons, dictionaries and Wikimedia clips are open to everyone, so they need Public access.';
      if (a.age_range === '13-17' && !(a.guardian_name && a.guardian_email && a.guardian_agreed)) return 'For a speaker aged 13 to 17, a parent or guardian needs to give their name and email, and agree.';
      if (a.recontact && !a.email) return 'Add your email, so we can contact you again.';
      return '';
    }

    return {
      auth: {
        async getSession() { await ready; return { data: { session }, error: null }; },
        onAuthStateChange(cb) { listeners.push(cb); ready.then(() => cb('INITIAL_SESSION', session)); return { data: { subscription: { unsubscribe() {} } } }; },
        async signInWithOAuth({ provider, options }) {
          if (provider !== 'google') return err('Unsupported provider');
          localStorage.setItem('mock-last-oauth', JSON.stringify(options));
          location.href = options.redirectTo + '?code=mock-' + (localStorage.getItem('mock-user') || 'A');
          return { data: {}, error: null };
        },
        async signInWithIdToken({ provider, token, nonce }) {
          await ready;
          const [tag, id, hashed] = String(token).split('.');
          if (provider !== 'google' || tag !== 'mock-id' || !id) return err('Bad ID token');
          const sum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce || '')))].map(b => b.toString(16).padStart(2, '0')).join('');
          if (sum !== hashed) return err('Nonces mismatch');
          const db = await load();
          if (!db.users[id]) {
            db.users[id] = { id, email: id.toLowerCase() + '@example.com' };
            db.profiles[id] = { id, display_name: '', is_moderator: false };
            await save(db);
          }
          session = { user: { id, email: db.users[id].email } };
          localStorage.setItem(storeKey, JSON.stringify(session));
          localStorage.setItem('mock-last-idtoken', 'yes');
          emit('SIGNED_IN');
          return { data: { session, user: session.user }, error: null };
        },
        async signOut() { session = null; localStorage.removeItem(storeKey); emit('SIGNED_OUT'); return { error: null }; },
      },
      from: t => new Query(t),
      storage: files,
      rpc(name, args) { return serial(() => this.rpc1(name, args)); },
      async rpc1(name, args) {
        await ready;
        const db = await load();
        if (name === 'get_resource') return { data: db.resources.filter(r => r.id === args.rid && (r.visibility !== 'private' || r.owner === me())).map(r => ({ ...r })), error: null };
        if (name === 'forum_people') return { data: (args.ids || []).filter(id => db.profiles[id]).map(id => { const p = db.profiles[id];
          return { id, display_name: p.display_name || '', badge: p.is_owner ? 'owner' : p.is_moderator ? 'moderator' : null, avatar: p.avatar || null }; }), error: null };
        if (name === 'forum_set_avatar') {
          if (!me()) return err('Sign in first.');
          if (args.path != null && args.path.split('/')[0] !== me()) return err('That picture isn’t yours.');
          db.profiles[me()].avatar = args.path || null; await save(db); return { data: null, error: null };
        }
        if (name === 'forum_clear_avatar') {
          if (!team(db)) return err('Only the team can remove someone’s picture.');
          if (db.profiles[args.member]) db.profiles[args.member].avatar = null; await save(db); return { data: null, error: null };
        }
        if (name === 'forum_badges') return { data: (args.ids || []).filter(id => db.profiles[id] && (db.profiles[id].is_owner || db.profiles[id].is_moderator)).map(id => ({ id, badge: db.profiles[id].is_owner ? 'owner' : 'moderator' })), error: null };
        if (name === 'display_names') return { data: (args.ids || []).filter(id => db.profiles[id]).map(id => ({ id, display_name: db.profiles[id].display_name })), error: null };
        if (name === 'forum_new_thread') {
          if (!me()) return err('Sign in to start a thread.');
          db.forum_threads = db.forum_threads || []; db.forum_posts = db.forum_posts || [];
          const id = uuid(), now = stamp();
          db.forum_threads.push({ id, board: args.board_id, author: me(), title: args.title, pinned: false, locked: false, hidden: false, post_count: 1, created_at: now, last_post_at: now });
          db.forum_posts.push({ id: uuid(), thread: id, author: me(), body: args.body, hidden: false, created_at: now, edited_at: null });
          const b = db.forum_boards.find(b => b.id === args.board_id); b.thread_count++; b.last_post_at = now;
          await save(db);
          return { data: id, error: null };
        }
        if (name === 'forum_rename_thread' || name === 'forum_delete_thread') {
          const t = (db.forum_threads || []).find(x => x.id === args.thread_id);
          const mod = !!(me() && db.profiles[me()] && db.profiles[me()].is_moderator);
          if (!me() || !t) return err('This thread isn’t here.');
          if (t.author !== me() && !mod) return err('Only whoever started this thread, or the team, can change it.');
          if (name === 'forum_rename_thread') {
            if (String(args.new_title || '').trim().length < 3) return err('Give the thread a title.');
            t.title = args.new_title.trim();
          } else {
            if (!mod && db.forum_posts.some(x => x.thread === t.id && x.author !== me())) return err('Others have replied, so the thread stays. Delete your own posts, or ask the team.');
            db.forum_threads = db.forum_threads.filter(x => x !== t);
            db.forum_posts = db.forum_posts.filter(x => x.thread !== t.id);
            const b = db.forum_boards.find(b => b.id === t.board); b.thread_count = Math.max(0, b.thread_count - 1);
          }
          await save(db);
          return { data: null, error: null };
        }
        if (name === 'gloss_suggestions') {
          window.__glossCalls = (window.__glossCalls || 0) + 1;
          const groups = new Map();
          for (const g of (db.glosses || [])) {
            if (g.hidden || g.lang !== args.p_lang || !args.p_keys.includes(g.word_key)) continue;
            const id = g.word_key + '\n' + g.meaning.toLowerCase();
            const x = groups.get(id) || { word_key: g.word_key, meaning: g.meaning, people: 0, ups: 0, downs: 0, my_vote: 0, dialects: [], persian: [], sources: [], ids: [], authors: [], mine: false, first: g.id };
            x.people++; x.ids.push(g.id); x.authors.push(g.author); x.mine = x.mine || g.author === me();
            for (const [f, a] of [['dialect', 'dialects'], ['persian', 'persian'], ['source', 'sources']]) if (g[f] && !x[a].includes(g[f])) x[a].push(g[f]);
            groups.set(id, x);
          }
          for (const v of (db.gloss_votes || [])) {
            const x = groups.get(v.word_key + '\n' + v.meaning_key);
            if (!x || v.lang !== args.p_lang || x.authors.includes(v.voter)) continue;
            if (v.vote === 1) x.ups++; else x.downs++;
            if (v.voter === me()) x.my_vote = v.vote;
          }
          const score = x => x.people + x.ups - x.downs;
          const data = [...groups.values()].sort((a, b) => a.word_key.localeCompare(b.word_key) || score(b) - score(a) || b.people - a.people || a.first - b.first).map(({ first, authors, ...r }) => r);
          return { data, error: null };
        }
        if (name === 'reader_usage') {
          if (!me()) return err('permission denied for function reader_usage');
          const mine = Object.values(db.reader_docs || {}).filter(r => r.owner === me());
          const size = r => JSON.stringify(r.data).length;
          const texts = mine.filter(r => r.data.t === 'lt');
          const by = {};
          for (const r of texts) { const l = r.id.split('.')[1]; by[l] = (by[l] || 0) + size(r); }
          const largest = Object.entries(by).map(([lesson, bytes]) => ({ lesson, bytes })).sort((a, b) => b.bytes - a.bytes).slice(0, 5);
          return { data: { used: mine.reduce((n, r) => n + size(r), 0), texts: texts.reduce((n, r) => n + size(r), 0),
            limit: window.__readerQuota || 52428800, text_limit: window.__readerTextQuota || 47185920, largest }, error: null };
        }
        if (name === 'reader_merge') {
          if (!me()) return err('permission denied for function reader_merge');
          const r = (db.reader_docs || {})[me() + '/' + args.doc_id];
          if (!r) return { data: false, error: null };
          for (const [k, v] of Object.entries(args.patch)) {
            r.data[k] = r.data[k] && typeof r.data[k] === 'object' && !Array.isArray(r.data[k]) && v && typeof v === 'object' && !Array.isArray(v) ? { ...r.data[k], ...v } : v;
          }
          await save(db);
          return { data: true, error: null };
        }
        if (name === 'submit_consent') {
          if (window.__consentDown) return err('Failed to fetch');
          const a = args.answers || {};
          const why = consentProblem(a);
          if (why) return err(why);
          const abc = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ', pick = () => abc[Math.floor(Math.random() * 32)];
          const sid = 'ZB-' + Array.from({ length: 4 }, pick).join('') + '-' + Array.from({ length: 4 }, pick).join('');
          db.speaker_consents = db.speaker_consents || [];
          db.speaker_consents.push({ ...a, uses: [...new Set(a.uses || [])].sort(), speaker_id: sid, created_at: stamp(), files: [], withdrawn_at: null });
          await save(db);
          return { data: sid, error: null };
        }
        if (name === 'consent_file_added') {
          const c = (db.speaker_consents || []).find(x => x.speaker_id === args.p_speaker_id && !x.withdrawn_at && Date.now() - Date.parse(x.created_at) < 86400000);
          if (!c) return err('Files can be added here only on the day the form is sent. Please email your recording to us, with your speaker ID.');
          const path = args.p_speaker_id + '/' + args.p_name;
          if (!db.files[path]) return err('That file didn’t arrive. Please try sending it again.');
          if (!c.files.some(f => f.name === args.p_name)) c.files.push({ name: args.p_name, bytes: db.file_meta[path].size, type: db.file_meta[path].mimetype, added_at: stamp() });
          await save(db);
          return { data: null, error: null };
        }
        if (name === 'delete_my_account') {
          if (!me()) return err('Not signed in.');
          const keep = !!(args && args.keep_contributions);
          db.forum_posts = (db.forum_posts || []).map(r => r.author !== me() ? r : keep ? { ...r, author: null } : { ...r, author: null, body: '[Content deleted]', deleted: true });
          db.glosses = (db.glosses || []).flatMap(r => r.author !== me() ? [r] : keep ? [{ ...r, author: null }] : []);
          db.forum_threads = (db.forum_threads || []).map(t => t.author !== me() ? t : { ...t, author: null });
          for (const k of Object.keys(db.reader_docs || {})) if (db.reader_docs[k].owner === me()) delete db.reader_docs[k];
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

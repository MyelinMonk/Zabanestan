/* ---------- accounts: the website copy, when its site has a Supabase project ---------- */
// Signing in is optional. An account keeps texts, word lists and OCR models online, each one private,
// unlisted (anyone with the link) or public (in the shared library once the team approves it).
// Reading progress and flashcards stay in this browser either way. The rules that enforce all this
// live in the database (supabase/schema.sql); this file is only the interface to them.
const ACCT = SITE && SITE.supabase && SITE.supabase.url && SITE.supabase.key ? SITE.supabase : null;
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/dist/umd/supabase.js';
const Acct = { client: null, loading: null, user: null, profile: null, team: false };
const KIND_NAME = { text: 'Text', wordlist: 'Word list', ocr_model: 'OCR model' };
const LICENSES = ['Public domain', 'CC0 1.0', 'CC BY 4.0', 'CC BY-SA 4.0', 'Used with permission'];
const LIST_COLS = 'id,owner,kind,lang,lang_name,title,description,source,license,visibility,review,review_note,word_count,file_name,file_size,updated_at';
const RID = /^r-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MAX_TEXT = 1000000, MAX_WORDS = 20000, MAX_MODEL = 50 * 1048576;

function acctClient() {
  if (!ACCT) return Promise.reject(new Error('Accounts aren’t set up for this copy of the reader.'));
  if (Acct.client) return Promise.resolve(Acct.client);
  if (Acct.loading) return Acct.loading;
  Acct.loading = (async () => {
    if (!(window.supabase && window.supabase.createClient)) {
      for (const url of [SITE.lib + 'supabase/supabase.js', SUPABASE_CDN]) {
        try { await loadScript(url); break; } catch { /* try the next copy */ }
      }
    }
    if (!(window.supabase && window.supabase.createClient)) throw new Error('Couldn’t load the sign-in service. Check your connection and try again.');
    const c = window.supabase.createClient(ACCT.url, ACCT.key, {
      auth: { flowType: 'pkce', storageKey: 'khwanish-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    // the callback mustn't wait on other calls to the client, so it hands over and returns
    c.auth.onAuthStateChange((_event, session) => { setTimeout(() => acctSession(session), 0); });
    const { data } = await c.auth.getSession(); // also finishes a sign-in coming back from Google
    Acct.client = c;
    await acctSession(data.session);
    acctReturn();
    return c;
  })();
  Acct.loading.catch(() => { Acct.loading = null; });
  return Acct.loading;
}
// Back from Google: tidy the address and go where the person was heading.
function acctReturn() {
  if (!/[?&](code|error)=/.test(location.search)) return;
  const err = new URLSearchParams(location.search).get('error_description');
  history.replaceState(null, '', location.pathname + location.hash);
  let after = '';
  try { after = sessionStorage.getItem('khwanish-after') || ''; sessionStorage.removeItem('khwanish-after'); } catch { /* storage off */ }
  if (err) toast('Sign-in didn’t finish: ' + err);
  else if (Acct.user) { toast('Signed in'); if (after) go(after); }
}
async function acctSession(session) {
  const user = (session && session.user) || null;
  const changed = (user && user.id) !== (Acct.user && Acct.user.id);
  Acct.user = user;
  if (!user) { Acct.profile = null; Acct.team = false; }
  else if (changed || !Acct.profile) {
    const { data } = await Acct.client.from('profiles').select('display_name, is_moderator').eq('id', user.id).maybeSingle();
    Acct.profile = data || { display_name: '', is_moderator: false };
    Acct.team = !!Acct.profile.is_moderator;
  }
  if (changed && ['account', 'shared', 'resource', 'options'].includes(UI.route)) route();
}
// Start the service only when it's needed: a saved sign-in, a return from Google, or a shared link.
function acctBoot() {
  if (!ACCT) return;
  let saved = false;
  try { saved = !!localStorage.getItem('khwanish-auth'); } catch { /* storage off */ }
  if (saved || /[?&](code|error)=/.test(location.search)) acctClient().catch(e => toast(acctErr(e)));
}
async function acctSignIn(after) {
  try {
    const c = await acctClient();
    try { sessionStorage.setItem('khwanish-after', after || 'account'); } catch { /* storage off */ }
    const { error } = await c.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
    if (error) throw error;
  } catch (e) { toast(acctErr(e)); }
}
async function acctSignOut() {
  try { await Acct.client.auth.signOut(); } catch { /* signed out here either way */ }
  await acctSession(null);
  toast('Signed out');
  route();
}
function acctErr(e) {
  const m = (e && (e.message || e.error_description || e.msg)) || String(e);
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Couldn’t reach the server. Check your connection and try again.';
  if (/jwt|expired|not authenticated/i.test(m)) return 'Your sign-in has run out. Sign in again.';
  return m;
}
const shareLink = id => location.origin + location.pathname + '#r-' + id;
const langName = (code, fallback) => (L(code) || CATALOG_BY_CODE[code] || {}).name || fallback || code;
function fmtSize(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }
function visText(r) {
  if (r.visibility === 'private') return 'Private';
  if (r.visibility === 'unlisted') return 'Unlisted';
  return { pending: 'Public, waiting for review', rejected: 'Public, not approved' }[r.review] || 'Public';
}
async function copyLink(id) {
  try { await navigator.clipboard.writeText(shareLink(id)); toast('Link copied'); } catch { toast(shareLink(id)); }
}
async function namesFor(ids) {
  const out = {};
  try {
    const { data } = await Acct.client.rpc('display_names', { ids: [...new Set(ids)] });
    for (const p of data || []) out[p.id] = p.display_name;
  } catch { /* names are a nicety */ }
  return out;
}
function resourceRow(r, mine, names) {
  const bits = [KIND_NAME[r.kind], langName(r.lang, r.lang_name)];
  if (r.kind === 'text' && r.word_count) bits.push(`${fmtNum(r.word_count)} words`);
  if (r.kind === 'wordlist') bits.push(`${fmtNum(r.word_count)} words`);
  if (r.kind === 'ocr_model' && r.file_size) bits.push(fmtSize(r.file_size));
  if (mine) bits.push(visText(r));
  else if (names) bits.push(names[r.owner] || 'A Zabanestan member');
  return h('a', { class: 'lesson', href: '#r-' + r.id },
    h('span', { class: 'l-title', dir: 'auto' }, r.title),
    h('span', { class: 'l-meta' }, bits.join(' · ')),
    mine && r.review === 'rejected' && r.review_note ? h('span', { class: 'l-meta warn' }, 'Not approved: ' + r.review_note) : null);
}

/* account page */
function viewAccount() {
  const v = $('#view');
  v.replaceChildren(h('h2', { class: 'sec first' }, 'Your account'));
  if (!ACCT) { v.append(h('p', { class: 'muted' }, 'Accounts aren’t set up for this copy of the reader.')); return; }
  if (!Acct.client) {
    const wait = h('p', { class: 'muted', role: 'status' }, 'Loading…');
    v.append(wait);
    acctClient().then(() => { if (UI.route === 'account') viewAccount(); }, e => { wait.textContent = acctErr(e); });
    return;
  }
  if (!Acct.user) {
    v.append(
      h('p', null, 'An account is optional. With one, you can keep texts, word lists and OCR models online, and share each one privately, by link, or in the shared library.'),
      h('p', { class: 'muted' }, 'Your reading, words and flashcards stay in this browser either way. Your name isn’t shown anywhere unless you choose one.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => acctSignIn('account') }, 'Sign in with Google'),
        h('button', { class: 'btn', type: 'button', onclick: () => go('shared') }, 'Shared library')));
    return;
  }
  const name = h('input', { class: 'input', value: (Acct.profile && Acct.profile.display_name) || '', maxlength: 60, dir: 'auto', placeholder: 'A Zabanestan member' });
  const mine = h('div', { class: 'lessons', id: 'ac-mine' }, h('p', { class: 'muted' }, 'Loading…'));
  const queue = Acct.team ? h('div', { class: 'lessons', id: 'ac-queue' }, h('p', { class: 'muted' }, 'Loading…')) : null;
  v.append(...nodes(
    h('p', { class: 'muted' }, `Signed in with Google as ${Acct.user.email || 'you'}. Only you see this address.`),
    field('ac-name', 'Name shown with what you share', name, 'Leave it blank to appear as “A Zabanestan member”.'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        const display_name = name.value.trim().slice(0, 60);
        const { error } = await Acct.client.from('profiles').update({ display_name }).eq('id', Acct.user.id);
        if (error) { toast(acctErr(error)); return; }
        Acct.profile = { ...Acct.profile, display_name };
        toast(display_name ? 'Name saved' : 'You’ll appear as “A Zabanestan member”');
      } }, 'Save name'),
      h('button', { class: 'btn', type: 'button', onclick: () => go('shared') }, 'Shared library')),
    h('h2', { class: 'sec' }, 'Kept in your account'),
    h('p', { class: 'muted sm' }, 'Share a text from its menu in the Library, a word list from Words, or an OCR model here.'),
    mine,
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => openShare({ kind: 'ocr_model' }) }, 'Share an OCR model')),
    queue ? [h('h2', { class: 'sec' }, 'Waiting for review'), queue] : null,
    h('h2', { class: 'sec' }, 'Signing out'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: acctSignOut }, 'Sign out'),
      h('button', { class: 'btn danger', type: 'button', onclick: acctDelete }, 'Delete my account'))));
  fillList(mine, q => q.eq('owner', Acct.user.id).order('updated_at', { ascending: false }).limit(1000), true,
    'Nothing here yet.');
  if (queue) fillList(queue, q => q.eq('visibility', 'public').eq('review', 'pending').order('updated_at').limit(200), false,
    'Nothing is waiting for review.');
}
async function fillList(box, narrow, mine, empty) {
  try {
    const c = await acctClient();
    const { data, error } = await narrow(c.from('resources').select(LIST_COLS));
    if (error) throw error;
    const names = mine ? null : await namesFor(data.map(r => r.owner));
    if (!box.isConnected) return;
    box.replaceChildren(...(data.length ? data.map(r => resourceRow(r, mine, names)) : [h('p', { class: 'empty' }, empty)]));
  } catch (e) {
    if (box.isConnected) box.replaceChildren(h('p', { class: 'error' }, acctErr(e)));
  }
}
async function acctDelete() {
  if (!await confirmBox('Delete your account', 'This deletes your account and everything kept in it, including links you’ve shared. Your reading and flashcards in this browser stay. It can’t be undone.', 'Delete my account', true)) return;
  try {
    const c = Acct.client;
    const { data: files, error } = await c.from('resources').select('file_path').eq('owner', Acct.user.id).not('file_path', 'is', null);
    if (error) throw error;
    if (files.length) await c.storage.from('ocr-models').remove(files.map(f => f.file_path));
    const { error: e2 } = await c.rpc('delete_my_account');
    if (e2) throw e2;
    try { await c.auth.signOut({ scope: 'local' }); } catch { /* already gone */ }
    await acctSession(null);
    toast('Your account is deleted');
    go('library');
  } catch (e) { toast(acctErr(e)); }
}

/* the shared library */
function viewShared() {
  const v = $('#view');
  const st = UI.shared || (UI.shared = { kind: 'all', lang: S.settings.cur });
  const list = h('div', { class: 'lessons', id: 'sh-list' });
  const load = () => {
    list.replaceChildren(h('p', { class: 'muted', role: 'status' }, 'Loading…'));
    fillList(list, q => {
      q = q.eq('visibility', 'public').eq('review', 'approved');
      if (st.kind !== 'all') q = q.eq('kind', st.kind);
      if (st.lang !== 'all') q = q.eq('lang', st.lang);
      return q.order('updated_at', { ascending: false }).limit(300);
    }, false, st.lang === 'all' ? 'Nothing has been shared yet.' : `Nothing has been shared in ${langName(st.lang)} yet.`);
  };
  const lang = selectEl([['all', 'All languages'], ...S.settings.langs.map(l => [l.code, l.name])], st.lang, x => { st.lang = x; load(); });
  lang.setAttribute('aria-label', 'Language');
  const kind = selectEl([['all', 'Everything'], ['text', 'Texts'], ['wordlist', 'Word lists'], ['ocr_model', 'OCR models']], st.kind, x => { st.kind = x; load(); });
  kind.setAttribute('aria-label', 'Kind');
  v.replaceChildren(
    h('h2', { class: 'sec first' }, 'Shared library'),
    h('p', { class: 'muted' }, 'Texts, word lists and OCR models shared by members and checked by the Zabanestan team.'),
    h('div', { class: 'wfilters' }, lang, kind),
    list,
    h('p', { class: 'muted sm' }, Acct.user ? 'To share your own, use Share in a text’s menu, or in Words.' : ['To share your own, ', h('a', { href: '#account' }, 'sign in'), '.']));
  load();
}

/* one resource, from a link */
async function viewResource(id) {
  const v = $('#view');
  v.replaceChildren(h('p', { class: 'muted', role: 'status' }, 'Loading…'));
  let r;
  try {
    const c = await acctClient();
    const { data, error } = await c.rpc('get_resource', { rid: id });
    if (error) throw error;
    r = data && data[0];
  } catch (e) {
    if (UI.route === 'resource') v.replaceChildren(h('p', { class: 'error' }, acctErr(e)));
    return;
  }
  if (UI.route !== 'resource' || UI.resourceId !== id) return;
  if (!r) {
    v.replaceChildren(...nodes(h('h2', { class: 'r-title' }, 'Nothing here'),
      h('p', null, 'This link doesn’t open anything. It may be private, or it may have been removed.'),
      Acct.user ? null : h('p', { class: 'muted' }, 'If it’s yours, ', h('a', { href: '#account' }, 'sign in'), ' and open it again.')));
    if (!Acct.user) try { sessionStorage.setItem('khwanish-after', 'r-' + id); } catch { /* storage off */ }
    return;
  }
  const mine = !!Acct.user && r.owner === Acct.user.id;
  const names = await namesFor([r.owner]);
  const facts = [[ 'Kind', KIND_NAME[r.kind] ], ['Language', langName(r.lang, r.lang_name)]];
  if (r.kind !== 'ocr_model') facts.push(['Words', fmtNum(r.word_count || 0)]);
  else facts.push(['File', `${r.file_name || 'model'} · ${fmtSize(r.file_size || 0)}`]);
  if (r.source) facts.push(['Source', r.source]);
  if (r.license) facts.push(['License', r.license]);
  facts.push(['Shared by', names[r.owner] || 'A Zabanestan member']);
  if (mine || Acct.team) facts.push(['Visibility', visText(r)]);
  const preview = h('div', { class: 'r-preview' });
  if (r.kind === 'text') preview.append(h('p', { class: 'r-text', dir: 'auto', lang: r.lang }, r.content.text.slice(0, 1200) + (r.content.text.length > 1200 ? '…' : '')));
  if (r.kind === 'wordlist') preview.append(h('div', { class: 'wlist' }, r.content.words.slice(0, 40).map(([w, m]) =>
    h('div', { class: 'wrow' }, h('span', { class: 'wf', dir: 'auto', lang: r.lang }, w), h('span', { class: 'wm', dir: 'auto' }, m || '')))));
  if (r.kind === 'ocr_model') preview.append(h('p', { class: 'muted' }, 'To use it, download the model, then run the helper script described in the ',
    SITE ? h('a', { href: SITE.guide + '#ocr' }, 'reader guide') : 'reader guide', ':'), h('pre', { class: 'r-cmd' }, `python khwanish_tools.py ocr book.pdf --model ${r.file_name || 'MODEL_FILE'}`));
  const use = {
    text: ['Add to my library', () => addSharedText(r)],
    wordlist: ['Add these words', () => addSharedWords(r)],
    ocr_model: ['Download the model', () => downloadModel(r)],
  }[r.kind];
  v.replaceChildren(...nodes(
    h('h2', { class: 'r-title', dir: 'auto' }, r.title),
    r.description ? h('p', { dir: 'auto' }, r.description) : null,
    h('dl', { class: 'facts' }, facts.map(([k, x]) => [h('dt', null, k), h('dd', { dir: 'auto' }, x)])),
    mine && r.review === 'rejected' && r.review_note ? h('p', { class: 'notice' }, 'The team didn’t approve this for the library: ' + r.review_note) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: use[1] }, use[0]),
      r.visibility !== 'private' ? h('button', { class: 'btn', type: 'button', onclick: () => copyLink(r.id) }, 'Copy link') : null,
      mine ? h('button', { class: 'btn', type: 'button', onclick: () => openShare({ existing: r }) }, 'Edit') : null,
      mine ? h('button', { class: 'btn danger', type: 'button', onclick: () => removeResource(r) }, 'Delete') : null),
    Acct.team && !mine && r.visibility === 'public' ? h('section', { class: 'opt' },
      h('h2', { class: 'sec' }, 'Review'),
      h('p', { class: 'muted sm' }, r.review === 'approved' ? 'Approved: it’s in the shared library.' : r.review === 'rejected' ? 'Not approved.' : 'Waiting for review. Check that it’s ours to share: the source, the license, and that nothing in it could put anyone at risk.'),
      h('div', { class: 'actions' },
        r.review !== 'approved' ? h('button', { class: 'btn primary', type: 'button', onclick: () => review(r, 'approved') }, 'Approve') : null,
        r.review !== 'rejected' ? h('button', { class: 'btn', type: 'button', onclick: () => rejectWithNote(r) }, 'Don’t approve') : null,
        h('button', { class: 'btn danger', type: 'button', onclick: () => removeResource(r, true) }, 'Take down'))) : null,
    preview));
}
async function review(r, verdict, note = '') {
  const { error } = await Acct.client.from('resources').update({ review: verdict, review_note: note }).eq('id', r.id);
  if (error) { toast(acctErr(error)); return; }
  toast(verdict === 'approved' ? 'Approved: it’s in the shared library now' : 'Marked as not approved');
  route();
}
function rejectWithNote(r) {
  const note = h('textarea', { class: 'input', rows: 3, maxlength: 1000, placeholder: 'For example: please add the edition and year.' });
  openModal('Don’t approve', [
    field('rv-note', 'A note for the person who shared it', note, 'They see it beside the resource and can fix it and share again.'),
    h('div', { class: 'm-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => { closeModal(); review(r, 'rejected', note.value.trim()); } }, 'Send')),
  ]);
}
async function removeResource(r, takedown) {
  const msg = takedown ? `Take down “${r.title}”? It’s deleted for everyone, including the person who shared it.` : `Delete “${r.title}”? Links to it will stop working. Copies people already added to their reader stay with them.`;
  if (!await confirmBox(takedown ? 'Take down' : 'Delete', msg, takedown ? 'Take down' : 'Delete', true)) return;
  const c = Acct.client;
  const { error } = await c.from('resources').delete().eq('id', r.id);
  if (error) { toast(acctErr(error)); return; }
  if (r.file_path) await c.storage.from('ocr-models').remove([r.file_path]);
  toast(takedown ? 'Taken down' : 'Deleted');
  go(takedown ? 'shared' : 'account');
}

/* using what's shared */
function useLang(code, name) {
  if (!L(code)) addLang(CATALOG_BY_CODE[code] || { code, name: name || code });
}
async function addSharedText(r) {
  useLang(r.lang, r.lang_name);
  const have = [...S.lessons.values()].find(m => !m.del && m.src === 'shared:' + r.id);
  if (have) { toast('It’s already in your library'); openLesson(have.id); return; }
  const m = await createLesson(r.lang, r.title, r.content.text, 'shared:' + r.id);
  toast('Added to your library');
  openLesson(m.id);
}
async function addSharedWords(r) {
  useLang(r.lang, r.lang_name);
  if (S.settings.cur !== r.lang) await switchLang(r.lang);
  openWordImport(r.content.words.map(([w, m]) => m ? `${w}\t${m}` : w).join('\n'), { as: 'learning' });
}
async function downloadModel(r) {
  try {
    toast('Downloading…');
    const { data, error } = await Acct.client.storage.from('ocr-models').download(r.file_path);
    if (error) throw error;
    await BrowserFiles.save({ filename: r.file_name || 'model.safetensors', data });
  } catch (e) { toast(acctErr(e)); }
}

/* sharing: a text, a word list or an OCR model, or editing one already shared */
function openShare(o) {
  if (!Acct.user) {
    openModal('Share', [
      h('p', { class: 'm-text' }, 'Sign in to keep this in your account and choose who can see it. After signing in, open Share again.'),
      h('div', { class: 'm-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => acctSignIn(UI.route === 'resource' ? 'r-' + UI.resourceId : UI.route) }, 'Sign in with Google')),
    ]);
    return;
  }
  const ex = o.existing || null;
  const kind = ex ? ex.kind : o.kind;
  const st = { vis: ex ? ex.visibility : 'private', rights: ex ? true : false };
  const title = h('input', { class: 'input', value: ex ? ex.title : (o.title || ''), maxlength: 200, dir: 'auto' });
  const desc = h('textarea', { class: 'input', rows: 2, maxlength: 2000, dir: 'auto' });
  desc.value = ex ? ex.description : '';
  const source = h('input', { class: 'input', value: ex ? ex.source : '', maxlength: 1000, dir: 'auto',
    placeholder: kind === 'ocr_model' ? 'What it was trained on, and the base model' : 'Author, title, edition and year, or “my own work”' });
  const lic = ex && ex.license && !LICENSES.includes(ex.license) ? ex.license : '';
  const license = selectEl([['', 'Choose a license'], ...LICENSES.map(x => [x, x]), ['other', 'Another license']], ex ? (lic ? 'other' : ex.license) : '');
  const other = h('input', { class: 'input', value: lic, maxlength: 100, placeholder: 'Name of the license' });
  const otherField = field('sh-lic-other', 'License name', other);
  const syncOther = () => { otherField.hidden = license.value !== 'other'; };
  license.addEventListener('change', syncOther);
  syncOther();
  const file = kind === 'ocr_model' && !ex ? h('input', { type: 'file', class: 'input', accept: '.mlmodel,.safetensors,.pt,.ckpt' }) : null;
  const langPick = kind === 'ocr_model' && !ex ? langSelect('sh-lang') : null;
  const rightsRow = checkRow('sh-rights', 'I have the right to share this under the license above', st.rights, x => { st.rights = x; });
  const radios = h('fieldset', { class: 'radios' }, h('legend', null, 'Who can open it'),
    [['private', 'Only me'], ['unlisted', 'Anyone with the link'], ['public', 'Everyone: list it in the shared library after the team checks it']].map(([v, l]) => h('div', { class: 'radio' },
      h('input', { type: 'radio', name: 'sh-vis', id: 'sh-vis-' + v, checked: st.vis === v, onchange: () => { st.vis = v; sync(); } }),
      h('label', { for: 'sh-vis-' + v }, l))));
  const sync = () => { rightsRow.hidden = st.vis === 'private'; };
  sync();
  const err = h('p', { class: 'error', role: 'alert' });
  const go_ = h('button', { class: 'btn primary', type: 'button' }, ex ? 'Save' : 'Share');
  go_.onclick = async () => {
    err.textContent = '';
    const licenseName = license.value === 'other' ? other.value.trim() : license.value;
    const t = title.value.trim();
    if (!t) { err.textContent = 'Give it a title.'; return; }
    if (st.vis !== 'private' && !licenseName) { err.textContent = 'Choose a license, so people know how they may use it.'; return; }
    if (st.vis !== 'private' && !st.rights) { err.textContent = 'Confirm that you have the right to share it.'; return; }
    if (st.vis === 'public' && !source.value.trim()) { err.textContent = 'Say where it comes from, so the team can check it.'; return; }
    const row = { title: t, description: desc.value.trim(), source: source.value.trim(), license: licenseName, visibility: st.vis, rights_confirmed: st.vis !== 'private' && st.rights };
    go_.disabled = true;
    try {
      const id = ex ? await updateShared(ex, row) : await createShared(kind, o, row, file, langPick);
      closeModal();
      toast(st.vis === 'public' && !Acct.team ? 'Shared. It joins the library once the team has checked it.' : ex ? 'Saved' : 'Shared');
      go('r-' + id); // redraws even when the link is the one already open (after an edit)
    } catch (e) {
      err.textContent = acctErr(e);
      go_.disabled = false;
    }
  };
  openModal(ex ? 'Edit' : { text: 'Share this text', wordlist: 'Share a word list', ocr_model: 'Share an OCR model' }[kind], [
    file ? field('sh-file', 'Model file', file, 'A kraken model (.mlmodel or .safetensors), up to 50 MB.') : null,
    langPick ? field('sh-lang', 'Language it reads', langPick) : null,
    o.pick || null,
    field('sh-title', 'Title', title),
    field('sh-desc', 'Description (optional)', desc),
    field('sh-source', 'Where it comes from', source),
    field('sh-license', 'License', license),
    otherField,
    radios,
    rightsRow,
    h('p', { class: 'hint' }, 'Share only what you have the right to share. The team removes anything that isn’t.'),
    err,
    h('div', { class: 'm-actions' }, go_),
  ], { wide: true });
}
async function createShared(kind, o, row, file, langPick) {
  const c = Acct.client;
  if (kind === 'ocr_model') {
    const f = file && file.files[0];
    if (!f) throw new Error('Choose the model file.');
    if (f.size > MAX_MODEL) throw new Error('Models up to 50 MB can be shared.');
    const ext = (/\.[a-z0-9]{1,12}$/i.exec(f.name) || ['.model'])[0].toLowerCase();
    const path = `${Acct.user.id}/${crypto.randomUUID()}${ext}`;
    const up = await c.storage.from('ocr-models').upload(path, f, { contentType: 'application/octet-stream', upsert: false });
    if (up.error) throw up.error;
    const code = langPick.value;
    const { data, error } = await c.from('resources').insert({ ...row, kind, lang: code, lang_name: langName(code), file_path: path, file_name: f.name.slice(0, 200), file_size: f.size }).select('id').single();
    if (error) { await c.storage.from('ocr-models').remove([path]); throw error; }
    return data.id;
  }
  const content = await o.content();
  const { data, error } = await c.from('resources').insert({ ...row, kind, lang: o.lang, lang_name: langName(o.lang), content: content.body, word_count: content.count }).select('id').single();
  if (error) throw error;
  return data.id;
}
async function updateShared(ex, row) {
  const { data, error } = await Acct.client.from('resources').update(row).eq('id', ex.id).select('id').single();
  if (error) throw error;
  return data.id;
}
// from a text's menu in the Library
function shareLesson(m) {
  openShare({ kind: 'text', lang: m.lang, title: m.title, content: async () => {
    const text = await getText(m.id);
    if (!text) throw new Error('This text isn’t on this device yet. Open it once, then share it.');
    if (text.length > MAX_TEXT) throw new Error('That text is too long to share: the limit is a million characters.');
    return { body: { text }, count: m.words || countWords(text, L(m.lang)) };
  } });
}
// from Words: the words you're learning, or all with meanings
function shareWords() {
  const code = S.settings.cur;
  const st = { which: 'cards' };
  const pick = h('fieldset', { class: 'radios' }, h('legend', null, 'Which words'),
    [['cards', 'Words with flashcards'], ['learning', 'All the words I’m learning'], ['meanings', 'Every saved word that has a meaning']].map(([v, l]) => h('div', { class: 'radio' },
      h('input', { type: 'radio', name: 'sh-which', id: 'sh-which-' + v, checked: st.which === v, onchange: () => { st.which = v; } }),
      h('label', { for: 'sh-which-' + v }, l))));
  openShare({ kind: 'wordlist', lang: code, title: `${L().name} words`, pick, content: async () => {
    await ensureLang(code);
    const words = [];
    for (const [k, e] of vmap(code)) {
      if (e.d) continue;
      const ok = st.which === 'cards' ? (e.c || e.c2) : st.which === 'learning' ? e.s === 1 : !!e.m;
      if (ok) words.push([e.f || k, e.m || '']);
      if (words.length > MAX_WORDS) throw new Error('That’s too many words to share at once: the limit is 20,000.');
    }
    if (!words.length) throw new Error('There are no words like that to share yet.');
    return { body: { words }, count: words.length };
  } });
}

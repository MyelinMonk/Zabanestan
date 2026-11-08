/* =====================================================================
   Khwānish · interface: shell, library, import, reader, word panel
   ===================================================================== */
const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  next: '<path d="M9 18l6-6-6-6"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  speaker: '<path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13"/>',
  sparkle: '<path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8z"/><path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z"/>',
  library: '<path d="M4 4.5A1.5 1.5 0 015.5 3H20v16H5.5A1.5 1.5 0 004 20.5z"/><path d="M4 20.5A1.5 1.5 0 005.5 22H20"/><path d="M8 7h8"/>',
  cards: '<rect x="3" y="7" width="14" height="13" rx="2"/><path d="M7 3h12a2 2 0 012 2v12"/>',
  words: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  file: '<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6"/><path d="M12 18v-6M9 15l3-3 3 3"/>',
  paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/>',
  camera: '<path d="M22 18a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h3.5l2-3h5l2 3H20a2 2 0 012 2z"/><circle cx="12" cy="13" r="3.5"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  chevdown: '<path d="M6 9l6 6 6-6"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 014-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 01-4 4H4"/>',
};
function icon(name) {
  const s = document.createElement('span');
  s.className = 'ic';
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return s;
}

const UI = {
  route: 'library', reader: null, sheet: null, review: null,
  words: { q: '', st: 'learning', cards: false, sort: 'recent', limit: 200 },
  init() {
    $('#langBtn').addEventListener('click', openLangPicker);
    $('#modalWrap').addEventListener('click', e => { if (e.target.id === 'modalWrap') closeModal(); });
    window.addEventListener('hashchange', route);
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { commitSheet(); Persist.write(); Sync.flush(); }
    });
    window.addEventListener('pagehide', () => { commitSheet(); Persist.write(); });
    if ('speechSynthesis' in window) {
      try { speechSynthesis.getVoices(); speechSynthesis.addEventListener('voiceschanged', () => UI.capsChanged()); } catch { }
    }
    applyReadingPrefs();
  },
  syncStatus() {
    const dot = $('#syncDot');
    if (!dot) return;
    const [cls, label] = syncLabel();
    dot.className = 'sync ' + cls;
    dot.title = label;
    dot.setAttribute('aria-label', label);
    const ol = $('#opt-sync');
    if (ol) ol.textContent = label;
  },
  capsChanged() {
    if (UI.sheet) renderSheet();
    if (UI.route === 'library') viewLibrary();
    if (UI.route === 'options') viewOptions();
  },
  vocabChanged(code) {
    if (UI.route === 'read' && UI.reader && UI.reader.lang.code === code) refreshAllClasses();
    else if (UI.route === 'library' || UI.route === 'words') { if (!document.querySelector('#modalWrap:not([hidden])')) route(); }
    updateBadge();
  },
  refresh() {
    renderTopbar();
    applyReadingPrefs();
    if (UI.route === 'read') { if (UI.reader) refreshAllClasses(); }
    else if (!document.querySelector('#modalWrap:not([hidden])')) route();
    updateBadge();
  },
  notice(msg) { toast(msg); },
};
function syncLabel() {
  if (Cloud.state === 'local') return ['local', 'Saved on this device only'];
  if (Cloud.state === 'init') return ['busy', 'Connecting to your account…'];
  if (Cloud.state === 'offline') return ['warn', 'Can’t reach your account · will retry'];
  if (Sync.running) return ['busy', 'Saving…'];
  if (Sync.lastErr) return ['warn', 'Couldn’t save · retrying'];
  if (Sync.has()) return ['busy', 'Waiting to save…'];
  return ['ok', 'Saved to your account'];
}

/* ---------- toast & dialogs ---------- */
let toastTimer = 0;
function toast(msg, actionLabel, onAction) {
  const t = $('#toast');
  t.replaceChildren(h('span', null, msg));
  if (actionLabel) t.append(h('button', { class: 'btn ghost sm', onclick: () => { t.classList.remove('show'); onAction(); } }, actionLabel));
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), actionLabel ? 7000 : 3200);
}
let modalOnClose = null;
function openModal(title, body, opts = {}) {
  const wrap = $('#modalWrap'), box = $('#modal');
  if (!wrap.hidden && modalOnClose) { const f = modalOnClose; modalOnClose = null; f(); }
  box.className = 'modal' + (opts.wide ? ' wide' : '');
  box.replaceChildren(
    h('div', { class: 'm-head' },
      h('h2', { id: 'm-title' }, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => closeModal() }, icon('close'))),
    ...[].concat(body).filter(Boolean));
  box.setAttribute('aria-labelledby', 'm-title');
  wrap.hidden = false;
  document.body.classList.add('modal-open');
  modalOnClose = opts.onClose || null;
  setTimeout(() => {
    const f = box.querySelector('[autofocus]');
    if (f) f.focus();
  }, 40);
}
function closeModal() {
  const wrap = $('#modalWrap');
  if (wrap.hidden) return;
  wrap.hidden = true;
  document.body.classList.remove('modal-open');
  const f = modalOnClose;
  modalOnClose = null;
  if (f) f();
}
function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return new Promise(res => {
    let done = false;
    const finish = v => { if (done) return; done = true; closeModal(); res(v); };
    openModal(title, [
      h('p', { class: 'm-text' }, text),
      h('div', { class: 'm-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger-fill' : 'primary'), type: 'button', autofocus: true, onclick: () => finish(true) }, okLabel)),
    ], { onClose: () => { if (!done) { done = true; res(false); } } });
  });
}
function field(id, label, control, hint) {
  control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
}
function checkRow(id, label, checked, onchange, hint) {
  const cb = h('input', { type: 'checkbox', id, checked, onchange: e => onchange(e.target.checked) });
  return h('div', { class: 'check' }, cb, h('label', { for: id }, label, hint ? h('span', { class: 'hint' }, hint) : null));
}
function selectEl(options, value, onchange) {
  const s = h('select', { class: 'input', onchange: e => onchange && onchange(e.target.value) },
    options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = value;
  return s;
}

/* ---------- routing ---------- */
const VIEWS = {
  library: () => viewLibrary(), read: () => viewReader(), review: () => viewReview(), words: () => viewWords(), options: () => viewOptions(),
  // accounts, on the website copy when its site has them (accounts.js)
  account: () => viewAccount(), shared: () => viewShared(), resource: () => viewResource(UI.resourceId),
};
function go(r) { if (location.hash.slice(1) === r) route(); else location.hash = r; }
function route() {
  let r = location.hash.slice(1);
  const rid = ACCT && RID.exec(r); // a shared resource's link: #r-<id>
  if (rid) { r = 'resource'; UI.resourceId = rid[1].toLowerCase(); }
  if (!ACCT && ['account', 'shared', 'resource'].includes(r)) r = 'library';
  if (!VIEWS[r] || (r === 'resource' && !rid)) r = 'library';
  if (r === 'read' && !UI.reader) {
    const last = S.meta.lastLesson;
    const m = last && S.lessons.get(last);
    if (m && !m.del) { openLesson(last); return; }
    r = 'library';
  }
  if (UI.route === 'read' && r !== 'read') leaveReader();
  closeSheet();
  UI.route = r;
  document.body.classList.toggle('reading', r === 'read');
  $$('.tabs a').forEach(a => { if (a.dataset.r === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  renderTopbar();
  VIEWS[r]();
  updateBadge();
}
function onKey(e) {
  if (e.defaultPrevented) return;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  const modalOpen = !$('#modalWrap').hidden;
  if (e.key === 'Escape') {
    if (modalOpen) { closeModal(); e.preventDefault(); return; }
    if (UI.sheet) { closeSheet(); e.preventDefault(); return; }
  }
  if (typing || modalOpen || e.metaKey || e.ctrlKey || e.altKey) return;
  if (UI.route === 'review') reviewKey(e);
  else if (UI.route === 'read') readerKey(e);
}

/* ---------- top bar & languages ---------- */
function renderTopbar() {
  const l = L();
  $('#langName').textContent = l ? l.name : 'Choose a language';
  $('#langNative').textContent = l && l.native ? l.native : '';
  UI.syncStatus();
}
function langCounts(code) {
  if (!S.loaded.has(code)) return null;
  let known = 0, learning = 0;
  for (const e of vmap(code).values()) {
    if (e.d || e.p) continue;
    if (e.s === 2) known++; else if (e.s === 1) learning++;
  }
  return { known, learning };
}
function openLangPicker() {
  const rows = S.settings.langs.map(l => {
    const c = langCounts(l.code);
    return h('button', { class: 'lang-row' + (l.code === S.settings.cur ? ' on' : ''), type: 'button', onclick: async () => { closeModal(); await switchLang(l.code); } },
      h('span', { class: 'ln' }, l.name),
      l.native ? h('span', { class: 'nat', dir: 'auto', lang: l.code }, l.native) : null,
      h('span', { class: 'cnt' }, c ? `${fmtNum(c.known)} known` : ''));
  });
  openModal('Your languages', [
    h('div', { class: 'lang-list' }, rows),
    h('div', { class: 'm-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => { closeModal(); openCatalog(); } }, icon('plus'), 'Add a language')),
  ]);
}
async function switchLang(code) {
  closeSheet();
  setSettings({ cur: code });
  await ensureLang(code);
  if (UI.route === 'read') { UI.reader = null; go('library'); } else route();
}
const GROUPS = [['roster', 'Zabanestan Core Roster'], ['mine', SITE ? 'Study languages' : 'Your study languages'], ['iranian', 'More Iranian languages'], ['indic', 'Indo-Aryan languages'], ['other', 'Other languages']];
function addLang(p) {
  if (L(p.code)) return;
  setSettings({ langs: [...S.settings.langs, makeLang(p)] });
}
function openCatalog() {
  const q = h('input', { type: 'search', class: 'input', placeholder: 'Search by name or code', autofocus: true });
  const body = h('div', { class: 'cat' });
  const draw = () => {
    const have = new Set(S.settings.langs.map(l => l.code));
    const term = q.value.trim().toLowerCase();
    body.replaceChildren();
    for (const [grp, label] of GROUPS) {
      const items = CATALOG.filter(p => (grp === 'roster' ? p.roster : p.grp === grp && !(grp !== 'mine' && p.roster)) // roster languages appear once, under the roster
        && (!term || `${p.name} ${p.native || ''} ${p.code}`.toLowerCase().includes(term)));
      if (!items.length) continue;
      const head = h('div', { class: 'cat-head' }, h('h3', null, label));
      if (grp === 'roster' && !term) {
        const missing = CATALOG.filter(p => p.roster && !have.has(p.code));
        if (missing.length) head.append(h('button', { class: 'btn sm', type: 'button', onclick: () => {
          setSettings({ langs: [...S.settings.langs, ...missing.map(makeLang)] });
          toast(`Added ${missing.length} languages`);
          draw();
        } }, `Add all ${missing.length}`));
      }
      body.append(head);
      for (const p of items) {
        body.append(h('div', { class: 'cat-row' },
          h('div', { class: 'cat-name' }, h('b', null, p.name), p.native ? h('span', { class: 'nat', dir: 'auto' }, p.native) : null, h('code', null, p.code)),
          have.has(p.code) ? h('span', { class: 'muted sm' }, 'Added')
            : h('button', { class: 'btn sm', type: 'button', onclick: () => { addLang(p); draw(); } }, 'Add')));
      }
    }
    if (!body.childElementCount) body.append(h('p', { class: 'muted' }, 'No language matches. Use “Custom language” to set one up yourself.'));
  };
  q.addEventListener('input', draw);
  draw();
  openModal('Add a language', [q, body, h('div', { class: 'm-actions' },
    h('button', { class: 'btn', type: 'button', onclick: () => { closeModal(); openLangEditor(null); } }, 'Custom language…'))],
  { wide: true, onClose: () => { renderTopbar(); if (UI.route === 'options') viewOptions(); } });
}
function openLangEditor(code) {
  const ex = code ? L(code) : null;
  const d = ex ? { ...ex } : makeLang({ code: '', name: '', prof: 'mixed' });
  const name = h('input', { class: 'input', value: d.name, autofocus: true });
  const native = h('input', { class: 'input', value: d.native, dir: 'auto' });
  const codeIn = h('input', { class: 'input', value: d.code, placeholder: 'e.g. mzn', disabled: !!ex, autocapitalize: 'off', spellcheck: 'false' });
  const dir = selectEl([['auto', 'Detect from the text'], ['rtl', 'Right to left'], ['ltr', 'Left to right']], d.dir);
  const gloss = h('input', { class: 'input', value: d.gloss });
  const eq = h('input', { class: 'input', value: d.eq, dir: 'auto', spellcheck: 'false' });
  const elis = h('input', { class: 'input', value: d.elisions, spellcheck: 'false' });
  const caseLoc = h('input', { class: 'input', value: d.caseLocale, placeholder: 'same as the code', spellcheck: 'false' });
  const dicts = h('textarea', { class: 'input mono', rows: 4, value: d.dicts.map(x => `${x.n} | ${x.u}`).join('\n'), spellcheck: 'false' });
  const flags = { marks: d.marks, stress: d.stress, splitHyphen: d.splitHyphen, noSpaces: d.noSpaces };
  const err = h('p', { class: 'error', role: 'alert' });
  const save = async () => {
    const c = (ex ? ex.code : codeIn.value.trim().toLowerCase());
    if (!/^[a-z]{2,3}(-[a-z0-9]{1,8})*$|^x-[a-z0-9-]{1,30}$/.test(c)) { err.textContent = 'Use a language code like “mzn” or “ku-arab”, or “x-” plus a name for a private code.'; return; }
    if (!ex && L(c)) { err.textContent = 'You already have a language with that code.'; return; }
    if (!name.value.trim()) { err.textContent = 'Give the language a name.'; return; }
    const parsed = dicts.value.split('\n').map(line => {
      const i = line.indexOf('|');
      if (i < 0) return null;
      const n = line.slice(0, i).trim(), u = line.slice(i + 1).trim();
      return n && /^https?:\/\//.test(u) && (u.includes('{w}') || u.includes('{w-}')) ? { n, u } : null;
    }).filter(Boolean);
    const next = {
      ...d, code: c, name: name.value.trim(), native: native.value.trim(), dir: dir.value,
      gloss: gloss.value.trim() || 'English', eq: eq.value.trim(), elisions: elis.value.trim(),
      caseLocale: caseLoc.value.trim(), dicts: parsed, ...flags,
    };
    const rulesChanged = ex && (ex.eq !== next.eq || ex.marks !== next.marks || ex.stress !== next.stress || ex.caseLocale !== next.caseLocale);
    const langs = ex ? S.settings.langs.map(l => l.code === c ? next : l) : [...S.settings.langs, next];
    setSettings({ langs });
    resetLangCaches(c);
    closeModal();
    if (rulesChanged) {
      const n = await rekeyLang(c);
      if (n) toast(`Re-matched ${fmtNum(n)} saved words with the new rules`);
    }
    if (UI.reader && UI.reader.lang.code === c) { const id = UI.reader.meta.id; UI.reader = null; openLesson(id); }
    else route();
  };
  openModal(ex ? `Edit ${ex.name}` : 'Custom language', [
    field('le-name', 'Name', name),
    field('le-native', 'Name in the language (optional)', native),
    field('le-code', 'Language code', codeIn, ex ? 'The code can’t change once words are saved under it.' : 'An ISO 639 code such as mzn or glk. Used for fonts, spellings and speech.'),
    field('le-dir', 'Text direction', dir),
    field('le-gloss', 'Write meanings in', gloss, Cloud.sample ? 'Claude’s suggestions use this language, for example English or Persian.' : 'The language you write meanings in, for example English or Persian.'),
    h('h3', { class: 'sub' }, 'Matching words'),
    field('le-eq', 'Letters to treat as the same', eq, 'Pairs like ي=ی ك=ک, separated by spaces. Your saved words match either spelling.'),
    checkRow('le-marks', 'Ignore optional vowel marks', flags.marks, v => { flags.marks = v; }, 'Arabic harakat and Hebrew niqqud'),
    checkRow('le-stress', 'Ignore stress accents', flags.stress, v => { flags.stress = v; }, 'Acute and grave accents in Cyrillic or Latin textbooks'),
    checkRow('le-hyph', 'Split hyphenated words', flags.splitHyphen, v => { flags.splitHyphen = v; }),
    checkRow('le-nosp', 'This script doesn’t put spaces between words', flags.noSpaces, v => { flags.noSpaces = v; }, 'Uses your device’s word breaking, for Thai, Burmese, Chinese and similar'),
    field('le-elis', 'Elided prefixes to split off', elis, 'For French-style elision, e.g. l\' d\' qu\'. Leave empty otherwise.'),
    field('le-case', 'Capitalisation rules', caseLoc, 'Use tr or az for dotted and dotless i.'),
    h('h3', { class: 'sub' }, 'Dictionaries'),
    field('le-dicts', 'One per line: Name | address with {w} for the word', dicts, 'Use {w-} instead if the site wants hyphens between the words of a phrase.'),
    err,
    h('div', { class: 'm-actions' },
      ex ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (S.settings.langs.length < 2) { err.textContent = 'Keep at least one language.'; return; }
        if (!await confirmBox('Remove language', `Remove ${ex.name} from your languages? Your saved words and texts stay saved, and adding it again brings them back.`, 'Remove')) return;
        const langs = S.settings.langs.filter(l => l.code !== ex.code);
        setSettings({ langs, cur: S.settings.cur === ex.code ? langs[0].code : S.settings.cur });
        route();
      } }, 'Remove') : null,
      h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Save')),
  ], { wide: true });
}

/* ---------- reading appearance ---------- */
// The website copy declares its own fonts in the page, so it has nothing to fetch here.
const FONT_CSS = SITE ? {} : {
  serif: 'https://fonts.googleapis.com/css2?family=Noto+Serif:ital,wght@0,400;0,600;1,400&family=Noto+Naskh+Arabic:wght@400;600&family=Noto+Serif+Hebrew:wght@400;600&family=Noto+Serif+Devanagari:wght@400;600&display=swap',
  sans: 'https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600&family=Noto+Sans+Arabic:wght@400;600&family=Noto+Sans+Hebrew:wght@400;600&family=Noto+Sans+Devanagari:wght@400;600&display=swap',
  nastaliq: 'https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400;600&display=swap',
};
function ensureFont(style) {
  const need = style === 'nastaliq' ? ['serif', 'nastaliq'] : style === 'system' ? [] : [style];
  for (const k of need) {
    if (!FONT_CSS[k] || document.querySelector(`link[data-font="${k}"]`)) continue;
    document.head.append(h('link', { rel: 'stylesheet', href: FONT_CSS[k], 'data-font': k }));
  }
}
function applyReadingPrefs() {
  const st = S.settings;
  ensureFont(st.font);
  const r = document.documentElement.style;
  r.setProperty('--read-size', st.size + 'px');
  r.setProperty('--read-lh', String(st.font === 'nastaliq' ? Math.max(st.lh, 2.5) : st.lh));
  document.documentElement.dataset.font = st.font;
}
function readingControls(onChange) {
  const st = S.settings;
  const size = h('input', { type: 'range', min: 15, max: 34, step: 1, value: st.size, oninput: e => { setSettings({ size: +e.target.value }); applyReadingPrefs(); sizeOut.textContent = e.target.value + ' px'; } });
  const sizeOut = h('output', { class: 'muted sm' }, st.size + ' px');
  const lh = h('input', { type: 'range', min: 1.4, max: 2.8, step: 0.05, value: st.lh, oninput: e => { setSettings({ lh: +e.target.value }); applyReadingPrefs(); lhOut.textContent = (+e.target.value).toFixed(2); } });
  const lhOut = h('output', { class: 'muted sm' }, st.lh.toFixed(2));
  const pw = h('input', { type: 'number', class: 'input', min: 60, max: 1500, step: 10, value: st.pageWords, onchange: e => { setSettings({ pageWords: clamp(+e.target.value || 220, 60, 1500) }); onChange && onChange('page'); } });
  return [
    field('rc-font', 'Typeface', selectEl([['serif', 'Book (Noto Serif and Naskh)'], ['sans', 'Clean (Noto Sans)'], ['nastaliq', 'Nastaliq for Perso-Arabic'], ['system', 'Your device’s font']], st.font, v => { setSettings({ font: v }); applyReadingPrefs(); onChange && onChange('font'); })),
    h('div', { class: 'field' }, h('label', { for: 'rc-size' }, 'Text size ', sizeOut), Object.assign(size, { id: 'rc-size' })),
    h('div', { class: 'field' }, h('label', { for: 'rc-lh' }, 'Line spacing ', lhOut), Object.assign(lh, { id: 'rc-lh' })),
    field('rc-pw', 'Words per page', pw),
    checkRow('rc-hl', 'Highlight new and learning words', st.highlight, v => { setSettings({ highlight: v }); onChange && onChange('hl'); }),
    checkRow('rc-ak', 'Mark the words I didn’t tap as known when I turn the page', st.autoKnown, v => setSettings({ autoKnown: v })),
    checkRow('rc-ac', 'Make a flashcard when I save a meaning', st.autoCard, v => setSettings({ autoCard: v })),
  ];
}

/* ---------- library ---------- */
function queueInfo(scope) {
  const now = Date.now();
  const codes = scope === 'all' ? S.settings.langs.map(l => l.code) : [S.settings.cur];
  let learn = 0, rev = 0, fresh = 0;
  for (const c of codes) {
    if (!S.loaded.has(c)) continue;
    for (const e of vmap(c).values()) {
      if (e.d || e.s !== 1) continue;
      for (const d of [1, 2]) {
        const card = cardOf(e, d);
        if (!card || (d === 2 && !e.m)) continue;
        if (!card.q) fresh++;
        else if (card.due <= now) { if (card.q === 2) rev++; else learn++; }
      }
    }
  }
  const left = Math.max(0, S.settings.newPerDay - (today().n || 0));
  return { learn, rev, fresh: Math.min(fresh, left), freshTotal: fresh };
}
function updateBadge() {
  const b = $('#dueBadge');
  if (!b) return;
  const q = queueInfo(S.settings.scope);
  const n = q.learn + q.rev + q.fresh;
  b.textContent = n > 99 ? '99+' : String(n);
  b.hidden = !n;
}
function viewLibrary() {
  const lang = L();
  const v = $('#view');
  v.replaceChildren();
  if (!lang) return;
  const code = lang.code;
  if (!S.loaded.has(code)) { ensureLang(code).then(() => { if (UI.route === 'library') viewLibrary(); }); }
  const c = langCounts(code) || { known: 0, learning: 0 };
  const q = queueInfo('lang');
  const due = q.learn + q.rev + q.fresh;
  const d = today();
  v.append(h('section', { class: 'tiles', 'aria-label': 'Progress' },
    h('div', { class: 'tile' }, h('span', { class: 'big' }, fmtNum(c.known)), h('span', { class: 'lbl' }, 'known words')),
    h('div', { class: 'tile learning' }, h('span', { class: 'big' }, fmtNum(c.learning)), h('span', { class: 'lbl' }, 'learning')),
    h('a', { class: 'tile due', href: '#review' }, h('span', { class: 'big' }, fmtNum(due)), h('span', { class: 'lbl' }, due ? 'cards to review' : 'nothing due'))),
  );
  if (d.k || d.r) v.append(h('p', { class: 'today' }, `Today: ${fmtNum(d.k || 0)} words became known, ${fmtNum(d.r || 0)} cards reviewed.`));
  const note = libraryNotice();
  if (note) v.append(note);
  v.append(h('div', { class: 'actions' },
    h('button', { class: 'btn primary', type: 'button', onclick: () => openImport('file') }, icon('file'), 'Import a file'),
    h('button', { class: 'btn', type: 'button', onclick: () => openImport('paste') }, icon('paste'), 'Paste text'),
    Cloud.imageOCR ? h('button', { class: 'btn', type: 'button', onclick: () => openImport('photo') }, icon('camera'), 'Scan pages') : null,
    h('button', { class: 'btn', type: 'button', onclick: openMediaImport }, icon('play'), 'Audio or video'),
    ACCT ? h('button', { class: 'btn', type: 'button', onclick: () => go('shared') }, icon('library'), 'Shared library') : null));
  const lessons = [...S.lessons.values()].filter(m => !m.del && m.lang === code)
    .sort((a, b) => (b.opened || b.created || 0) - (a.opened || a.created || 0));
  v.append(h('h2', { class: 'sec' }, `${lang.name} texts`));
  if (lessons.length) v.append(h('div', { class: 'lessons' }, lessons.map(lessonRow)));
  else v.append(h('p', { class: 'empty' }, `Import ${Cloud.imageOCR ? 'a text, a PDF or a photo of a page' : 'a text or a PDF'} to start reading ${lang.name}. Files can be .txt, .md, .html, .srt or .pdf.`));
  const samples = (SAMPLES[code] || []).filter(s => !lessons.some(m => m.src === 'sample:' + s.id));
  if (samples.length) {
    v.append(h('h2', { class: 'sec' }, 'Sample text'));
    for (const s of samples) {
      v.append(h('button', { class: 'lesson sample', type: 'button', onclick: async () => { const m = await createLesson(code, s.title, s.text, 'sample:' + s.id); openLesson(m.id); } },
        h('span', { class: 'l-title' }, s.title),
        h('span', { class: 'l-snip', dir: 'auto', lang: code }, s.text.split('\n')[0]),
        h('span', { class: 'l-meta' }, 'Public-domain example · tap to open')));
    }
  }
}
// Words kept only in this browser can vanish if it clears its storage, so nudge
// for a backup once there's something worth keeping, and again after two weeks of changes.
function backupDue() {
  if (Cloud.state !== 'local') return false;
  const now = Date.now(), at = S.meta.backupAt || 0;
  if ((S.meta.backupSnooze || 0) > now) return false;
  if (at && now - at < 14 * DAY) return false;
  let saved = 0, changed = false;
  for (const code of S.loaded) for (const e of vmap(code).values()) {
    if (e.d || !(e.c || e.c2 || e.m)) continue;
    saved++;
    if ((e.u || 0) > at) changed = true;
  }
  return at ? changed : saved >= 15;
}
async function saveBackupFile() {
  toast('Preparing your backup…');
  const json = await buildBackup();
  const ok = await saveFile(`khwanish-backup-${dayKey()}.json`, json, 'Backup');
  if (ok) setMeta({ backupAt: Date.now(), backupSnooze: 0 });
  return ok;
}
function libraryNotice() {
  const started = [...S.lessons.values()].some(m => !m.del);
  if (SITE && !started) {
    return h('p', { class: 'notice' }, 'New here? The ', h('a', { href: SITE.guide }, 'reader guide'), ' shows how to import texts, save words and take your flashcards to Anki.');
  }
  if (!backupDue()) return null;
  const at = S.meta.backupAt;
  return h('div', { class: 'notice', role: 'note' },
    h('p', null, at
      ? `Your last backup was ${daysAgo(at)}, and you’ve saved words since. They live only in this browser, so save a fresh copy now and then.`
      : 'Your words are saved only in this browser. Save a backup file so you can restore them if the browser clears its data or you change devices.'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn sm primary', type: 'button', onclick: async () => { if (await saveBackupFile()) viewLibrary(); } }, 'Save a backup'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => { setMeta({ backupSnooze: Date.now() + 7 * DAY }); viewLibrary(); } }, 'Not now')));
}
function lessonRow(m) {
  const pct = m.kp != null ? Math.round(m.kp) : null;
  const pages = m.pages || 0;
  const metaBits = [`${fmtNum(m.words || 0)} words`];
  if (m.cues) metaBits.unshift(m.media && m.media.kind === 'video' ? 'video' : 'audio');
  if (pages > 1) metaBits.push(`page ${Math.min((m.page || 0) + 1, pages)} of ${pages}`);
  if (pct != null) metaBits.push(`${pct}% known`);
  if (m.done) metaBits.push('finished');
  return h('div', { class: 'lesson-wrap' },
    h('button', { class: 'lesson', type: 'button', onclick: () => openLesson(m.id) },
      h('span', { class: 'l-title', dir: 'auto' }, m.title),
      h('span', { class: 'l-meta' }, metaBits.join(' · ')),
      pct != null ? h('span', { class: 'l-bar', 'aria-hidden': 'true' }, h('i', { style: `width:${clamp(pct, 0, 100)}%` })) : null),
    h('button', { class: 'icon-btn l-more', type: 'button', 'aria-label': `Options for ${m.title}`, onclick: () => openLessonMenu(m) }, icon('more')));
}
function openLessonMenu(m) {
  const title = h('input', { class: 'input', value: m.title, dir: 'auto' });
  openModal('Text options', [
    field('lm-title', 'Title', title),
    h('div', { class: 'm-actions' },
      ACCT ? h('button', { class: 'btn', type: 'button', onclick: () => shareLesson(m) }, 'Share…') : null,
      h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!await confirmBox('Delete text', `Delete “${m.title}”? Words you’ve saved from it stay saved.`, 'Delete', true)) return;
        deleteLesson(m.id);
        viewLibrary();
      } }, 'Delete'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => {
        const t = title.value.trim();
        if (t) { m.title = t.slice(0, 140); putLesson(m); }
        closeModal(); viewLibrary();
      } }, 'Save')),
  ]);
}

/* ---------- import ---------- */
function langSelect(id) {
  const s = selectEl(S.settings.langs.map(l => [l.code, l.name]), S.settings.cur);
  s.id = id;
  return s;
}
function openImport(kind) {
  const langSel = langSelect('imp-lang');
  const enc = selectEl([['windows-1256', 'Persian/Arabic (Windows-1256)'], ['windows-1251', 'Cyrillic (Windows-1251)'], ['windows-1252', 'Western (Windows-1252)'], ['utf-16le', 'UTF-16']], 'windows-1256');
  const split = { on: true };
  const splitN = h('input', { type: 'number', class: 'input', min: 300, max: 20000, step: 100, value: 1500 });
  const err = h('p', { class: 'error', role: 'alert' });
  const body = [field('imp-lang', 'Language', langSel)];
  let fileIn = null, title = null, text = null;
  if (kind === 'paste') {
    title = h('input', { class: 'input', placeholder: 'Untitled', dir: 'auto' });
    text = h('textarea', { class: 'input', rows: 9, dir: 'auto', placeholder: 'Paste the text here', autofocus: true });
    body.push(field('imp-title', 'Title', title), field('imp-text', 'Text', text));
  } else {
    const accept = kind === 'photo' ? 'image/*' : '.txt,.md,.markdown,.html,.htm,.srt,.vtt,.csv,.tsv,.pdf,text/plain,text/html,application/pdf' + (Cloud.imageOCR ? ',image/*' : '');
    fileIn = h('input', { type: 'file', class: 'input', accept, multiple: true });
    body.push(field('imp-file', kind === 'photo' ? 'Photos of pages' : 'Files', fileIn,
      kind === 'photo' ? 'Take photos or choose them from your library. They become one text, in the order you pick them.'
        : 'Text files, web pages, subtitles or PDFs.' + (Cloud.imageOCR ? ' Photos of pages work too.' : '')));
  }
  body.push(
    h('details', { class: 'adv' }, h('summary', null, 'More options'),
      checkRow('imp-split', 'Split long texts into parts', true, v => { split.on = v; }),
      field('imp-splitn', 'Words per part', splitN),
      kind === 'paste' ? null : field('imp-enc', 'If a text file isn’t UTF-8, read it as', enc)),
    err,
    h('div', { class: 'm-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: go1 }, kind === 'photo' ? 'Continue' : 'Import')));
  openModal(kind === 'paste' ? 'Paste a text' : kind === 'photo' ? 'Scan pages' : 'Import files', body, { wide: true });

  async function go1() {
    err.textContent = '';
    const code = langSel.value;
    const lang = langOrStub(code);
    const opts = { split: split.on, splitN: clamp(+splitN.value || 1500, 300, 20000) };
    if (kind === 'paste') {
      const t = cleanText(text.value, 'txt');
      if (!t) { err.textContent = 'Paste some text first.'; return; }
      const metas = await saveImported(code, lang, title.value.trim() || firstLineTitle(t), t, opts);
      closeModal(); afterImport(code, metas);
      return;
    }
    const files = [...(fileIn.files || [])];
    if (!files.length) { err.textContent = 'Choose at least one file.'; return; }
    const images = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|heic)$/i.test(f.name));
    const pdfs = files.filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const texts = files.filter(f => !images.includes(f) && !pdfs.includes(f));
    const made = [];
    for (const f of texts) {
      try {
        const raw = decodeBytes(await f.arrayBuffer(), enc.value);
        const ext = (f.name.split('.').pop() || '').toLowerCase();
        const t = cleanText(raw, ext === 'html' || ext === 'htm' ? 'html' : ext);
        if (!t) continue;
        made.push(...await saveImported(code, lang, f.name.replace(/\.[^.]+$/, ''), t, opts));
      } catch (e) { console.warn(e); err.textContent = `Couldn’t read ${f.name}.`; }
    }
    if (pdfs.length || images.length) {
      if (made.length) toast(`Imported ${made.length} text${made.length > 1 ? 's' : ''}`);
      if (pdfs.length) openPdfFlow(pdfs[0], code, opts, pdfs.slice(1));
      else openScanFlow(images, code, opts, images.length === 1 ? images[0].name.replace(/\.[^.]+$/, '') : 'Scanned pages');
      return;
    }
    if (!made.length) { if (!err.textContent) err.textContent = 'Those files had no text in them.'; return; }
    closeModal();
    afterImport(code, made);
  }
}
const firstLineTitle = t => (t.split('\n').find(l => l.trim()) || 'Untitled').trim().slice(0, 60);
async function saveImported(code, lang, title, text, opts) {
  const words = countWords(text, lang);
  if (opts.split && words > opts.splitN * 1.5) {
    const parts = splitLong(text, lang, opts.splitN);
    const out = [];
    for (let i = 0; i < parts.length; i++) out.push(await createLesson(code, `${title} · ${i + 1}/${parts.length}`, parts[i]));
    return out;
  }
  return [await createLesson(code, title, text)];
}
function afterImport(code, metas) {
  if (!metas.length) return;
  if (code !== S.settings.cur) setSettings({ cur: code });
  if (metas.length === 1) openLesson(metas[0].id);
  else { toast(`Imported ${metas.length} texts`); go('library'); }
}

/* ---------- PDFs and photos ---------- */
const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
// The website copy keeps its own pdf.js next to the page and only falls back to the CDN.
const PDFJS_BASES = SITE ? [SITE.lib + 'pdfjs/', PDFJS_CDN] : [PDFJS_CDN];
let pdfjsPromise = null;
function loadPdfJs() {
  if (window.pdfjsLib && window.pdfjsLib.getDocument) return Promise.resolve(window.pdfjsLib);
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    for (const base of PDFJS_BASES) {
      try { await loadScript(base + 'pdf.min.js'); } catch { continue; }
      const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
      if (!lib || !lib.getDocument) throw new Error('The PDF reader didn’t load.');
      // pdf.js wraps a cross-origin worker in a blob itself, and falls back to the main thread if workers are blocked
      lib.GlobalWorkerOptions.workerSrc = absUrl(base + 'pdf.worker.min.js');
      return lib;
    }
    throw new Error('Couldn’t load the PDF reader. Check your connection and try again.');
  })();
  pdfjsPromise.catch(() => { pdfjsPromise = null; });
  return pdfjsPromise;
}
// Many Arabic-script PDFs store glyphs in visual (left-to-right) order. Rebuild
// each line from glyph positions: right-to-left lines are read from the right,
// while runs of digits or Latin/Cyrillic letters inside them keep their order.
const RTL_LETTER = /[֐-׿؀-ٟٮ-ۯۺ-ࣿיִ-﷿ﹰ-﻿]/;
const RTL_LETTER_G = new RegExp(RTL_LETTER.source, 'g');
function orderPdfLine(items) {
  const text = items.map(i => i.s).join('');
  const rtl = (text.match(RTL_LETTER_G) || []).length;
  const other = (text.match(/\p{L}/gu) || []).length - rtl;
  if (rtl <= other) return text;
  const sorted = [...items].sort((a, b) => b.x - a.x);
  const isL = i => /[\p{Nd}]|[A-Za-zÀ-ɏͰ-ϿЀ-ԯऀ-ॿ]/u.test(i.s) && !RTL_LETTER.test(i.s);
  const isNeutral = i => !/[\p{L}\p{N}]/u.test(i.s);
  const out = [];
  let run = [];
  const flush = () => {
    const tail = [];
    while (run.length && isNeutral(run[run.length - 1])) tail.unshift(run.pop());
    out.push(...run.reverse(), ...tail);
    run = [];
  };
  for (const it of sorted) {
    if (isL(it)) run.push(it);
    else if (run.length && isNeutral(it)) run.push(it);
    else { flush(); out.push(it); }
  }
  flush();
  return out.map(i => i.s).join('');
}
// Combining marks drawn as separate glyphs (e.g. the ezafe hamza) rejoin their letter.
const fixMarks = s => s.replace(/(\p{L})\s+(\p{M})/gu, '$1$2').replace(/(^|[^\p{L}\p{M}])(\p{M}+)(\p{L})/gu, '$1$3$2');
async function pdfPageText(page) {
  const tc = await page.getTextContent();
  const lines = [];
  let cur = null;
  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue;
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const y = tr[5], size = Math.abs(tr[3]) || it.height || 10, x0 = tr[4], w = it.width || 0;
    if (it.str) {
      if (!cur || Math.abs(y - cur.y) > size * 0.6) { cur = { y, size, items: [], x0: Infinity, x1: -Infinity }; lines.push(cur); }
      cur.items.push({ s: it.str, x: x0 + w / 2 });
      cur.x0 = Math.min(cur.x0, x0); cur.x1 = Math.max(cur.x1, x0 + w);
    }
    if (it.hasEOL) cur = null;
  }
  const texts = lines.map(l => fixMarks(orderPdfLine(l.items)).replace(/\s+/g, ' ').trim());
  // Rejoin lines that wrapped inside a paragraph; keep short lines (verse, headings) apart.
  const dys = [];
  for (let i = 1; i < lines.length; i++) dys.push(Math.abs(lines[i - 1].y - lines[i].y));
  const med = dys.length ? [...dys].sort((a, b) => a - b)[Math.floor(dys.length / 2)] : 0;
  const maxW = Math.max(1, ...lines.map(l => l.x1 - l.x0));
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const t = texts[i];
    if (!t) continue;
    if (!out) { out = t; continue; }
    const prev = lines[i - 1], prevT = texts[i - 1] || '';
    const prevW = prev.x1 - prev.x0, dy = Math.abs(prev.y - lines[i].y);
    const end = prevT.replace(/[»"”’)\]]+$/, '').slice(-1);
    const brk = !prevT || (med && dy > med * 1.45) || dy > lines[i].size * 2.2 || prevW < maxW * 0.72 || (TERM.test(end) && prevW < maxW * 0.9);
    if (!brk && /\p{Ll}-$/u.test(prevT) && /^\p{Ll}/u.test(t)) out = out.slice(0, -1) + t;
    else out += (brk ? '\n' : ' ') + t;
  }
  return out;
}
async function canvasToBlobs(canvas, maxParts) {
  const toBlob = c => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('image')), 'image/jpeg', 0.88));
  const { width: w, height: hgt } = canvas;
  if (maxParts < 2 || hgt <= w * 1.25) return [await toBlob(canvas)];
  const ov = Math.round(hgt * 0.04), half = Math.round(hgt / 2);
  const parts = [[0, half + ov], [half - ov, hgt]];
  const out = [];
  for (const [y0, y1] of parts) {
    const c = document.createElement('canvas');
    c.width = w; c.height = y1 - y0;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(canvas, 0, y0, w, y1 - y0, 0, 0, w, y1 - y0);
    out.push(await toBlob(c));
  }
  return out;
}
async function pdfPageBlobs(page, maxParts) {
  const vp1 = page.getViewport({ scale: 1 });
  const scale = clamp(1500 / vp1.width, 0.5, 3);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvasToBlobs(canvas, maxParts);
}
async function imageFileBlobs(file, maxParts) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Couldn’t open that image.')); i.src = url; });
    const scale = Math.min(1, 1600 / img.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvasToBlobs(canvas, maxParts);
  } finally { URL.revokeObjectURL(url); }
}
function ocrPrompt(lang, parts) {
  return [
    parts > 1
      ? 'Transcribe the printed text in these images. They are the top and bottom halves of one page, cut with a small overlap: transcribe the page once, in reading order, without repeating the overlapping line.'
      : 'Transcribe the printed text in this page image.',
    `The text is in ${lang.name}${lang.code ? ` (language code ${lang.code})` : ''}. Copy it exactly as printed: keep the original spelling, letters, diacritics and punctuation. Do not translate, modernize, standardize or correct anything.`,
    'Put each paragraph on its own line and each line of verse on its own line. Leave a blank line between paragraphs, stanzas or sections.',
    'Leave out page numbers, running headers and footers, and footnote reference marks.',
    'Write […] for anything you cannot read.',
    'Reply with only the transcription. If the page has no text, reply with exactly: [no text]',
  ].join('\n');
}
async function ocrLimits() {
  try { const l = await Cloud.sample.limits(); return (l && l.images && l.images.maxCount) || 1; } catch { return 1; }
}
// Shared editor shown after text comes out of a PDF or a scan.
function showImportPreview(code, opts, title, text, note) {
  const lang = langOrStub(code);
  const titleIn = h('input', { class: 'input', value: title, dir: 'auto' });
  const ta = h('textarea', { class: 'input preview', rows: 14, dir: 'auto', lang: code, value: text });
  const err = h('p', { class: 'error', role: 'alert' });
  openModal('Check the text', [
    note ? h('p', { class: 'm-text muted' }, note) : null,
    field('pv-title', 'Title', titleIn),
    field('pv-text', 'Text', ta, 'Fix any mistakes now. You can also change the text later by importing it again.'),
    err,
    h('div', { class: 'm-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      const t = cleanText(ta.value, 'txt');
      if (!t) { err.textContent = 'There’s no text to save.'; return; }
      const metas = await saveImported(code, lang, titleIn.value.trim() || 'Untitled', t, opts);
      closeModal(); afterImport(code, metas);
    } }, 'Create text')),
  ], { wide: true });
}
async function openPdfFlow(file, code, opts, rest = []) {
  const lang = langOrStub(code);
  const status = h('p', { class: 'm-text', role: 'status' }, 'Opening the PDF…');
  const box = h('div', { class: 'ocr-box' });
  openModal('Import a PDF', [h('p', { class: 'muted sm' }, file.name), status, box], { wide: true });
  let pdf;
  try {
    const lib = await loadPdfJs();
    pdf = await withTimeout(lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise, 90000, 'Opening the PDF');
  } catch (e) {
    status.textContent = (e && e.message) || 'Couldn’t open that PDF.';
    return;
  }
  const n = pdf.numPages;
  let sample = '';
  for (let i = 1; i <= Math.min(3, n); i++) sample += await pdfPageText(await pdf.getPage(i));
  const letters = (sample.match(/\p{L}/gu) || []).length;
  const hasText = letters > 60 * Math.min(3, n);
  const base = file.name.replace(/\.pdf$/i, '');
  status.textContent = `${n} page${n > 1 ? 's' : ''}. ` + (hasText ? 'This PDF has text inside it, so it can be read directly.' : 'This PDF looks like a scan, with no text inside.');
  const from = h('input', { type: 'number', class: 'input', min: 1, max: n, value: 1 });
  const to = h('input', { type: 'number', class: 'input', min: 1, max: n, value: hasText ? n : Math.min(n, 10) });
  const range = h('div', { class: 'row2' }, field('pdf-from', 'From page', from), field('pdf-to', 'To page', to));
  const pick = () => { const a = clamp(+from.value || 1, 1, n), b = clamp(+to.value || n, a, n); return [a, b]; };
  const useText = h('button', { class: 'btn ' + (hasText ? 'primary' : ''), type: 'button', onclick: async () => {
    const [a, b] = pick();
    useText.disabled = true;
    let out = '';
    for (let i = a; i <= b; i++) {
      status.textContent = `Reading page ${i} of ${b}…`;
      out += await pdfPageText(await pdf.getPage(i)) + '\n\n';
    }
    const t = cleanText(out, 'txt');
    if (!t) { status.textContent = 'No text came out of those pages. Try transcribing them instead.'; useText.disabled = false; return; }
    showImportPreview(code, opts, base, t, Cloud.imageOCR
      ? 'Text taken from the PDF. If letters come out jumbled or reversed, go back and choose “Transcribe with Claude” instead.'
      : 'Text taken from the PDF. If letters come out jumbled or reversed, run the pages through an OCR tool instead and import the .txt it makes.');
    queueRest(rest, code, opts);
  } }, 'Use the PDF’s text');
  const scan = Cloud.imageOCR ? h('button', { class: 'btn ' + (hasText ? '' : 'primary'), type: 'button', onclick: () => {
    const [a, b] = pick();
    runScan(code, opts, base, b - a + 1, async (k, parts) => pdfPageBlobs(await pdf.getPage(a + k), parts), rest);
  } }, 'Transcribe with Claude') : null;
  // page range only matters when there's something to do with the pages
  if (hasText || scan) box.append(range);
  box.append(h('div', { class: 'm-actions' }, hasText ? useText : null, scan,
    !hasText && !scan ? (SITE
      ? h('p', { class: 'muted' }, 'To read a scan, turn it into text first with the free OCR helper described in the ', h('a', { href: SITE.guide + '#ocr' }, 'reader guide'), ', then import the .txt file it makes.')
      : h('p', { class: 'muted' }, 'Transcribing scans needs Claude, which isn’t available here. Run the PDF through an OCR tool and import the .txt it gives you.')) : null));
}
function queueRest(rest, code, opts) {
  if (!rest || !rest.length) return;
  toast(`${rest.length} more PDF${rest.length > 1 ? 's' : ''} to import`, 'Next', () => openPdfFlow(rest[0], code, opts, rest.slice(1)));
}
function openScanFlow(images, code, opts, title) {
  runScan(code, opts, title, images.length, (k, parts) => imageFileBlobs(images[k], parts));
}
async function runScan(code, opts, title, count, getBlobs, rest) {
  const lang = langOrStub(code);
  const tier = { v: 'default' };
  const status = h('p', { class: 'm-text', role: 'status' }, `${count} page${count > 1 ? 's' : ''} to transcribe. Claude reads each page and types out the text; this uses your Claude usage.`);
  const bar = h('div', { class: 'progress', 'aria-hidden': 'true' }, h('i'));
  const out = h('textarea', { class: 'input preview', rows: 10, dir: 'auto', lang: code, readonly: true });
  let ctl = null, stopped = false;
  const start = h('button', { class: 'btn primary', type: 'button' }, 'Start');
  const stop = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => { stopped = true; if (ctl) ctl.abort(); } }, 'Stop');
  openModal('Transcribe pages', [
    status, bar,
    checkRow('ocr-careful', 'Read more carefully (slower)', false, v => { tier.v = v ? 'complex' : 'default'; }, 'Helps with Nastaliq, small print and old typefaces'),
    field('ocr-out', 'Transcription so far', out),
    h('div', { class: 'm-actions' }, stop, start),
  ], { wide: true, onClose: () => { stopped = true; if (ctl) ctl.abort(); } });
  start.addEventListener('click', async () => {
    start.hidden = true; stop.hidden = false;
    const maxParts = Math.min(2, await ocrLimits());
    const pages = [];
    let failed = '';
    for (let k = 0; k < count && !stopped; k++) {
      status.textContent = `Transcribing page ${k + 1} of ${count}…`;
      bar.firstChild.style.width = `${(k / count) * 100}%`;
      try {
        const blobs = await getBlobs(k, maxParts);
        ctl = new AbortController();
        const r = await Cloud.sample(ocrPrompt(lang, blobs.length), { images: blobs, modelTier: tier.v, signal: ctl.signal });
        let t = (r && r.text || '').trim();
        if (/^\[no text\]$/i.test(t)) t = '';
        pages.push(t);
        out.value = pages.filter(Boolean).join('\n\n');
        out.scrollTop = out.scrollHeight;
      } catch (e) {
        if (e && e.code === 'cancelled') break;
        failed = aiErrorText(e) || 'A page couldn’t be transcribed.';
        break;
      }
    }
    bar.firstChild.style.width = '100%';
    const text = pages.filter(Boolean).join('\n\n');
    if (!text) {
      status.textContent = failed || 'No text came back.';
      start.hidden = false; start.textContent = 'Try again'; stop.hidden = true;
      return;
    }
    showImportPreview(code, opts, title, text, failed ? `Stopped after ${pages.length} page${pages.length === 1 ? '' : 's'}: ${failed}` : `Transcribed ${pages.length} page${pages.length === 1 ? '' : 's'}.`);
    queueRest(rest, code, opts);
  });
}

/* ---------- reader ---------- */
async function openLesson(id, page) {
  const meta = S.lessons.get(id);
  if (!meta || meta.del) { go('library'); return; }
  closeSheet();
  const lang = langOrStub(meta.lang);
  if (!L(meta.lang)) addLang(CATALOG_BY_CODE[meta.lang] || { code: meta.lang, name: meta.lang });
  if (meta.lang !== S.settings.cur) setSettings({ cur: meta.lang });
  await ensureLang(meta.lang);
  const text = await getText(id);
  if (text == null) { toast('This text hasn’t finished downloading. Try again in a moment.'); UI.reader = null; go('library'); return; }
  const paras = analyze(text, L(meta.lang) || lang);
  const media = Array.isArray(meta.cues) && meta.cues.length ? { cues: meta.cues } : null;
  const pages = media ? [paras.map((p, i) => ({ p: i, a: 0, b: p.toks.length }))] : paginate(paras, S.settings.pageWords);
  const all = new Set();
  for (const p of paras) for (const t of p.toks) if (t.w) all.add(t.k);
  UI.reader = {
    meta, lang: L(meta.lang) || lang, paras, pages, all,
    page: clamp(page != null ? page : meta.page || 0, 0, pages.length - 1),
    flat: [], spans: new Map(), session: { known: 0, cards: 0 }, media,
  };
  meta.opened = Date.now();
  meta.pages = pages.length;
  updateLessonStats(false);
  putLesson(meta);
  setMeta({ lastLesson: id });
  if (location.hash.slice(1) === 'read') route(); else location.hash = 'read';
}
function leaveReader() {
  commitSheet();
  closeSheet();
  if (UI.reader && UI.reader.el) { try { UI.reader.el.pause(); URL.revokeObjectURL(UI.reader.url); } catch { } }
  if (UI.reader) { updateLessonStats(true); }
  UI.reader = null;
}
function updateLessonStats(save) {
  const R = UI.reader;
  if (!R) return;
  const m = vmap(R.lang.code);
  let known = 0, ign = 0, fresh = 0;
  for (const k of R.all) {
    const e = m.get(k);
    if (e && !e.d && e.s === 2) known++;
    else if (e && !e.d && e.s === 3) ign++;
    else if (!e || e.d || !e.s) fresh++;
  }
  const denom = Math.max(1, R.all.size - ign);
  R.meta.kp = Math.round((known / denom) * 1000) / 10;
  R.meta.nw = fresh;
  R.meta.page = R.page;
  if (save) putLesson(R.meta);
}
function stClass(code, key) {
  const e = vmap(code).get(key);
  if (!e || e.d || !e.s) return 'st-new';
  if (e.s === 1) { const s = e.c ? e.c.S || 0 : 0; return s >= 21 ? 'st-l3' : s >= 4 ? 'st-l2' : 'st-l1'; }
  return '';
}
const tokOf = sp => UI.reader.paras[+sp.dataset.p].toks[+sp.dataset.i];
function viewReader() {
  const R = UI.reader;
  const v = $('#view');
  v.replaceChildren();
  if (!R) return;
  const prog = h('div', { class: 'rprog', 'aria-hidden': 'true' }, h('i'));
  v.append(h('div', { class: 'reader' },
    h('div', { class: 'rbar' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back to library', onclick: () => go('library') }, icon('back')),
      h('div', { class: 'rtitle', dir: 'auto' }, R.meta.title),
      h('button', { class: 'icon-btn aa', type: 'button', 'aria-label': 'Reading options', onclick: openReadingMenu }, 'Aa')),
    prog,
    R.media ? h('div', { class: 'player', id: 'player' }) : null,
    h('div', { class: 'rtext', id: 'rtext', lang: R.lang.code }),
    h('div', { class: 'rfoot' },
      h('button', { class: 'btn', type: 'button', id: 'pg-prev', 'aria-label': 'Previous page', onclick: prevPage }, icon('back')),
      h('div', { class: 'pginfo', id: 'pginfo', role: 'status' }),
      h('button', { class: 'btn primary', type: 'button', id: 'pg-next', onclick: nextPage }))));
  const box = $('#rtext');
  box.addEventListener('click', e => {
    const cue = e.target.closest('.cue-t');
    if (cue) { seekCue(R, +cue.dataset.cue); return; }
    const sp = e.target.closest('.w');
    if (sp) selectWord(sp);
    else if (UI.sheet && !window.getSelection().toString()) closeSheet();
  });
  renderPage();
  if (R.media) setupPlayer(R);
}
function renderPage(keepScroll) {
  const R = UI.reader;
  const box = $('#rtext');
  if (!R || !box) return;
  box.classList.toggle('plain', !S.settings.highlight);
  box.replaceChildren();
  R.flat = []; R.spans = new Map();
  const code = R.lang.code;
  const dir = R.lang.dir === 'auto' ? 'auto' : R.lang.dir;
  for (const blk of R.pages[R.page]) {
    const para = R.paras[blk.p];
    const p = document.createElement('p');
    p.dir = dir;
    if (blk.a > 0) p.className = 'cont';
    else if (para.gap) p.className = 'gap';
    const cue = R.media && blk.a === 0 ? R.media.cues[blk.p] : null;
    if (cue) {
      p.dataset.cue = blk.p;
      p.append(h('button', { class: 'cue-t', type: 'button', 'data-cue': blk.p, 'aria-label': `Play from ${fmtClock(cue[0])}` }, fmtClock(cue[0])));
    }
    for (let i = blk.a; i < blk.b; i++) {
      const t = para.toks[i];
      if (!t.w) { p.append(t.s); continue; }
      const sp = document.createElement('span');
      sp.className = 'w ' + stClass(code, t.k);
      sp.textContent = t.s;
      sp.dataset.p = blk.p; sp.dataset.i = i; sp.dataset.j = R.flat.length;
      let arr = R.spans.get(t.k);
      if (!arr) R.spans.set(t.k, arr = []);
      arr.push(sp);
      R.flat.push(sp);
      p.append(sp);
    }
    box.append(p);
  }
  if (!R.flat.length && !box.childElementCount) box.append(h('p', { class: 'muted' }, 'This page is empty.'));
  markPhrases();
  updatePageInfo();
  if (!keepScroll) window.scrollTo(0, 0);
}
function updatePageInfo() {
  const R = UI.reader;
  if (!R) return;
  const n = R.pages.length;
  let fresh = 0, learning = 0;
  const seen = new Set();
  for (const sp of R.flat) {
    const k = tokOf(sp).k;
    if (seen.has(k)) continue;
    seen.add(k);
    const c = stClass(R.lang.code, k);
    if (c === 'st-new') fresh++; else if (c) learning++;
  }
  const info = $('#pginfo');
  if (info) info.replaceChildren(
    h('b', null, `${R.page + 1} / ${n}`),
    h('span', null, `${fresh} new · ${learning} learning`));
  const next = $('#pg-next');
  if (next) next.replaceChildren(R.page < n - 1 ? 'Next page' : 'Finish', icon(R.page < n - 1 ? 'next' : 'check'));
  const prev = $('#pg-prev');
  if (prev) prev.disabled = R.page === 0;
  const bar = $('.rprog i');
  if (bar) bar.style.width = `${((R.page + 1) / n) * 100}%`;
}
function refreshKeys(keys) {
  const R = UI.reader;
  if (!R) return;
  for (const k of keys) for (const sp of R.spans.get(k) || []) {
    const sel = sp.classList.contains('sel');
    const ph = sp.classList.contains('ph');
    sp.className = 'w ' + stClass(R.lang.code, k) + (sel ? ' sel' : '') + (ph ? ' ph' : '');
  }
  updatePageInfo();
}
function refreshAllClasses() {
  const R = UI.reader;
  if (!R) return;
  refreshKeys([...R.spans.keys()]);
  markPhrases();
  if (UI.sheet) renderSheet();
}
function phraseIndex(code) {
  const idx = new Map();
  for (const [k, e] of vmap(code)) {
    if (!e.p || e.d) continue;
    const parts = k.split(' ');
    if (parts.length < 2) continue;
    const arr = idx.get(parts[0]) || [];
    arr.push(parts);
    idx.set(parts[0], arr);
  }
  for (const arr of idx.values()) arr.sort((a, b) => b.length - a.length);
  return idx;
}
function adjacent(a, b) {
  if (a.dataset.p !== b.dataset.p) return false;
  const para = UI.reader.paras[+a.dataset.p];
  for (let i = +a.dataset.i + 1; i < +b.dataset.i; i++) if (/[^\s‌  \-‐‑]/.test(para.toks[i].s)) return false;
  return true;
}
function markPhrases() {
  const R = UI.reader;
  if (!R) return;
  for (const sp of R.flat) { if (sp.dataset.ph) { sp.classList.remove('ph'); delete sp.dataset.ph; delete sp.dataset.phs; } }
  const idx = phraseIndex(R.lang.code);
  if (!idx.size) return;
  const flat = R.flat;
  for (let j = 0; j < flat.length; j++) {
    const cands = idx.get(tokOf(flat[j]).k);
    if (!cands) continue;
    for (const parts of cands) {
      let ok = true, jj = j;
      for (let q = 1; q < parts.length; q++) {
        const nx = flat[jj + 1];
        if (!nx || !adjacent(flat[jj], nx) || tokOf(nx).k !== parts[q]) { ok = false; break; }
        jj++;
      }
      if (ok) {
        const key = parts.join(' ');
        for (let q = j; q <= jj; q++) { flat[q].classList.add('ph'); flat[q].dataset.ph = key; flat[q].dataset.phs = j; }
        j = jj;
        break;
      }
    }
  }
}
function setSel(spans) {
  for (const sp of $$('.w.sel')) sp.classList.remove('sel');
  for (const sp of spans || []) sp.classList.add('sel');
}
function sentenceOf(para, i) {
  const sid = para.toks[i].sid;
  return para.toks.filter(t => t.sid === sid).map(t => t.s).join('').replace(/\s+/g, ' ').trim();
}
function selectWord(sp) {
  commitSheet();
  const R = UI.reader;
  if (R.el && !R.el.paused) { R.el.pause(); R.resume = true; }
  const j = +sp.dataset.j;
  const t = tokOf(sp);
  setSel([sp]);
  openSheet({
    code: R.lang.code, key: t.k, form: t.s, sentence: sentenceOf(R.paras[+sp.dataset.p], +sp.dataset.i),
    origin: R.meta.title, range: [j, j], anchor: j, phrase: false,
  });
  scrollIntoViewAboveSheet(sp);
}
function scrollIntoViewAboveSheet(sp) {
  requestAnimationFrame(() => {
    const sheet = $('#sheet');
    const r = sp.getBoundingClientRect();
    const wide = window.matchMedia('(min-width: 1000px)').matches;
    const bottomLimit = wide ? window.innerHeight - 70 : window.innerHeight - (sheet ? sheet.offsetHeight : 0) - 16;
    if (r.bottom > bottomLimit) window.scrollBy({ top: r.bottom - bottomLimit + 24, behavior: 'smooth' });
    else if (r.top < 64) window.scrollBy({ top: r.top - 80, behavior: 'smooth' });
  });
}
function readerKey(e) {
  const R = UI.reader;
  if (!R) return;
  const k = e.key;
  if (k === ' ' && R.el) { if (R.el.paused) R.el.play().catch(() => {}); else R.el.pause(); e.preventDefault(); return; }
  if (k === 'ArrowRight' || k === 'ArrowLeft') {
    if (!R.flat.length) return;
    const cur = UI.sheet && UI.sheet.range ? UI.sheet.range[0] : -1;
    const p = cur >= 0 ? R.flat[cur].closest('p') : $('#rtext p');
    const rtl = p && getComputedStyle(p).direction === 'rtl';
    const fwd = (k === 'ArrowRight') !== rtl;
    const nj = cur < 0 ? 0 : clamp(cur + (fwd ? 1 : -1), 0, R.flat.length - 1);
    selectWord(R.flat[nj]);
    e.preventDefault();
    return;
  }
  if (k === ']') { nextPage(); e.preventDefault(); return; }
  if (k === '[') { prevPage(); e.preventDefault(); return; }
  if (!UI.sheet) return;
  const map = { n: 0, l: 1, k: 2, i: 3 };
  const lk = k.toLowerCase();
  if (lk in map) { setStatus(map[lk]); e.preventDefault(); }
  else if (lk === 'a') { addCard(); e.preventDefault(); }
}
function nextPage() {
  const R = UI.reader;
  if (!R) return;
  commitSheet();
  closeSheet();
  const code = R.lang.code;
  const marked = [];
  if (S.settings.autoKnown) {
    const seen = new Set();
    for (const sp of R.flat) {
      const t = tokOf(sp);
      if (seen.has(t.k)) continue;
      seen.add(t.k);
      const e = vmap(code).get(t.k);
      if (!e || e.d || !e.s) { marked.push([t.k, e && !e.d ? { ...e } : null]); putEntry(code, t.k, { s: 2 }); }
    }
    if (marked.length) {
      bumpStat('k', marked.length);
      R.session.known += marked.length;
    }
  }
  const last = R.page >= R.pages.length - 1;
  if (!last) { R.page++; updateLessonStats(true); renderPage(); }
  else if (marked.length) refreshKeys(marked.map(x => x[0]));
  if (marked.length) toast(`${marked.length} word${marked.length > 1 ? 's' : ''} marked known`, 'Undo', () => {
    for (const [k, prev] of marked) restoreEntry(code, k, prev);
    bumpStat('k', -marked.length);
    if (UI.reader === R) { R.session.known -= marked.length; refreshKeys(marked.map(x => x[0])); updateLessonStats(true); }
  });
  if (last) finishLesson();
  updateBadge();
}
function prevPage() {
  const R = UI.reader;
  if (!R || R.page === 0) return;
  commitSheet(); closeSheet();
  R.page--;
  updateLessonStats(true);
  renderPage();
}
function finishLesson() {
  const R = UI.reader;
  R.meta.done = true;
  updateLessonStats(true);
  const m = R.meta.title.match(/^(.*) · (\d+)\/(\d+)$/);
  let next = null;
  if (m && +m[2] < +m[3]) {
    const want = `${m[1]} · ${+m[2] + 1}/${m[3]}`;
    next = [...S.lessons.values()].find(x => !x.del && x.lang === R.meta.lang && x.title === want);
  }
  const q = queueInfo('lang');
  openModal('Text finished', [
    h('p', { class: 'm-text' }, `“${R.meta.title}” · ${Math.round(R.meta.kp || 0)}% of its words are known now.`),
    h('ul', { class: 'facts' },
      h('li', null, h('b', null, fmtNum(R.session.known)), ' words marked known while reading'),
      h('li', null, h('b', null, fmtNum(R.session.cards)), ' flashcards added'),
      h('li', null, h('b', null, fmtNum(q.learn + q.rev + q.fresh)), ' cards ready to review')),
    h('div', { class: 'm-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => { closeModal(); go('library'); } }, 'Library'),
      q.learn + q.rev + q.fresh ? h('button', { class: 'btn', type: 'button', onclick: () => { closeModal(); go('review'); } }, 'Review') : null,
      next ? h('button', { class: 'btn primary', type: 'button', onclick: () => { closeModal(); openLesson(next.id, 0); } }, 'Next part') : null),
  ]);
}
function openReadingMenu() {
  openModal('Reading options', readingControls(what => {
    if (!UI.reader) return;
    if (what === 'page') { const id = UI.reader.meta.id; UI.reader = null; closeModal(); openLesson(id, 0); }
    else if (what === 'hl') renderPage(true);
  }));
}

/* ---------- audio and video texts ---------- */
function openMediaImport() {
  const langSel = langSelect('mi-lang');
  let langTouched = false;
  langSel.addEventListener('change', () => { langTouched = true; });
  const media = h('input', { type: 'file', class: 'input', accept: 'audio/*,video/*,.mp3,.m4a,.aac,.ogg,.opus,.wav,.flac,.mp4,.m4v,.webm,.mkv,.mov' });
  const timed = h('input', { type: 'file', class: 'input', accept: '.srt,.vtt,.lrc,.json,text/vtt,application/json' });
  const title = h('input', { class: 'input', dir: 'auto', placeholder: 'Taken from the file name' });
  const err = h('p', { class: 'error', role: 'alert' });
  const create = async () => {
    err.textContent = '';
    const tf = timed.files[0], mf = media.files[0];
    if (!tf) { err.textContent = 'Choose a subtitle or timing file.'; return; }
    let parsed;
    try { parsed = parseTimed(decodeBytes(await tf.arrayBuffer()), tf.name); }
    catch (e) { err.textContent = (e && e.message) || 'That file couldn’t be read.'; return; }
    const cues = parsed.cues.map(c => ({ ...c, t: cleanText(c.t, 'txt').replace(/\s*\n\s*/g, ' ') })).filter(c => c.t);
    if (!cues.length) { err.textContent = 'No timed lines were found in that file.'; return; }
    const code = !langTouched && parsed.lang && L(parsed.lang) ? parsed.lang : langSel.value;
    const text = cues.map(c => (c.gap ? '\n' : '') + c.t).join('\n');
    const name = title.value.trim() || parsed.title || (mf || tf).name.replace(/\.[^.]+$/, '');
    const meta = await createLesson(code, name, text, parsed.source || '');
    meta.cues = cues.map(c => [Math.round(c.s), Math.round(c.e)]);
    if (parsed.credit) meta.credit = String(parsed.credit).slice(0, 200);
    if (mf) {
      meta.media = mediaInfo(mf);
      const kept = await storeMedia(meta.id, mf);
      if (!kept) toast('The recording plays now, but this device can’t keep it. You’ll be asked for it again next time.');
    }
    putLesson(meta);
    closeModal();
    afterImport(code, [meta]);
  };
  openModal('Audio or video with subtitles', [
    h('p', { class: 'm-text muted' }, 'Choose a recording and its subtitles or timings. The helper script can fetch both from YouTube or Ganjoor.'),
    field('mi-lang', 'Language', langSel),
    field('mi-media', 'Audio or video file', media, 'Kept on this device only. Elsewhere you’ll be asked to choose it again.'),
    field('mi-timed', 'Subtitles or timings', timed, '.srt, .vtt or .lrc, or the .json file from the helper script.'),
    field('mi-title', 'Title', title),
    err,
    h('div', { class: 'm-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: create }, 'Create')),
  ], { wide: true });
}
async function setupPlayer(R) {
  const box = $('#player');
  if (!box) return;
  const blob = await getMedia(R.meta.id);
  if (UI.reader !== R || !document.body.contains(box)) return;
  box.replaceChildren();
  if (!blob) {
    const info = R.meta.media;
    const pick = h('input', { type: 'file', id: 'relink', class: 'input', accept: 'audio/*,video/*' });
    pick.addEventListener('change', async () => {
      const f = pick.files[0];
      if (!f) return;
      await storeMedia(R.meta.id, f);
      R.meta.media = mediaInfo(f);
      putLesson(R.meta);
      setupPlayer(R);
    });
    box.append(h('div', { class: 'relink' },
      h('label', { for: 'relink' }, info ? `Choose “${info.name}” to play along. Recordings stay on the device where you added them.` : 'Add the recording to play along with the text.'),
      pick));
    return;
  }
  const kind = (R.meta.media && R.meta.media.kind) || (/^video\//.test(blob.type) ? 'video' : 'audio');
  const url = URL.createObjectURL(blob);
  const el = h(kind, { controls: true, preload: 'metadata', playsinline: true, src: url });
  Object.assign(R, { el, url, cur: -1, loop: false, rate: 1 });
  el.addEventListener('timeupdate', () => onMediaTime(R));
  el.addEventListener('seeked', () => onMediaTime(R, true));
  const speed = h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Playback speed', onclick: () => {
    const rates = [1, 0.75, 0.5, 1.25];
    R.rate = rates[(rates.indexOf(R.rate) + 1) % rates.length];
    el.playbackRate = R.rate;
    speed.textContent = R.rate + '×';
  } }, '1×');
  const loop = h('button', { class: 'btn sm', type: 'button', 'aria-pressed': 'false', onclick: () => { R.loop = !R.loop; loop.setAttribute('aria-pressed', String(R.loop)); } }, icon('repeat'), 'Loop line');
  box.append(el, h('div', { class: 'pl-row' },
    h('button', { class: 'btn sm', type: 'button', onclick: () => seekCue(R, Math.max(0, R.cur)) }, icon('undo'), 'Replay line'),
    loop, speed,
    R.meta.credit ? h('span', { class: 'muted xs pl-credit', dir: 'auto' }, R.meta.credit) : null));
}
function cueIndexAt(cues, ms) {
  let lo = 0, hi = cues.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (cues[mid][0] <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
function onMediaTime(R, force) {
  if (UI.reader !== R || !R.el) return;
  const ms = R.el.currentTime * 1000;
  const cues = R.media.cues;
  if (R.loop && R.cur >= 0 && !R.el.paused && ms >= cues[R.cur][1] - 40) { R.el.currentTime = cues[R.cur][0] / 1000; return; }
  const i = cueIndexAt(cues, ms + 80);
  if (i === R.cur && !force) return;
  R.cur = i;
  for (const p of $$('#rtext p.now')) p.classList.remove('now');
  const p = i >= 0 ? $(`#rtext p[data-cue="${i}"]`) : null;
  if (p) {
    p.classList.add('now');
    if (!UI.sheet && !R.el.paused) p.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
function seekCue(R, i) {
  if (!R || !R.el) return;
  const c = R.media.cues[i];
  if (!c) return;
  R.el.currentTime = c[0] / 1000;
  R.el.play().catch(() => {});
}

/* ---------- the word panel ---------- */
function openSheet(ctx) {
  UI.sheet = ctx;
  $('#sheetWrap').hidden = false;
  document.body.classList.add('sheet-open');
  renderSheet();
}
function closeSheet() {
  if (!UI.sheet) return;
  commitSheet();
  const ctx = UI.sheet;
  UI.sheet = null;
  $('#sheetWrap').hidden = true;
  document.body.classList.remove('sheet-open');
  setSel([]);
  const R = UI.reader;
  if (R && R.resume && R.el) { R.resume = false; R.el.play().catch(() => {}); }
  if (ctx.onClose) ctx.onClose();
}
function readFields() {
  const g = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  return { m: g('f-m'), r: g('f-r'), n: g('f-n') };
}
function commitSheet() {
  const ctx = UI.sheet;
  if (!ctx || !document.getElementById('f-m')) return;
  const f = readFields();
  const e = entry(ctx.code, ctx.key);
  if (e && (e.m || '') === f.m && (e.r || '') === f.r && (e.n || '') === f.n) return;
  if (!e && !f.m && !f.r && !f.n) return;
  const patch = { ...f, ...contextPatch(ctx, e) };
  if ((!e || !e.s) && f.m) {
    patch.s = 1;
    if (S.settings.autoCard && !(e && e.c)) { Object.assign(patch, cardsFor(e, S.settings.reverse)); if (UI.reader) UI.reader.session.cards++; }
  }
  putEntry(ctx.code, ctx.key, patch);
  afterEntryChange(ctx);
}
function contextPatch(ctx, e) {
  const p = {};
  if (!e || !e.f) p.f = ctx.form;
  if ((!e || !e.x) && ctx.sentence) p.x = ctx.sentence.slice(0, 500);
  if ((!e || !e.o) && ctx.origin) p.o = ctx.origin;
  if (ctx.phrase) p.p = 1;
  return p;
}
function afterEntryChange(ctx) {
  if (UI.reader && UI.reader.lang.code === ctx.code) {
    if (ctx.phrase) { markPhrases(); refreshKeys(ctx.key.split(' ')); }
    else refreshKeys([ctx.key]);
  }
  updateBadge();
}
function setStatus(s) {
  const ctx = UI.sheet;
  if (!ctx) return;
  const f = readFields();
  const e = entry(ctx.code, ctx.key);
  if (s === 0) {
    if (f.m || f.r || f.n) putEntry(ctx.code, ctx.key, { ...f, s: 0, c: null, c2: null });
    else deleteEntry(ctx.code, ctx.key);
  } else if (s === 1) {
    const cards = (e && e.c) || S.settings.autoCard ? cardsFor(e, S.settings.reverse && !(e && e.c && !e.c2)) : { c: null, c2: null };
    if (cards.c && !(e && e.c) && UI.reader) UI.reader.session.cards++;
    putEntry(ctx.code, ctx.key, { ...f, ...contextPatch(ctx, e), s: 1, ...cards });
  } else {
    putEntry(ctx.code, ctx.key, { ...f, ...(ctx.phrase ? contextPatch(ctx, e) : {}), s, c: null, c2: null });
    if (s === 2 && (!e || e.s !== 2)) { bumpStat('k'); if (UI.reader) UI.reader.session.known++; }
  }
  afterEntryChange(ctx);
  renderSheet();
}
function addCard() {
  const ctx = UI.sheet;
  if (!ctx) return;
  const f = readFields();
  const e = entry(ctx.code, ctx.key);
  if (e && e.c) return;
  putEntry(ctx.code, ctx.key, { ...f, ...contextPatch(ctx, e), s: 1, ...cardsFor(e, S.settings.reverse) });
  if (UI.reader) UI.reader.session.cards++;
  afterEntryChange(ctx);
  renderSheet();
  toast('Added to your flashcards');
}
function removeCard() {
  const ctx = UI.sheet;
  const e = ctx && entry(ctx.code, ctx.key);
  if (!e || !(e.c || e.c2)) return;
  putEntry(ctx.code, ctx.key, { ...readFields(), c: null, c2: null });
  afterEntryChange(ctx);
  renderSheet();
}
function ttsVoice(lang) {
  if (!('speechSynthesis' in window) || !lang) return null;
  try {
    const want = (lang.tts || lang.code || '').toLowerCase();
    if (!want) return null;
    return speechSynthesis.getVoices().find(v => v.lang && (v.lang.toLowerCase() === want || v.lang.toLowerCase().startsWith(want + '-'))) || null;
  } catch { return null; }
}
function speak(text, lang) {
  const v = ttsVoice(lang);
  if (!v) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = v; u.lang = v.lang;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { }
}
function markInSentence(sentence, form) {
  const i = form ? sentence.indexOf(form) : -1;
  if (i < 0) return [sentence];
  return [sentence.slice(0, i), h('mark', null, form), sentence.slice(i + form.length)];
}
function renderSheet() {
  const ctx = UI.sheet;
  if (!ctx) return;
  const lang = langOrStub(ctx.code);
  const e = entry(ctx.code, ctx.key);
  const st = e ? e.s || 0 : 0;
  const sh = $('#sheet');
  // keep whatever is being typed across re-renders of the same word
  const same = sh.__ctx === ctx && sh.__key === ctx.key;
  const prevVals = same && document.getElementById('f-m') ? readFields() : null;
  const val = (k) => prevVals && prevVals[k] !== (e ? e[k] || '' : '') ? prevVals[k] : (e ? e[k] || '' : '');
  sh.__ctx = ctx; sh.__key = ctx.key;
  sh.replaceChildren();
  const voice = ttsVoice(lang);
  sh.append(
    h('div', { class: 'grab', 'aria-hidden': 'true' }),
    h('div', { class: 'sh-head' },
      h('div', { class: 'sh-word', dir: 'auto', lang: ctx.code }, ctx.form),
      ctx.phrase ? h('span', { class: 'chip' }, 'phrase') : null,
      voice ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Listen', onclick: () => speak(ctx.form, lang) }, icon('speaker')) : null,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => closeSheet() }, icon('close'))));
  if (e && e.r && !ctx.phrase) sh.append(h('p', { class: 'sh-root', dir: 'auto' }, 'from ', h('span', { lang: ctx.code }, e.r)));
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Word status' },
    [['New', 0, 's-new'], ['Learning', 1, 's-learn'], ['Known', 2, 's-known'], ['Ignore', 3, 's-ign']].map(([label, s, cls]) =>
      h('button', { type: 'button', class: cls, 'aria-pressed': String(st === s), onclick: () => setStatus(s) }, label)));
  sh.append(seg);
  const meaning = h('textarea', { id: 'f-m', class: 'input', rows: 2, dir: 'auto', placeholder: 'Meaning, in your own words', value: val('m') });
  meaning.addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commitSheet(); renderSheet(); toast('Saved'); } });
  sh.append(h('div', { class: 'field tight' }, h('label', { for: 'f-m', class: 'vh' }, 'Meaning'), meaning));
  const sugg = h('div', { class: 'sugg', id: 'f-sugg', 'aria-live': 'polite' });
  if (ctx.ai) drawSuggestion(sugg, ctx.ai);
  sh.append(sugg);
  const aiOn = Cloud.sample && S.settings.ai;
  const row = h('div', { class: 'sh-row' });
  if (aiOn) row.append(h('button', { class: 'btn sm', type: 'button', id: 'ai-btn', onclick: aiSuggest }, icon('sparkle'), 'Ask Claude'));
  if (!(e && (e.c || e.c2))) row.append(h('button', { class: 'btn sm primary', type: 'button', onclick: addCard }, icon('plus'), S.settings.reverse ? 'Add flashcards' : 'Add flashcard'));
  else {
    const info = (c, label) => c ? h('span', { class: 'card-info' }, icon('cards'), `${label}: ${c.q ? relDue(c.due) : 'new'}`) : null;
    row.append(info(e.c, 'word → meaning'), info(e.c2, 'meaning → word'),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: removeCard }, e.c && e.c2 ? 'Remove cards' : 'Remove card'));
  }
  sh.append(row);
  const root = h('input', { id: 'f-r', class: 'input', dir: 'auto', lang: ctx.code, placeholder: 'Dictionary form', value: val('r') });
  const notes = h('textarea', { id: 'f-n', class: 'input', rows: 2, dir: 'auto', placeholder: 'Grammar, usage, mnemonics', value: val('n') });
  const more = h('details', { class: 'sh-more' }, h('summary', null, 'Root and notes'),
    h('div', { class: 'field tight' }, h('label', { for: 'f-r' }, 'Root or dictionary form'), root),
    h('div', { class: 'field tight' }, h('label', { for: 'f-n' }, 'Notes'), notes));
  if (val('r') || val('n') || ctx.moreOpen) more.open = true;
  more.addEventListener('toggle', () => { ctx.moreOpen = more.open; });
  sh.append(more);
  const sentence = ctx.sentence || (e && e.x) || '';
  if (sentence) {
    const tr = h('div', { class: 'tr-out', id: 'f-tr', dir: 'auto', 'aria-live': 'polite' }, ctx.tr || '');
    sh.append(h('div', { class: 'sh-sent' },
      h('p', { dir: 'auto', lang: ctx.code }, markInSentence(sentence, ctx.form)),
      aiOn ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => aiTranslate(sentence) }, icon('sparkle'), 'Translate this sentence') : null,
      tr));
  }
  if (ctx.range && UI.reader) {
    const R = UI.reader;
    const [a] = ctx.range;
    const sp = R.flat[ctx.anchor];
    const phs = sp && sp.dataset.ph && !ctx.phrase ? sp.dataset.ph : null;
    sh.append(h('div', { class: 'sh-phrase' },
      h('span', { class: 'muted sm' }, 'Phrase'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => extendPhrase(-1) }, '+ word before'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => extendPhrase(1) }, '+ word after'),
      ctx.phrase ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => extendPhrase(0) }, 'Single word') : null,
      phs ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => openSavedPhrase(sp) }, 'Open saved phrase') : null));
  }
  const q = (val('r') && !ctx.phrase) ? val('r') : ctx.form;
  const lookup = lang.marks ? q.replace(AR_MARKS, '') : q;
  if (lang.dicts && lang.dicts.length) {
    sh.append(h('div', { class: 'dicts' },
      h('span', { class: 'muted sm' }, 'Look up'),
      lang.dicts.map(d => h('a', { class: 'dict', href: dictUrl(d.u, lookup), target: '_blank', rel: 'noopener noreferrer' }, d.n))));
  }
}
function openSavedPhrase(sp) {
  const R = UI.reader;
  const key = sp.dataset.ph;
  const a = +sp.dataset.phs;
  const n = key.split(' ').length;
  commitSheet();
  setRange(a, a + n - 1);
}
function extendPhrase(dir) {
  const ctx = UI.sheet;
  const R = UI.reader;
  if (!ctx || !ctx.range || !R) return;
  commitSheet();
  let [a, b] = ctx.range;
  if (dir > 0) { if (b + 1 >= R.flat.length || b - a >= 7 || R.flat[b + 1].dataset.p !== R.flat[b].dataset.p) return; b++; }
  else if (dir < 0) { if (a - 1 < 0 || b - a >= 7 || R.flat[a - 1].dataset.p !== R.flat[a].dataset.p) return; a--; }
  else { a = b = ctx.anchor; }
  setRange(a, b);
}
function setRange(a, b) {
  const ctx = UI.sheet;
  const R = UI.reader;
  const spans = R.flat.slice(a, b + 1);
  const toks = spans.map(tokOf);
  ctx.range = [a, b];
  ctx.ai = null; ctx.tr = null;
  if (a === b) { ctx.phrase = false; ctx.key = toks[0].k; ctx.form = toks[0].s; }
  else {
    ctx.phrase = true;
    ctx.key = toks.map(t => t.k).join(' ');
    const para = R.paras[+spans[0].dataset.p];
    ctx.form = para.toks.slice(+spans[0].dataset.i, +spans[spans.length - 1].dataset.i + 1).map(t => t.s).join('').replace(/\s+/g, ' ').trim();
  }
  setSel(spans);
  renderSheet();
}

/* ---------- Claude ---------- */
function aiTier() { return S.settings.aiTier === 'thorough' ? 'default' : 'quick'; }
function aiErrorText(e) {
  const c = e && e.code;
  if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(c)) {
    Cloud.sample = null; Cloud.imageOCR = false;
    setTimeout(() => UI.capsChanged(), 0);
    return 'Claude isn’t available here.';
  }
  if (c === 'images_unavailable') { Cloud.imageOCR = false; return 'Sending images to Claude isn’t available here.'; }
  if (c === 'rate_limited') return 'Claude is busy or you’ve reached a usage limit. Try again later.';
  if (c === 'session_expired') return 'Sign in to Claude again, then retry.';
  if (c === 'invalid_json') return 'Claude’s answer came back in the wrong shape. Try again.';
  if (c === 'refused') return 'Claude declined this one.';
  if (c === 'prompt_too_large') return 'That was too much to send at once.';
  if (c === 'image_rejected') return 'That image couldn’t be used. Try a smaller or clearer photo.';
  if (c === 'cancelled') return '';
  return 'Couldn’t reach Claude. Try again.';
}
function wordPrompt(lang, form, sentence) {
  return [
    `You are a concise bilingual dictionary helping someone read ${lang.name} (language code ${lang.code}).`,
    `Explain the word or phrase «${form}» as it is used in this sentence:`,
    `«${(sentence || form).slice(0, 600)}»`,
    '',
    'Reply with only a JSON object: {"meaning": string, "root": string, "notes": string}.',
    `- meaning: a short gloss in ${lang.gloss || 'English'} that fits this context (1–8 words; add a second sense after "; " only if it helps).`,
    '- root: the dictionary form or lemma, in the same script as the word, or "" if it already is the dictionary form.',
    '- notes: at most 25 words of useful grammar (tense, person, case, ezafe, clitics, compound parts, sandhi), or "".',
    'If the language is poorly documented and you are unsure, give your best guess and begin notes with "Unsure:".',
  ].join('\n');
}
async function aiSuggest() {
  const ctx = UI.sheet;
  if (!ctx || !Cloud.sample) return;
  const lang = langOrStub(ctx.code);
  const btn = $('#ai-btn');
  const box = $('#f-sugg');
  if (btn) btn.disabled = true;
  if (box) box.replaceChildren(h('p', { class: 'muted sm thinking' }, 'Asking Claude…'));
  try {
    const r = await Cloud.sample.json(wordPrompt(lang, ctx.form, ctx.sentence), { modelTier: aiTier(), cache: { gcTime: 86400000 } });
    if (UI.sheet !== ctx) return;
    ctx.ai = {
      meaning: String((r && r.meaning) || '').trim(),
      root: String((r && r.root) || '').trim(),
      notes: String((r && r.notes) || '').trim(),
    };
    drawSuggestion($('#f-sugg'), ctx.ai);
  } catch (e) {
    if (UI.sheet !== ctx) return;
    const msg = aiErrorText(e);
    const b = $('#f-sugg');
    if (b) b.replaceChildren(msg ? h('p', { class: 'error sm' }, msg) : '');
  } finally {
    const b2 = $('#ai-btn');
    if (b2) b2.disabled = false;
  }
}
function drawSuggestion(box, ai) {
  if (!box) return;
  const use = () => {
    const m = $('#f-m'), r = $('#f-r'), n = $('#f-n');
    if (m && !m.value.trim()) m.value = ai.meaning;
    if (r && !r.value.trim() && ai.root) r.value = ai.root;
    if (n && !n.value.trim() && ai.notes) n.value = ai.notes;
    commitSheet();
    UI.sheet.ai = null;
    renderSheet();
  };
  box.replaceChildren(h('div', { class: 'ai-card' },
    h('div', { class: 'ai-main' },
      h('span', { class: 'ai-m', dir: 'auto' }, ai.meaning || '—'),
      ai.root ? h('span', { class: 'ai-r', dir: 'auto' }, ai.root) : null),
    ai.notes ? h('p', { class: 'ai-n', dir: 'auto' }, ai.notes) : null,
    h('div', { class: 'ai-act' },
      h('button', { class: 'btn sm primary', type: 'button', onclick: use }, 'Use this'),
      h('span', { class: 'muted xs' }, 'Suggested by Claude · check it against a dictionary'))));
}
async function aiTranslate(sentence) {
  const ctx = UI.sheet;
  if (!ctx || !Cloud.sample) return;
  const lang = langOrStub(ctx.code);
  const out = $('#f-tr');
  if (out) out.textContent = 'Translating…';
  const prompt = `Translate this ${lang.name} sentence into ${lang.gloss || 'English'}. Then give a short word-by-word breakdown, one line per word, as "word — gloss (grammar)". Plain text only, no headings.\n\n«${sentence.slice(0, 800)}»`;
  try {
    const r = await Cloud.sample(prompt, { modelTier: aiTier(), onText: ({ text }) => { if (UI.sheet === ctx) { const o = $('#f-tr'); if (o) o.textContent = text; } } });
    if (UI.sheet === ctx) { ctx.tr = r.text; const o = $('#f-tr'); if (o) o.textContent = r.text; }
  } catch (e) {
    if (UI.sheet === ctx) { const o = $('#f-tr'); if (o) o.textContent = (e && e.text) || aiErrorText(e); }
  }
}

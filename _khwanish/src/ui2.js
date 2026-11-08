/* =====================================================================
   Khwānish · interface: review, words, Anki export, options, start-up
   ===================================================================== */
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const scopeCodes = scope => scope === 'all' ? S.settings.langs.map(l => l.code) : [S.settings.cur];
const newLeft = () => Math.max(0, S.settings.newPerDay + (today().x || 0) - (today().n || 0));

/* ---------- review ---------- */
// A word's two cards are kept apart: once one was studied today, the other waits for another day.
function pickNext(scope, avoid) {
  const now = Date.now(), day0 = dayStart(now);
  let learn = null, learnDue = Infinity, ahead = null, aheadDue = Infinity;
  const reviews = [], fresh = [];
  for (const c of scopeCodes(scope)) {
    if (!S.loaded.has(c)) continue;
    for (const [k, e] of vmap(c)) {
      if (e.d || e.s !== 1) continue;
      if (avoid && avoid.code === c && avoid.key === k) continue;
      for (const d of [1, 2]) {
        const card = cardOf(e, d);
        if (!card || (d === 2 && !e.m)) continue;
        const sib = cardOf(e, d === 1 ? 2 : 1);
        const sibToday = sib && sib.lr >= day0;
        const it = { code: c, key: k, d };
        if (!card.q) { if (!sibToday && !(d === 2 && sib && !sib.q)) fresh.push([e.a || card.due || 0, d, it]); }
        else if (card.q === 2) { if (card.due <= now && !sibToday) reviews.push([card.due, hash32(k) + d, it]); }
        else if (card.due <= now) { if (card.due < learnDue) { learn = it; learnDue = card.due; } }
        else if (card.due < aheadDue) { ahead = it; aheadDue = card.due; }
      }
    }
  }
  if (learn) return learn;
  if (reviews.length) { reviews.sort((a, b) => a[0] - b[0] || a[1] - b[1]); return reviews[0][2]; }
  if (fresh.length && newLeft() > 0) { fresh.sort((a, b) => a[0] - b[0] || a[1] - b[1]); return fresh[0][2]; }
  if (ahead && aheadDue - now < 20 * MIN) return ahead;
  return null;
}
function nextDueInfo(scope) {
  let next = Infinity;
  for (const c of scopeCodes(scope)) {
    if (!S.loaded.has(c)) continue;
    for (const e of vmap(c).values()) {
      if (e.d || e.s !== 1) continue;
      for (const card of [e.c, e.m ? e.c2 : null]) if (card && card.q && card.due > Date.now()) next = Math.min(next, card.due);
    }
  }
  return next === Infinity ? null : next;
}
function viewReview() {
  const R = UI.review || (UI.review = { scope: S.settings.scope || 'lang', cur: null, shown: false, undo: null });
  const missing = scopeCodes(R.scope).filter(c => !S.loaded.has(c) || (Cloud.state === 'ready' && !S.cloudLoaded.has(c)));
  if (missing.length) Promise.all(missing.map(ensureLang)).then(() => { if (UI.route === 'review' && !UI.review.shown) { UI.review.cur = null; drawReview(); } updateBadge(); });
  if (R.cur) { const e = entry(R.cur.code, R.cur.key); if (!e || e.s !== 1 || !cardOf(e, R.cur.d)) R.cur = null; }
  drawReview();
}
function setScope(s) {
  const R = UI.review;
  R.scope = s; R.cur = null; R.shown = false;
  setSettings({ scope: s });
  viewReview();
  updateBadge();
}
function countChip(label, n, cls) { return h('span', { class: 'cchip ' + cls }, h('b', null, fmtNum(n)), ' ', label); }
function drawReview() {
  const R = UI.review;
  const v = $('#view');
  v.replaceChildren();
  if (!R.cur) { R.cur = pickNext(R.scope); R.shown = false; }
  const q = queueInfo(R.scope);
  v.append(h('div', { class: 'rv-head' },
    h('div', { class: 'seg2', role: 'group', 'aria-label': 'Cards to review' },
      h('button', { type: 'button', 'aria-pressed': String(R.scope === 'lang'), onclick: () => setScope('lang') }, L().name),
      h('button', { type: 'button', 'aria-pressed': String(R.scope === 'all'), onclick: () => setScope('all') }, 'All languages')),
    h('div', { class: 'counts' }, countChip('new', q.fresh, 'c-new'), countChip('learning', q.learn, 'c-learn'), countChip('to review', q.rev, 'c-rev'))));
  if (!R.cur) {
    const next = nextDueInfo(R.scope);
    const d = today();
    const more = q.freshTotal > q.fresh;
    v.append(h('div', { class: 'rv-done' },
      h('p', { class: 'rv-done-big' }, 'All caught up'),
      h('p', null, next ? `The next card is ${relDue(next)}.` : 'Add flashcards while you read and they’ll show up here.'),
      d.r ? h('p', { class: 'muted' }, `${fmtNum(d.r)} reviews today.`) : null,
      more ? h('p', { class: 'muted' }, `You’ve met today’s limit of ${S.settings.newPerDay} new cards.`) : null,
      h('div', { class: 'actions center' },
        more ? h('button', { class: 'btn', type: 'button', onclick: () => { bumpStat('x', 10); R.cur = null; drawReview(); updateBadge(); } }, 'Study 10 more new cards') : null,
        h('a', { class: 'btn primary', href: '#library' }, 'Back to reading'))));
    if (R.undo) v.append(h('div', { class: 'actions center' }, h('button', { class: 'btn ghost', type: 'button', onclick: undoReview }, icon('undo'), 'Undo last answer')));
    return;
  }
  const it = R.cur;
  const e = entry(it.code, it.key);
  const cardState = cardOf(e, it.d);
  const lang = langOrStub(it.code);
  const form = e.f || it.key;
  const rev = it.d === 2;
  const sent = e.x ? h('p', { class: 'rv-sent', dir: 'auto', lang: it.code }, markInSentence(e.x, e.f || '')) : null;
  const tags = h('div', { class: 'rv-tags' },
    R.scope === 'all' ? h('span', { class: 'chip' }, lang.name) : null,
    h('span', { class: 'chip' }, rev ? 'meaning → word' : 'word → meaning'),
    e.p ? h('span', { class: 'chip' }, 'phrase') : null,
    !cardState.q ? h('span', { class: 'chip new' }, 'new') : null);
  const card = rev
    ? h('div', { class: 'rv-card' + (R.shown ? ' shown' : '') }, tags,
        h('div', { class: 'rv-m big', dir: 'auto' }, e.m || ''))
    : h('div', { class: 'rv-card' + (R.shown ? ' shown' : '') }, tags,
        h('div', { class: 'rv-word', dir: 'auto', lang: it.code }, form),
        S.settings.frontSentence ? sent : null);
  if (R.shown) {
    card.append(rev
      ? h('div', { class: 'rv-back' },
          h('div', { class: 'rv-word', dir: 'auto', lang: it.code }, form),
          e.r ? h('p', { class: 'rv-r', dir: 'auto' }, 'from ', h('span', { lang: it.code }, e.r)) : null,
          sent,
          e.n ? h('p', { class: 'rv-n', dir: 'auto' }, e.n) : null,
          e.o ? h('p', { class: 'rv-o', dir: 'auto' }, e.o) : null)
      : h('div', { class: 'rv-back' },
          h('div', { class: 'rv-m', dir: 'auto' }, e.m || h('span', { class: 'muted' }, 'No meaning saved yet. Tap Edit to add one.')),
          e.r ? h('p', { class: 'rv-r', dir: 'auto' }, 'from ', h('span', { lang: it.code }, e.r)) : null,
          e.n ? h('p', { class: 'rv-n', dir: 'auto' }, e.n) : null,
          !S.settings.frontSentence ? sent : null,
          e.o ? h('p', { class: 'rv-o', dir: 'auto' }, e.o) : null));
  }
  v.append(card);
  if (!R.shown) {
    v.append(h('button', { class: 'btn primary big reveal', type: 'button', autofocus: true, onclick: () => { R.shown = true; drawReview(); } }, 'Show answer'));
  } else {
    const pv = FSRS.preview(cardState, Date.now(), { ret: S.settings.retention, maxIvl: S.settings.maxIvl });
    v.append(h('div', { class: 'grades' },
      [['Again', 1, 'again'], ['Hard', 2, 'hard'], ['Good', 3, 'good'], ['Easy', 4, 'easy']].map(([l, g, c]) =>
        h('button', { class: 'grade ' + c, type: 'button', onclick: () => answer(g) }, h('span', null, l), h('small', null, fmtIvl(pv[g]))))));
  }
  const voice = ttsVoice(lang);
  v.append(h('div', { class: 'rv-sub' },
    R.undo ? h('button', { class: 'btn ghost sm', type: 'button', onclick: undoReview }, icon('undo'), 'Undo') : null,
    voice && (!rev || R.shown) ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => speak(form, lang) }, icon('speaker'), 'Listen') : null,
    h('button', { class: 'btn ghost sm', type: 'button', onclick: editCurrent }, 'Edit'),
    h('button', { class: 'btn ghost sm', type: 'button', onclick: knownCurrent }, 'I know this')));
}
function answer(g) {
  const R = UI.review;
  const it = R.cur;
  const e = it && entry(it.code, it.key);
  const cur = cardOf(e, it.d);
  if (!cur) { R.cur = null; drawReview(); return; }
  const wasNew = !cur.q;
  R.undo = { it, prev: JSON.parse(JSON.stringify(e)), wasNew };
  const next = FSRS.answer(cur, g, Date.now(), { ret: S.settings.retention, maxIvl: S.settings.maxIvl, fuzz: true });
  putEntry(it.code, it.key, it.d === 2 ? { c2: next } : { c: next });
  bumpStat('r');
  if (wasNew) bumpStat('n');
  R.cur = pickNext(R.scope, it) || pickNext(R.scope);
  R.shown = false;
  drawReview();
  updateBadge();
}
function undoReview() {
  const R = UI.review;
  const u = R.undo;
  if (!u) return;
  restoreEntry(u.it.code, u.it.key, u.prev);
  bumpStat('r', -1);
  if (u.wasNew) bumpStat('n', -1);
  R.cur = u.it; R.shown = false; R.undo = null;
  drawReview();
  updateBadge();
}
function editCurrent() {
  const R = UI.review;
  const it = R.cur;
  const e = it && entry(it.code, it.key);
  if (!e) return;
  openSheet({ code: it.code, key: it.key, form: e.f || it.key, sentence: e.x || '', origin: e.o, range: null, phrase: !!e.p,
    onClose: () => { if (UI.route === 'review') { const x = entry(it.code, it.key); if (!x || !cardOf(x, it.d) || x.s !== 1 || (it.d === 2 && !x.m)) R.cur = null; drawReview(); updateBadge(); } } });
}
function knownCurrent() {
  const R = UI.review;
  const it = R.cur;
  if (!it) return;
  const prev = entry(it.code, it.key);
  putEntry(it.code, it.key, { s: 2, c: null, c2: null });
  bumpStat('k');
  R.undo = null;
  R.cur = pickNext(R.scope); R.shown = false;
  drawReview(); updateBadge();
  toast('Marked as known', 'Undo', () => { restoreEntry(it.code, it.key, prev ? { ...prev } : null); bumpStat('k', -1); R.cur = it; R.shown = false; if (UI.route === 'review') drawReview(); updateBadge(); });
}
function reviewKey(e) {
  const R = UI.review;
  if (!R || UI.sheet) return;
  const k = e.key;
  if (k === 'u' || k === 'U') { undoReview(); e.preventDefault(); return; }
  if (!R.cur) return;
  if (k === ' ' || k === 'Enter') { if (!R.shown) { R.shown = true; drawReview(); } else answer(3); e.preventDefault(); }
  else if (R.shown && ['1', '2', '3', '4'].includes(k)) { answer(+k); e.preventDefault(); }
  else if (k === 'e' || k === 'E') { editCurrent(); e.preventDefault(); }
}

/* ---------- words ---------- */
function viewWords() {
  const lang = L();
  const code = lang.code;
  const W = UI.words;
  if (!S.loaded.has(code) || (Cloud.state === 'ready' && !S.cloudLoaded.has(code))) ensureLang(code).then(() => { if (UI.route === 'words') drawList(); });
  const v = $('#view');
  v.replaceChildren();
  const q = h('input', { type: 'search', id: 'w-q', class: 'input', placeholder: 'Search words or meanings', value: W.q, dir: 'auto', 'aria-label': 'Search words' });
  q.addEventListener('input', debounce(() => { W.q = q.value; W.limit = 200; drawList(); }, 200));
  const st = selectEl([['learning', 'Learning'], ['known', 'Known'], ['ignored', 'Ignored'], ['all', 'All saved']], W.st, x => { W.st = x; W.limit = 200; drawList(); });
  st.id = 'w-st'; st.setAttribute('aria-label', 'Status');
  const sort = selectEl([['recent', 'Recently changed'], ['alpha', 'A to Z'], ['due', 'Next due']], W.sort, x => { W.sort = x; drawList(); });
  sort.id = 'w-sort'; sort.setAttribute('aria-label', 'Sort');
  v.append(
    h('h2', { class: 'sec first' }, `${lang.name} words`),
    h('div', { class: 'wfilters' }, q, st, sort, checkRow('w-c', 'Flashcards only', W.cards, x => { W.cards = x; drawList(); })),
    h('p', { class: 'muted sm', id: 'w-count', role: 'status' }),
    h('div', { class: 'wlist', id: 'wlist' }),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: openExport }, 'Export to Anki'),
      h('button', { class: 'btn', type: 'button', onclick: () => openWordImport() }, 'Import a word list'),
      ACCT ? h('button', { class: 'btn', type: 'button', onclick: shareWords }, 'Share a word list') : null));
  drawList();
}
function drawList() {
  const code = S.settings.cur;
  const W = UI.words;
  const list = $('#wlist');
  if (!list) return;
  const term = W.q.trim().toLowerCase();
  const items = [];
  for (const [k, e] of vmap(code)) {
    if (e.d) continue;
    if (W.st === 'learning' && e.s !== 1) continue;
    if (W.st === 'known' && e.s !== 2) continue;
    if (W.st === 'ignored' && e.s !== 3) continue;
    if (W.st === 'all' && !e.s && !e.m) continue;
    if (W.cards && !e.c && !e.c2) continue;
    if (term && !(k.includes(term) || (e.f || '').toLowerCase().includes(term) || (e.m || '').toLowerCase().includes(term))) continue;
    items.push([k, e]);
  }
  if (W.sort === 'alpha') { const coll = new Intl.Collator(code); items.sort((a, b) => coll.compare(a[1].f || a[0], b[1].f || b[0])); }
  else if (W.sort === 'due') { const due = e => Math.min((e.c && e.c.q && e.c.due) || Infinity, (e.c2 && e.c2.q && e.c2.due) || Infinity); items.sort((a, b) => due(a[1]) - due(b[1])); }
  else items.sort((a, b) => (b[1].u || 0) - (a[1].u || 0));
  const cnt = $('#w-count');
  if (cnt) cnt.textContent = `${fmtNum(items.length)} word${items.length === 1 ? '' : 's'}`;
  list.replaceChildren(...items.slice(0, W.limit).map(([k, e]) => wordRow(code, k, e)));
  if (items.length > W.limit) list.append(h('button', { class: 'btn ghost', type: 'button', onclick: () => { W.limit += 300; drawList(); } }, `Show ${fmtNum(Math.min(300, items.length - W.limit))} more`));
  if (!items.length) list.append(h('p', { class: 'empty' }, term ? 'No saved words match that search.' : 'Nothing here yet. Tap words while you read to save them.'));
}
function wordRow(code, k, e) {
  const cards = [e.c, e.m ? e.c2 : null].filter(Boolean);
  const started = cards.filter(c => c.q);
  const label = e.s === 1 ? (cards.length ? (started.length ? relDue(Math.min(...started.map(c => c.due))) : 'new card') : 'learning') : e.s === 2 ? 'known' : e.s === 3 ? 'ignored' : 'new';
  return h('button', { class: 'wrow', type: 'button', onclick: () => openWordSheet(code, k) },
    h('span', { class: 'wf', dir: 'auto', lang: code }, e.f || k),
    h('span', { class: 'wm', dir: 'auto' }, e.m || ''),
    h('span', { class: 'wst s' + (e.s || 0) }, label));
}
function openWordSheet(code, k) {
  const e = entry(code, k);
  if (!e) return;
  openSheet({ code, key: k, form: e.f || k, sentence: e.x || '', origin: e.o, range: null, phrase: !!e.p,
    onClose: () => { if (UI.route === 'words') drawList(); } });
}

/* ---------- Anki export ---------- */
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function markHtml(sentence, form) {
  const i = form ? sentence.indexOf(form) : -1;
  if (i < 0) return escHtml(sentence);
  return escHtml(sentence.slice(0, i)) + '<b>' + escHtml(form) + '</b>' + escHtml(sentence.slice(i + form.length));
}
function exportRows(st) {
  const rows = [];
  for (const code of scopeCodes(st.scope)) {
    for (const [k, e] of vmap(code)) {
      if (e.d) continue;
      if (st.which === 'cards' && !((e.c || e.c2) && e.s === 1)) continue;
      if (st.which === 'learning' && e.s !== 1) continue;
      if (st.which === 'meaning' && !e.m) continue;
      if (st.onlyNew && e.ex) continue;
      rows.push([code, k, e]);
    }
  }
  return rows;
}
function buildAnki(rows, st, deck) {
  const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""').replace(/\r?\n/g, '<br>').replace(/\t/g, ' ') + '"';
  const guid = noteGuid;
  const lines = ['#separator:tab', '#html:true'];
  if (st.fmt === 'basic') lines.push(st.rev ? '#notetype:Basic (and reversed card)' : '#notetype:Basic');
  if (deck) lines.push('#deck:' + deck.replace(/[\t\n]/g, ' '));
  if (st.fmt === 'basic') { lines.push('#guid column:1', '#tags column:4', '#columns:GUID\tFront\tBack\tTags'); }
  else { lines.push('#guid column:1', '#tags column:9', '#columns:GUID\tTerm\tMeaning\tRoot\tNotes\tSentence\tSource\tLanguage\tTags'); }
  for (const [code, k, e] of rows) {
    const lang = langOrStub(code);
    const form = e.f || k;
    const tags = `khwanish lang::${code}`;
    if (st.fmt === 'basic') {
      let front = `<div dir="auto" lang="${escHtml(code)}" style="font-size:1.7em">${escHtml(form)}</div>`;
      const sentHtml = e.x ? `<div dir="auto" lang="${escHtml(code)}" style="font-size:0.95em;opacity:.8;margin-top:.6em">${markHtml(e.x, e.f || '')}</div>` : '';
      if (st.sent) front += sentHtml;
      let back = `<div dir="auto" style="font-size:1.3em">${escHtml(e.m || '')}</div>`;
      if (e.r) back += `<div dir="auto" style="opacity:.75;margin-top:.4em">from <span lang="${escHtml(code)}">${escHtml(e.r)}</span></div>`;
      if (e.n) back += `<div dir="auto" style="margin-top:.4em">${escHtml(e.n)}</div>`;
      if (!st.sent && sentHtml) back += sentHtml;
      if (e.o) back += `<div dir="auto" style="opacity:.6;font-size:.8em;margin-top:.6em">${escHtml(e.o)}</div>`;
      lines.push([q(guid(code, k)), q(front), q(back), q(tags)].join('\t'));
    } else {
      lines.push([guid(code, k), escHtml(form), escHtml(e.m || ''), escHtml(e.r || ''), escHtml(e.n || ''), e.x ? markHtml(e.x, e.f || '') : '', escHtml(e.o || ''), escHtml(lang.name), tags].map(q).join('\t'));
    }
  }
  return lines.join('\n') + '\n';
}
async function saveFile(filename, data, what, quiet) {
  const dl = Cloud.downloads;
  if (dl) {
    try { await dl.save({ filename, data }); if (!quiet) toast(`Saved ${filename}`); return true; }
    catch (e) {
      const c = e && e.code;
      if (c === 'declined') return false;
      if (c === 'rate_limited') { toast('Another save is still waiting. Try again in a moment.'); return false; }
    }
  }
  if (typeof data !== 'string') { toast('Saving files isn’t available here.'); return false; }
  showCopyBox(what || filename, data);
  return null;
}
function showCopyBox(title, text) {
  const ta = h('textarea', { class: 'input mono', rows: 12, readonly: true, value: text, 'aria-label': 'File contents' });
  openModal(title, [
    h('p', { class: 'm-text muted' }, 'Saving files isn’t available here. Copy the text below and save it as a file yourself.'),
    ta,
    h('div', { class: 'm-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied'); }
      catch { ta.focus(); ta.select(); toast('Select the text and copy it'); }
    } }, 'Copy')),
  ], { wide: true });
}
async function openExport() {
  const st = { scope: 'lang', which: 'cards', onlyNew: true, fmt: 'basic', sent: true, mark: true, file: Cloud.downloads ? 'apkg' : 'txt', rev: S.settings.reverse };
  await Promise.all(S.settings.langs.map(l => ensureLang(l.code)));
  const deck = h('input', { class: 'input', value: `Khwānish::${L().name}` });
  const status = h('p', { class: 'm-text', role: 'status' });
  const upd = () => {
    const n = exportRows(st).length;
    status.textContent = n ? `${fmtNum(n)} word${n === 1 ? '' : 's'} will be exported.` : 'Nothing matches these choices.';
  };
  const radios = (name, opts, key) => h('fieldset', { class: 'radios' }, h('legend', null, name),
    opts.map(([v, label]) => {
      const id = `ex-${key}-${v}`;
      return h('div', { class: 'radio' },
        h('input', { type: 'radio', name: 'ex-' + key, id, value: v, checked: st[key] === v, onchange: () => { st[key] = v; if (key === 'scope') deck.value = v === 'all' ? 'Khwānish' : `Khwānish::${L().name}`; upd(); } }),
        h('label', { for: id }, label));
    }));
  const finish = async how => {
    const rows = exportRows(st);
    if (!rows.length) { upd(); return; }
    if (st.file === 'apkg' && how !== 'copy') {
      const base = deck.value.trim() || 'Khwānish';
      status.textContent = 'Packing your cards…';
      let pack;
      try { pack = await buildApkg(rows, code => st.scope === 'all' ? `${base}::${langOrStub(code).name}` : base, st.rev); }
      catch (e) { status.textContent = (e && e.message) || 'Couldn’t build the Anki package.'; return; }
      // Claude's file saver only takes certain extensions, so there the package goes out as .apkg.zip
      const name = `khwanish-${st.scope === 'all' ? 'all' : S.settings.cur}-${dayKey()}.apkg${Cloud.plainFiles ? '' : '.zip'}`;
      const ok = await saveFile(name, pack.blob, 'Anki package', true);
      if (!ok) { upd(); return; }
      if (st.mark) { const now = Date.now(); for (const [code, k] of rows) putEntry(code, k, { ex: now }); }
      openModal('Anki package saved', [
        h('p', { class: 'm-text' }, `${fmtNum(pack.cards)} card${pack.cards === 1 ? '' : 's'} with ${fmtNum(pack.reviews)} past review${pack.reviews === 1 ? '' : 's'}, in “${name}”.`),
        h('ol', { class: 'steps' },
          Cloud.plainFiles ? null : h('li', null, 'Rename the file to remove “.zip” from the end, so it ends in .apkg. (If your computer unzipped it, rename the original .zip file instead.)'),
          h('li', null, 'Open it with Anki: File › Import on a computer, or open the file in AnkiMobile or AnkiDroid.'),
          h('li', null, 'Keep “Import any learning progress” ticked so the schedule and history come across. Turn on FSRS in Anki’s deck options to keep the same scheduling.')),
        h('div', { class: 'm-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => closeModal() }, 'Done')),
      ]);
      return;
    }
    const txt = buildAnki(rows, st, deck.value.trim());
    let ok;
    if (how === 'copy') {
      try { await navigator.clipboard.writeText(txt); ok = true; toast('Copied. In Anki: File › Import, then paste into a .txt file first.'); }
      catch { showCopyBox('Anki export', txt); ok = null; }
    } else ok = await saveFile(`khwanish-${st.scope === 'all' ? 'all' : S.settings.cur}-${dayKey()}.txt`, txt, 'Anki export');
    if (ok !== false && st.mark) {
      const now = Date.now();
      for (const [code, k] of rows) putEntry(code, k, { ex: now });
    }
    if (ok) closeModal();
  };
  const txtOnly = h('div', { class: 'txt-only' });
  const syncFile = () => { txtOnly.hidden = st.file !== 'txt'; copyBtn.hidden = st.file !== 'txt'; };
  const copyBtn = h('button', { class: 'btn', type: 'button', onclick: () => finish('copy') }, 'Copy');
  const fileRadios = Cloud.downloads ? h('fieldset', { class: 'radios' }, h('legend', null, 'File'),
    [['apkg', 'Anki package: keeps each card’s schedule and review history'], ['txt', 'Text file: words and meanings only, cards start as new']].map(([v, label]) => {
      const id = 'ex-file-' + v;
      return h('div', { class: 'radio' },
        h('input', { type: 'radio', name: 'ex-file', id, checked: st.file === v, onchange: () => { st.file = v; syncFile(); } }),
        h('label', { for: id }, label));
    })) : null;
  txtOnly.append(
    radios('Card layout', [['basic', 'Basic note type (front and back)'], ['cols', 'One column per field, to map onto your own note type']], 'fmt'),
    checkRow('ex-sent', 'Show the example sentence on the front', st.sent, v => { st.sent = v; }));
  openModal('Export to Anki', [
    fileRadios,
    radios('Words from', [['lang', L().name], ['all', 'All languages']], 'scope'),
    radios('Include', [['cards', 'Words with flashcards'], ['learning', 'All learning words'], ['meaning', 'Every word with a meaning']], 'which'),
    checkRow('ex-new', 'Only words I haven’t exported before', st.onlyNew, v => { st.onlyNew = v; upd(); }),
    checkRow('ex-rev', 'Include meaning → word cards', st.rev, v => { st.rev = v; }),
    txtOnly,
    field('ex-deck', 'Deck', deck),
    checkRow('ex-mark', 'Remember these as exported', st.mark, v => { st.mark = v; }),
    status,
    h('p', { class: 'hint' }, 'Words you export again update their notes in Anki instead of making duplicates.'),
    h('div', { class: 'm-actions' }, copyBtn,
      h('button', { class: 'btn primary', type: 'button', onclick: () => finish('save') }, 'Save file')),
  ], { wide: true });
  syncFile();
  upd();
}

/* ---------- importing a word list ---------- */
// prefill: lines of "word<tab>meaning", e.g. a shared word list; opts.as: 'known' or 'learning'
function openWordImport(prefill = '', opts = {}) {
  const code = S.settings.cur;
  const lang = L();
  const ta = h('textarea', { class: 'input', rows: 8, dir: 'auto', lang: code, placeholder: 'One word or phrase per line.\nTo add a meaning, put a tab after the word, then the meaning.' });
  ta.value = prefill;
  const file = h('input', { type: 'file', class: 'input', accept: '.txt,.tsv,.csv,text/plain,text/tab-separated-values' });
  file.addEventListener('change', async () => { const f = file.files[0]; if (f) ta.value = decodeBytes(await f.arrayBuffer()); });
  const st = { as: opts.as || 'known', cards: true };
  const err = h('p', { class: 'error', role: 'alert' });
  openModal(`Import ${lang.name} words`, [
    field('wi-text', 'Words', ta),
    field('wi-file', 'Or choose a file', file),
    h('fieldset', { class: 'radios' }, h('legend', null, 'Mark them as'),
      [['known', 'Known'], ['learning', 'Learning']].map(([v, l]) => h('div', { class: 'radio' },
        h('input', { type: 'radio', name: 'wi-as', id: 'wi-as-' + v, checked: st.as === v, onchange: () => { st.as = v; } }),
        h('label', { for: 'wi-as-' + v }, l)))),
    checkRow('wi-cards', 'Make flashcards for learning words', st.cards, v => { st.cards = v; }),
    err,
    h('div', { class: 'm-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      await ensureLang(code);
      const kf = keyFn(lang);
      let n = 0, skipped = 0;
      for (const raw of ta.value.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const cut = line.indexOf('\t');
        const word = (cut >= 0 ? line.slice(0, cut) : line).trim();
        const meaning = cut >= 0 ? line.slice(cut + 1).replace(/\t/g, ' ').trim() : '';
        if (!word) continue;
        const multi = /\s/.test(word);
        const k = multi ? phraseKey(lang, word) : kf(word);
        if (!k) continue;
        const e = entry(code, k);
        if (st.as === 'known') {
          if (e && e.s === 1) { skipped++; continue; }
          putEntry(code, k, { s: 2, ...(meaning ? { m: meaning, f: word } : {}), ...(multi ? { p: 1, f: word } : {}) });
        } else {
          putEntry(code, k, { s: 1, f: (e && e.f) || word, m: meaning || (e && e.m) || '', p: multi ? 1 : 0, ...(st.cards || (e && e.c) ? cardsFor(e, S.settings.reverse) : {}) });
        }
        n++;
      }
      if (!n) { err.textContent = skipped ? 'Those words are all already being learned.' : 'There were no words to import.'; return; }
      closeModal();
      toast(`Imported ${fmtNum(n)} word${n === 1 ? '' : 's'}` + (skipped ? ` · kept ${skipped} you’re learning` : ''));
      if (UI.route === 'words') drawList();
      updateBadge();
    } }, 'Import')),
  ], { wide: true });
}

/* ---------- options ---------- */
function viewOptions() {
  const v = $('#view');
  v.replaceChildren();
  const st = S.settings;
  const langRows = st.langs.map(l => h('div', { class: 'opt-lang' },
    h('div', null, h('b', null, l.name), l.native ? h('span', { class: 'nat', dir: 'auto', lang: l.code }, l.native) : null, h('code', null, l.code)),
    h('button', { class: 'btn sm', type: 'button', onclick: () => openLangEditor(l.code) }, 'Edit')));
  const missingRoster = CATALOG.filter(p => p.roster && !L(p.code));
  const ret = selectEl([['0.8', '80% (fewer reviews)'], ['0.85', '85%'], ['0.9', '90% (recommended)'], ['0.93', '93%'], ['0.95', '95% (more reviews)']], String(st.retention), x => setSettings({ retention: +x }));
  const npd = h('input', { type: 'number', class: 'input', min: 0, max: 200, step: 1, value: st.newPerDay, onchange: e => { setSettings({ newPerDay: clamp(Math.round(+e.target.value || 0), 0, 200) }); updateBadge(); } });
  const tier = selectEl([['fast', 'Fast'], ['thorough', 'Thorough (slower, better with rare languages)']], st.aiTier === 'thorough' ? 'thorough' : 'fast', x => setSettings({ aiTier: x === 'thorough' ? 'thorough' : 'quick' }));
  const restoreIn = h('input', { type: 'file', class: 'input', accept: '.json,application/json' });
  restoreIn.addEventListener('change', async () => {
    const f = restoreIn.files[0];
    if (!f) return;
    try {
      const r = await restoreBackup(await f.text());
      toast(`Restored ${fmtNum(r.lessons)} texts and ${fmtNum(r.words)} words`);
      route();
    } catch (e) { toast((e && e.message) || 'That backup couldn’t be read.'); }
    restoreIn.value = '';
  });
  const [, syncText] = syncLabel();
  v.append(...nodes(
    h('section', { class: 'opt' },
      h('h2', { class: 'sec first' }, 'Languages'),
      h('div', { class: 'opt-langs' }, langRows),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: openCatalog }, icon('plus'), 'Add a language'),
        missingRoster.length ? h('button', { class: 'btn', type: 'button', onclick: () => {
          setSettings({ langs: [...S.settings.langs, ...missingRoster.map(makeLang)] });
          toast(`Added ${missingRoster.length} Core Roster languages`);
          viewOptions();
        } }, `Add the Zabanestan Core Roster (${missingRoster.length})`) : null)),
    h('section', { class: 'opt' }, h('h2', { class: 'sec' }, 'Reading'), readingControls()),
    h('section', { class: 'opt' },
      h('h2', { class: 'sec' }, 'Review'),
      field('o-ret', 'How often you want to remember a card when it comes up', ret, 'Higher means more reviews and better recall. Scheduling uses FSRS, the same method as Anki.'),
      field('o-npd', 'New cards per day', npd),
      checkRow('o-fs', 'Show the example sentence on the front of cards', st.frontSentence, x => setSettings({ frontSentence: x })),
      checkRow('o-rev', 'Give each new flashcard word a reverse card too (meaning → word)', st.reverse, x => setSettings({ reverse: x })),
      (() => {
        const missing = [];
        for (const l of st.langs) if (S.loaded.has(l.code)) for (const [k, e] of vmap(l.code)) if (!e.d && e.s === 1 && e.c && !e.c2) missing.push([l.code, k]);
        return missing.length ? h('div', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => {
          for (const [code, k] of missing) putEntry(code, k, { c2: newCard() });
          toast(`Added ${fmtNum(missing.length)} reverse card${missing.length === 1 ? '' : 's'}`);
          viewOptions(); updateBadge();
        } }, `Add reverse cards to ${fmtNum(missing.length)} existing word${missing.length === 1 ? '' : 's'}`)) : null;
      })()),
    ACCT ? h('section', { class: 'opt' },
      h('h2', { class: 'sec' }, 'Account'),
      h('p', { class: 'muted' }, Acct.user
        ? `Signed in as ${(Acct.profile && Acct.profile.display_name) || Acct.user.email || 'you'}. Texts, word lists and OCR models you share are kept in your account.`
        : 'Optional. Sign in to keep texts, word lists and OCR models online, and share them by link or in the shared library.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => go('account') }, Acct.user ? 'Your account' : 'Sign in'),
        h('button', { class: 'btn', type: 'button', onclick: () => go('shared') }, 'Shared library'))) : null,
    // outside Claude there's nothing to switch on, so the section would only be noise
    window.claude ? h('section', { class: 'opt' },
      h('h2', { class: 'sec' }, 'Claude'),
      h('p', { class: 'muted' }, Cloud.sample
        ? `Claude can suggest meanings, translate sentences${Cloud.imageOCR ? ' and transcribe photos and scanned PDFs' : ''}. Each request uses your Claude usage.`
        : 'Claude suggestions aren’t available in this view.'),
      checkRow('o-ai', 'Show “Ask Claude” in the word panel', st.ai, x => setSettings({ ai: x })),
      field('o-tier', 'Suggestion speed', tier)) : null,
    h('section', { class: 'opt' },
      h('h2', { class: 'sec' }, 'Saving and backup'),
      h('p', null, h('span', { class: 'sync-inline', id: 'opt-sync' }, syncText)),
      h('p', { class: 'muted' }, Cloud.state === 'local'
        ? 'Your texts and words are kept in this browser. Back up regularly so nothing is lost if the browser clears its storage. To move to another device, restore the backup file there.'
        : 'Your texts, words and flashcards are saved to your Claude account, privately, and appear on any device where you open this page.'),
      Cloud.state === 'local' ? h('p', { class: 'muted sm', id: 'o-last-backup' }, S.meta.backupAt ? `Last backup: ${daysAgo(S.meta.backupAt)}.` : 'No backup saved from this browser yet.') : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: async () => { if (await saveBackupFile() && UI.route === 'options') viewOptions(); } }, 'Back up everything')),
      field('o-restore', 'Restore from a backup file', restoreIn, 'Adds the backup’s texts and words. Anything newer here is kept.')),
    h('section', { class: 'opt' },
      h('h2', { class: 'sec' }, 'How it works'),
      h('ul', { class: 'help' },
        h('li', null, `Words you haven’t met are shaded blue. Tap one to see its panel, write a meaning${Cloud.sample ? ' or ask Claude' : ' (the dictionary links help)'}, and add it as a flashcard.`),
        h('li', null, 'Learning words are shaded gold. The shade fades as a word’s flashcard becomes well known.'),
        h('li', null, 'Turning the page marks the blue words you didn’t tap as known, as LingQ does. You can undo it, or switch it off above.'),
        h('li', null, 'Tap “+ word after” in the panel to save a phrase, such as a compound verb.'),
        h('li', null, 'Keyboard: ← → move between words · K known · L learning · I ignore · A add flashcard · [ ] turn pages · in review, Space shows the answer and 1–4 grade it.'))),
    SITE ? h('section', { class: 'opt' },
      h('h2', { class: 'sec' }, 'About'),
      h('p', null, `Khwānish is a free reader for language learners, hosted by ${SITE.name}. It has no server: your texts and words stay in this browser.`),
      h('ul', { class: 'help' },
        h('li', null, h('a', { href: SITE.guide }, 'Reader guide'), ': importing texts, flashcards, Anki, scanned books and recordings'),
        h('li', null, h('a', { href: SITE.home }, `${SITE.name} home`)),
        h('li', null, 'Open source under the ', h('a', { href: 'LICENSE.txt' }, 'MIT License'), '; fonts and libraries are listed in ', h('a', { href: 'THIRD-PARTY.txt' }, 'their own notices'), '.'))) : null));
}

/* ---------- start-up ---------- */
async function boot(hot) {
  await Local.open();
  const [st, stats, lessons, pending, meta] = await Promise.all(['settings', 'stats', 'lessons', 'pending', 'meta'].map(k => Local.get(k)));
  S.settings = fixSettings(st);
  S.stats = stats && stats.days ? stats : { days: {}, u: 0 };
  for (const m of lessons || []) if (m && m.id) S.lessons.set(m.id, m);
  S.meta = meta || {};
  Sync.restore(pending);
  await ensureLangLocal(S.settings.cur);
  UI.init();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (hot && hot.l && S.lessons.get(hot.l) && !S.lessons.get(hot.l).del) openLesson(hot.l, hot.p);
  else route();
  connectExtras();
  cloudSync();
  acctBoot();
}
function start(hot) {
  boot(hot || {}).catch(err => {
    console.error(err);
    const v = $('#view');
    if (v) v.replaceChildren(h('p', { class: 'error' }, 'Khwānish couldn’t start: ' + ((err && err.message) || err) + '. Reload the page to try again.'));
  });
}
(function () {
  const hot = window.claude && window.claude.hot;
  if (hot && typeof hot.snapshot === 'function') {
    try { hot.snapshot(() => ({ l: UI.reader ? UI.reader.meta.id : null, p: UI.reader ? UI.reader.page : 0 })); } catch { }
  }
  if (hot && typeof hot.ready === 'function') hot.ready(start);
  else start((hot && hot.data) || {});
})();

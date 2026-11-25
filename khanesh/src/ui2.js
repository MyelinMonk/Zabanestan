/* =====================================================================
   Khānesh · interface: review, words, Anki export, options, start-up
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
    const dk = scope === 'lang' ? reviewDeck(c) : null;
    for (const [k, e] of vmap(c)) {
      if (e.d || e.s !== 1) continue;
      if (dk != null && deckOf(c, e) !== dk) continue;
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
    const dk = scope === 'lang' ? reviewDeck(c) : null;
    for (const e of vmap(c).values()) {
      if (e.d || e.s !== 1) continue;
      if (dk != null && deckOf(c, e) !== dk) continue;
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
  const code = S.settings.cur, decks = decksOf(code);
  const deckPick = R.scope === 'lang' && decks.length > 1 ? selectEl([['*', 'All decks'], ...decks.map(d => [d.id || '0', d.n])],
    reviewDeck(code) == null ? '*' : (reviewDeck(code) || '0'),
    x => { patchLang(code, { rdeck: x === '*' ? null : x === '0' ? '' : x }); R.cur = null; R.shown = false; drawReview(); updateBadge(); }) : null;
  if (deckPick) { deckPick.id = 'rv-deck'; deckPick.classList.add('sm'); deckPick.setAttribute('aria-label', 'Deck to review'); }
  v.append(h('div', { class: 'rv-head' },
    h('div', { class: 'seg2', role: 'group', 'aria-label': 'Cards to review' },
      h('button', { type: 'button', 'aria-pressed': String(R.scope === 'lang'), onclick: () => setScope('lang') }, L().name),
      h('button', { type: 'button', 'aria-pressed': String(R.scope === 'all'), onclick: () => setScope('all') }, 'All languages')),
    deckPick,
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
        h('button', { class: 'btn', type: 'button', onclick: () => browseCards() }, icon('search'), 'Browse all cards'),
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
  // the word's sound, on the card right under it: a recording if it has one, otherwise the device's voice
  const voice = ttsVoice(lang);
  const say = () => {
    if (!e.au && !voice) return null;
    const b = h('button', { class: 'rv-say', type: 'button', 'aria-label': e.au ? 'Play recording' : 'Listen' }, icon('speaker'), e.au ? 'Play recording' : 'Listen');
    b.onclick = async () => {
      if (!e.au) { speak(form, lang); return; }
      b.classList.add('playing');
      const ok = await playWordAudio(e);
      const p = ok && wordPlayer;
      if (p) p.addEventListener('ended', () => b.classList.remove('playing'), { once: true }); else b.classList.remove('playing');
    };
    return b;
  };
  const card = rev
    ? h('div', { class: 'rv-card' + (R.shown ? ' shown' : '') }, tags,
        h('div', { class: 'rv-m big', dir: 'auto' }, e.m || ''))
    : h('div', { class: 'rv-card' + (R.shown ? ' shown' : '') }, tags,
        h('div', { class: 'rv-word', dir: 'auto', lang: it.code }, form),
        say(),
        S.settings.frontSentence ? sent : null);
  if (R.shown) {
    card.append(rev
      ? h('div', { class: 'rv-back' },
          h('div', { class: 'rv-word', dir: 'auto', lang: it.code }, form),
          say(),
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
  const wordShown = !rev || R.shown;
  // a recording plays by itself when the word first appears (front of word → meaning, back of meaning → word)
  const showing = it.code + '|' + it.key + '|' + it.d + '|' + (rev ? R.shown : '');
  if (e.au && wordShown && S.settings.autoAudio && R.played !== showing) { R.played = showing; playWordAudio(e, true); }
  v.append(h('div', { class: 'rv-sub' },
    R.undo ? h('button', { class: 'btn ghost sm', type: 'button', onclick: undoReview }, icon('undo'), 'Undo') : null,
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
  else if (k === 'r' || k === 'R') { const x = entry(R.cur.code, R.cur.key); if (x && x.au && (R.cur.d !== 2 || R.shown)) { playWordAudio(x); e.preventDefault(); } }
}

/* ---------- words ---------- */
function viewWords() {
  const lang = L();
  const code = lang.code;
  const W = UI.words;
  if (!S.loaded.has(code) || (Cloud.state === 'ready' && !S.cloudLoaded.has(code))) ensureLang(code).then(() => { if (UI.route === 'words') drawList(); });
  const v = $('#view');
  v.replaceChildren();
  const q = h('input', { type: 'search', id: 'w-q', class: 'input', placeholder: 'Search words, meanings, notes or sentences', value: W.q, dir: 'auto', 'aria-label': 'Search words' });
  q.addEventListener('input', debounce(() => { W.q = q.value; W.limit = 200; drawList(); }, 200));
  const st = selectEl([['learning', 'Learning'], ['known', 'Known'], ['ignored', 'Ignored'], ['all', 'All saved'],
    ['cards', 'All flashcards'], ['due', 'Flashcards due now'], ['newc', 'New flashcards'], ['later', 'Flashcards not due yet']], W.st, x => {
    W.st = x; W.limit = 200;
    if (CARD_FILTERS.includes(x) && W.sort === 'recent') { W.sort = 'due'; const so = $('#w-sort'); if (so) so.value = 'due'; }
    const fc = $('#w-c'); if (fc) fc.closest('.check').hidden = CARD_FILTERS.includes(x);
    drawList();
  });
  st.id = 'w-st'; st.setAttribute('aria-label', 'Status');
  const sort = selectEl([['recent', 'Recently changed'], ['alpha', 'A to Z'], ['due', 'Next due']], W.sort, x => { W.sort = x; drawList(); });
  sort.id = 'w-sort'; sort.setAttribute('aria-label', 'Sort');
  const decks = decksOf(code);
  if (W.deck !== '*' && !decks.some(d => deckVal(d.id) === W.deck)) W.deck = '*';
  const dk = decks.length > 1 ? selectEl([['*', 'All decks'], ...decks.map(d => [deckVal(d.id), d.n])], W.deck, x => { W.deck = x; W.limit = 200; drawList(); }) : null;
  if (dk) { dk.id = 'w-deck'; dk.setAttribute('aria-label', 'Deck'); }
  v.append(
    h('h2', { class: 'sec first' }, `${lang.name} words`),
    h('div', { class: 'wfilters' }, q, st, dk, sort, Object.assign(checkRow('w-c', 'Flashcards only', W.cards, x => { W.cards = x; drawList(); }), { hidden: CARD_FILTERS.includes(W.st) })),
    h('p', { class: 'muted sm', id: 'w-count', role: 'status' }),
    h('div', { class: 'wlist', id: 'wlist' }),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', id: 'w-new', onclick: () => openNewCard(code, W.deck !== '*' ? deckIdOf(W.deck) : undefined) }, icon('plus'), 'New card'),
      h('button', { class: 'btn', type: 'button', id: 'w-decks', onclick: () => openDecks(code) }, icon('cards'), 'Decks'),
      h('button', { class: 'btn primary', type: 'button', onclick: openExport }, 'Export to Anki'),
      h('button', { class: 'btn', type: 'button', onclick: () => openWordImport() }, 'Import a word list'),
      h('button', { class: 'btn', type: 'button', id: 'w-anki', onclick: () => pickAnkiFile() }, 'Import from Anki'),
      ACCT ? h('button', { class: 'btn', type: 'button', onclick: () => shareWords() }, 'Share a word list') : null));
  drawList();
}
// flashcard filters: every card, cards review would show now, cards never studied, and the rest
const CARD_FILTERS = ['cards', 'due', 'newc', 'later'];
function cardState(e, now = Date.now()) {
  const cards = [e.c, e.m ? e.c2 : null].filter(Boolean);
  if (!cards.length) return null;
  if (e.s === 1 && cards.some(c => c.q && c.due <= now)) return 'due';
  if (cards.some(c => !c.q)) return 'newc';
  return 'later';
}
function drawList() {
  const code = S.settings.cur;
  const W = UI.words;
  const list = $('#wlist');
  if (!list) return;
  const term = W.q.trim().toLowerCase();
  const now = Date.now();
  const items = [];
  for (const [k, e] of vmap(code)) {
    if (e.d) continue;
    if (W.st === 'learning' && e.s !== 1) continue;
    if (W.st === 'known' && e.s !== 2) continue;
    if (W.st === 'ignored' && e.s !== 3) continue;
    if (W.st === 'all' && !e.s && !e.m) continue;
    if (CARD_FILTERS.includes(W.st)) { const cs = cardState(e, now); if (!cs || (W.st !== 'cards' && cs !== W.st)) continue; }
    if (W.cards && !e.c && !e.c2) continue;
    if (W.deck !== '*' && !((e.c || e.c2) && deckVal(deckOf(code, e)) === W.deck)) continue;
    if (term && !(k.includes(term) || [e.f, e.m, e.n, e.r, e.x, e.fa, e.dl].some(x => x && x.toLowerCase().includes(term)))) continue;
    items.push([k, e]);
  }
  if (W.sort === 'alpha') { const coll = new Intl.Collator(code); items.sort((a, b) => coll.compare(a[1].f || a[0], b[1].f || b[0])); }
  else if (W.sort === 'due') { const due = e => Math.min((e.c && e.c.q && e.c.due) || Infinity, (e.c2 && e.c2.q && e.c2.due) || Infinity); items.sort((a, b) => due(a[1]) - due(b[1])); }
  else items.sort((a, b) => (b[1].u || 0) - (a[1].u || 0));
  const cnt = $('#w-count');
  if (cnt) cnt.textContent = `${fmtNum(items.length)} word${items.length === 1 ? '' : 's'}`;
  list.replaceChildren(...items.slice(0, W.limit).map(([k, e]) => wordRow(code, k, e)));
  if (items.length > W.limit) list.append(h('button', { class: 'btn ghost', type: 'button', onclick: () => { W.limit += 300; drawList(); } }, `Show ${fmtNum(Math.min(300, items.length - W.limit))} more`));
  if (!items.length) list.append(h('p', { class: 'empty' }, term ? 'No saved words match that search.'
    : W.st === 'due' ? 'No flashcards are due right now.' : CARD_FILTERS.includes(W.st) ? 'No flashcards here yet. Add them from a word’s panel while you read.'
    : 'Nothing here yet. Tap words while you read to save them.'));
}
function wordRow(code, k, e) {
  const cards = [e.c, e.m ? e.c2 : null].filter(Boolean);
  const started = cards.filter(c => c.q);
  const label = e.s === 1 ? (cards.length ? (started.length ? relDue(Math.min(...started.map(c => c.due))) : 'new card') : 'learning') : e.s === 2 ? 'known' : e.s === 3 ? 'ignored' : 'new';
  const deck = (e.c || e.c2) && decksOf(code).length > 1 ? deckName(code, deckOf(code, e)) : '';
  return h('button', { class: 'wrow', type: 'button', onclick: () => openWordSheet(code, k) },
    h('span', { class: 'wf', dir: 'auto', lang: code }, e.f || k),
    h('span', { class: 'wm', dir: 'auto' }, e.m || '', deck ? h('span', { class: 'wdeck', dir: 'auto' }, deck) : null),
    h('span', { class: 'wst s' + (e.s || 0) }, label));
}
function openWordSheet(code, k) {
  const e = entry(code, k);
  if (!e) return;
  openSheet({ code, key: k, form: e.f || k, sentence: e.x || '', origin: e.o, range: null, phrase: !!e.p,
    onClose: () => { if (UI.route === 'words') drawList(); } });
}

/* ---------- decks ---------- */
// In menus the main deck (id '') goes by '0'.
const deckVal = id => id || '0';
const deckIdOf = v => v === '0' ? '' : v;
function addDeck(code, name) {
  const n = String(name || '').trim().slice(0, 60);
  if (!n) return null;
  const same = decksOf(code).find(d => d.n.toLowerCase() === n.toLowerCase());
  if (same) return same.id;
  const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  patchLang(code, { decks: [...(L(code).decks || []), { id, n }] });
  return id;
}
function openDecks(code = S.settings.cur, focusNew = false) {
  const lang = L(code);
  if (!lang) return;
  const done = () => { if (UI.route === 'words') viewWords(); else if (UI.route === 'library') viewLibrary(); updateBadge(); };
  if (!S.loaded.has(code)) { ensureLang(code).then(() => openDecks(code, focusNew)); return; }
  const rows = decksOf(code).map(d => {
    const n = cardCount(code, d.id);
    const name = h('input', { class: 'input', value: d.n, maxlength: 60, dir: 'auto', 'aria-label': `Name of ${d.n}` });
    name.addEventListener('change', () => {
      const v = name.value.trim().slice(0, 60);
      if (!v || v === d.n) { name.value = d.n; return; }
      if (d.id) patchLang(code, { decks: (L(code).decks || []).map(x => x.id === d.id ? { ...x, n: v } : x) });
      else patchLang(code, { deck0: v });
      toast('Deck renamed');
      openDecks(code);
    });
    return h('li', { class: 'deck-row' },
      name,
      h('span', { class: 'muted sm deck-n' }, `${fmtNum(n)} word${n === 1 ? '' : 's'}`),
      d.id ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => removeDeck(code, d) }, 'Delete') : h('span'));
  });
  const nn = h('input', { class: 'input', maxlength: 60, dir: 'auto', placeholder: 'For example, Unit 3 or Food', 'aria-label': 'Name of the new deck' });
  const make = () => {
    const v = nn.value.trim();
    if (!v) { nn.focus(); return; }
    const id = addDeck(code, v);
    if (id) toast(`Added ${deckName(code, id)}`);
    openDecks(code);
  };
  nn.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); make(); } });
  const total = cardCount(code);
  openModal(`${lang.name} decks`, [
    h('p', { class: 'm-text' }, 'Group your flashcards into decks, then review one deck at a time or all of them together. You choose the deck when you add or import cards; to move a word’s cards, open its panel.'),
    h('ul', { class: 'deck-list' }, rows),
    h('div', { class: 'field' }, h('label', { for: 'deck-new-name' }, 'Add a deck'),
      h('div', { class: 'deck-make' }, Object.assign(nn, { id: 'deck-new-name' }), h('button', { class: 'btn', type: 'button', onclick: make }, icon('plus'), 'Add'))),
    h('div', { class: 'm-danger' },
      h('p', { class: 'muted sm' }, `Delete every ${lang.name} flashcard, in all decks. Your words and meanings stay.`),
      h('button', { class: 'btn danger', type: 'button', disabled: !total, onclick: () => deleteLangCards(code) }, `Delete all ${lang.name} flashcards`)),
  ], { wide: true, onClose: done });
  if (focusNew) setTimeout(() => nn.focus(), 30);
}
// Make a flashcard by hand: a word or phrase, its meaning, and optionally an example and notes.
function openNewCard(code = S.settings.cur, deck) {
  const lang = L(code);
  if (!lang) return;
  if (!S.loaded.has(code)) { ensureLang(code).then(() => openNewCard(code, deck)); return; }
  let dk = deck != null && hasDeck(code, deck) ? deck : newCardDeck(code);
  const word = h('input', { class: 'input', dir: 'auto', lang: code, maxlength: 200, placeholder: `A ${lang.name} word or phrase` });
  const mean = h('input', { class: 'input', dir: 'auto', maxlength: 500, placeholder: 'Its meaning, in your own words' });
  const sent = h('textarea', { class: 'input', rows: 2, dir: 'auto', lang: code, placeholder: 'Optional: a sentence using it' });
  const note = h('input', { class: 'input', dir: 'auto', maxlength: 500, placeholder: 'Optional' });
  const m = deckMenu(code, dk, id => { dk = id; }, 'Deck for the card');
  const err = h('p', { class: 'error', role: 'alert' });
  let added = 0;
  const add = () => {
    err.textContent = '';
    const w = word.value.trim(), mm = mean.value.trim();
    if (!w) { err.textContent = 'Write the word or phrase first.'; word.focus(); return; }
    if (!mm) { err.textContent = 'Write its meaning, so the card has a back.'; mean.focus(); return; }
    const multi = /\s/.test(w);
    const k = multi ? phraseKey(lang, w) : keyFn(lang)(w);
    if (!k) { err.textContent = 'That doesn’t look like a word.'; return; }
    const e = entry(code, k);
    if (e && (e.c || e.c2)) { err.textContent = `You already have a card for this, in ${deckName(code, deckOf(code, e))}. Open it from Words to change it.`; return; }
    putEntry(code, k, { s: 1, f: w, m: mm, ...(sent.value.trim() ? { x: sent.value.trim().slice(0, 1000) } : {}), ...(note.value.trim() ? { n: note.value.trim() } : {}),
      p: multi ? 1 : 0, ...cardsFor(e, S.settings.reverse), dk });
    added++;
    toast(`Added to ${deckName(code, dk)}`);
    for (const x of [word, mean, sent, note]) x.value = '';
    word.focus();
    updateBadge();
  };
  for (const x of [word, mean, note]) x.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } });
  openModal(`New ${lang.name} flashcard`, [
    field('nc-word', 'Word or phrase', word),
    field('nc-mean', 'Meaning', mean),
    field('nc-sent', 'Example sentence', sent),
    field('nc-note', 'Notes', note),
    h('div', { class: 'field' }, h('label', { for: 'nc-deck' }, 'Deck'), Object.assign(m.sel, { id: 'nc-deck' }), m.box),
    err,
    h('div', { class: 'm-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => closeModal() }, 'Done'),
      h('button', { class: 'btn primary', type: 'button', id: 'nc-add', onclick: add }, icon('plus'), 'Add card')),
  ], { onClose: () => { if (added) { if (UI.route === 'words') drawList(); else if (UI.route === 'library') viewLibrary(); } } });
  setTimeout(() => word.focus(), 30);
}
async function removeDeck(code, d, after) {
  const back = after || (() => openDecks(code));
  const n = cardCount(code, d.id);
  const finish = async how => {
    if (how === 'cards') await deleteCards(code, d.id);
    else if (how === 'move') for (const [k, e] of [...vmap(code)]) if (!e.d && (e.c || e.c2) && deckOf(code, e) === d.id) putEntry(code, k, { dk: '' });
    const l = L(code);
    patchLang(code, { decks: (l.decks || []).filter(x => x.id !== d.id), ...(l.addDeck === d.id ? { addDeck: '' } : {}), ...(l.rdeck === d.id ? { rdeck: null } : {}) });
    toast(`Deleted ${d.n}` + (how === 'cards' ? ` and its ${fmtNum(n)} card${n === 1 ? '' : 's'}` : ''));
    closeModal();
    back();
  };
  if (!n) { await finish('move'); return; }
  const main = decksOf(code)[0].n;
  openModal(`Delete ${d.n}`, [
    h('p', { class: 'm-text' }, `${d.n} has flashcards for ${fmtNum(n)} word${n === 1 ? '' : 's'}. Move them to ${main}, or delete them with the deck? Either way the words and their meanings stay.`),
    h('div', { class: 'm-actions' },
      h('button', { class: 'btn', type: 'button', onclick: back }, 'Cancel'),
      h('button', { class: 'btn', type: 'button', onclick: () => finish('move') }, `Move them to ${main}`),
      h('button', { class: 'btn danger-fill', type: 'button', onclick: () => finish('cards') }, 'Delete the flashcards')),
  ]);
}
async function deleteLangCards(code) {
  const lang = L(code);
  const n = cardCount(code);
  if (!await confirmBox(`Delete all ${lang.name} flashcards`, `This removes the flashcards of all ${fmtNum(n)} ${lang.name} word${n === 1 ? '' : 's'} that have them, in every deck${Cloud.state === 'local' ? '' : ', here and in your account'}. Your words, meanings and decks stay. It can’t be undone.`, 'Delete flashcards', true)) { openDecks(code); return; }
  const done = await deleteCards(code);
  toast(`Deleted the flashcards of ${fmtNum(done)} word${done === 1 ? '' : 's'}`);
  if (UI.route === 'words') viewWords();
  updateBadge();
}
// every language: from Options and your account
async function deleteEveryCard() {
  for (const l of S.settings.langs) await ensureLang(l.code);
  const n = S.settings.langs.reduce((t, l) => t + cardCount(l.code), 0);
  if (!n) { toast('You have no flashcards'); return; }
  if (!await confirmBox('Delete all flashcards', `This removes the flashcards of all ${fmtNum(n)} word${n === 1 ? '' : 's'} that have them, in every language${Cloud.state === 'local' ? '' : ', here and in your account'}. Your words, meanings, texts and decks stay. It can’t be undone.`, 'Delete all flashcards', true)) return;
  const done = await deleteAllCards();
  toast(`Deleted the flashcards of ${fmtNum(done)} word${done === 1 ? '' : 's'}`);
  updateBadge();
  route();
}
// A deck picker for imports: the language's decks, and a new one by name.
function deckChooser(code, st) {
  st.dk = newCardDeck(code);
  const name = h('input', { class: 'input', maxlength: 60, dir: 'auto', placeholder: 'Name of the new deck', 'aria-label': 'Name of the new deck', value: st.newDeck || '' });
  name.addEventListener('input', () => { st.newDeck = name.value; });
  const wrap = h('div', { class: 'deck-new', hidden: true }, name);
  const sel = selectEl([...decksOf(code).map(d => [deckVal(d.id), d.n]), ['+', 'New deck…']], st.newDeck ? '+' : deckVal(st.dk), x => {
    wrap.hidden = x !== '+';
    if (x === '+') { st.newDeck = name.value || st.newDeck || ''; name.focus(); } else { st.newDeck = ''; st.dk = deckIdOf(x); }
  });
  wrap.hidden = sel.value !== '+';
  return h('div', null, field('wi-deck', 'Import the flashcards to', sel, 'Choose one of your decks, or make a new one.'), wrap);
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
  const deck = h('input', { class: 'input', value: `Khānesh::${L().name}` });
  const status = h('p', { class: 'm-text', role: 'status' });
  const upd = () => {
    const n = exportRows(st).length;
    status.textContent = n ? `${fmtNum(n)} word${n === 1 ? '' : 's'} will be exported.` : 'Nothing matches these choices.';
  };
  const radios = (name, opts, key) => h('fieldset', { class: 'radios' }, h('legend', null, name),
    opts.map(([v, label]) => {
      const id = `ex-${key}-${v}`;
      return h('div', { class: 'radio' },
        h('input', { type: 'radio', name: 'ex-' + key, id, value: v, checked: st[key] === v, onchange: () => { st[key] = v; if (key === 'scope') deck.value = v === 'all' ? 'Khānesh' : `Khānesh::${L().name}`; upd(); } }),
        h('label', { for: id }, label));
    }));
  const finish = async how => {
    const rows = exportRows(st);
    if (!rows.length) { upd(); return; }
    if (st.file === 'apkg' && how !== 'copy') {
      const base = deck.value.trim() || 'Khānesh';
      status.textContent = 'Packing your cards…';
      let pack;
      try { pack = await buildApkg(rows, code => st.scope === 'all' ? `${base}::${langOrStub(code).name}` : base, st.rev); }
      catch (e) { status.textContent = (e && e.message) || 'Couldn’t build the Anki package.'; return; }
      // Claude's file saver only takes certain extensions, so there the package goes out as .apkg.zip
      const name = `khanesh-${st.scope === 'all' ? 'all' : S.settings.cur}-${dayKey()}.apkg${Cloud.plainFiles ? '' : '.zip'}`;
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
    } else ok = await saveFile(`khanesh-${st.scope === 'all' ? 'all' : S.settings.cur}-${dayKey()}.txt`, txt, 'Anki export');
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
function parseWordLine(raw) {
  const line = raw.trim();
  if (!line) return null;
  const parts = line.split('\t');
  // a last column with a recording's address (from a course page) becomes the word's audio
  const au = parts.length > 2 && isAudioRef(parts[parts.length - 1].trim()) ? parts.pop().trim() : '';
  const word = parts.shift().trim();
  const meaning = parts.join(' ').trim();
  return word ? { word, meaning, ...(au ? { au } : {}) } : null;
}

// opts.pick: show the words as a list to tick, each marked Learning or Known (words from a course)
// opts.keep: a meaning you already wrote stays
function openWordImport(prefill = '', opts = {}) {
  const code = S.settings.cur;
  const lang = L();
  const st = { as: opts.as || 'known', cards: true, newDeck: opts.deck || '' };
  const err = h('p', { class: 'error', role: 'alert' });
  const go = h('button', { class: 'btn primary', type: 'button' }, opts.pick ? 'Import entries' : 'Import');
  let rows = null, ta = null, file = null, count = null;

  const setAll = (as) => { if (rows) for (const r of rows) r.setAs(as); };
  const refresh = () => {
    if (!rows) return;
    const on = rows.filter(r => r.on);
    const nl = on.filter(r => r.as === 'learning').length, nk = on.length - nl;
    count.textContent = `${fmtNum(on.length)} of ${fmtNum(rows.length)} chosen` + (on.length ? ` · ${fmtNum(nl)} learning, ${fmtNum(nk)} known` : '');
    go.disabled = !on.length;
  };

  const deckBox = deckChooser(code, st);
  let body;
  if (opts.pick) {
    const kf = keyFn(lang);
    rows = prefill.split(/\r?\n/).map(parseWordLine).filter(Boolean).map((w, i) => {
      const r = { ...w, as: st.as };
      const multi = /\s/.test(w.word);
      const k = multi ? phraseKey(lang, w.word) : kf(w.word);
      const e = k && S.loaded.has(code) ? entry(code, k) : null;
      const had = e && !e.d ? (e.s === 1 ? 'learning' : e.s === 2 ? 'known' : '') : '';
      r.on = !had;   // words you already have start unticked
      const id = 'wi-w' + i;
      const cb = h('input', { type: 'checkbox', id, checked: r.on, onchange: () => { r.on = cb.checked; row.classList.toggle('off', !r.on); refresh(); } });
      const bL = h('button', { type: 'button', class: 's-learn', 'aria-pressed': 'false', onclick: () => { r.setAs('learning'); refresh(); } }, 'Learning');
      const bK = h('button', { type: 'button', class: 's-known', 'aria-pressed': 'false', onclick: () => { r.setAs('known'); refresh(); } }, 'Known');
      r.setAs = (as) => { r.as = as; bL.setAttribute('aria-pressed', String(as === 'learning')); bK.setAttribute('aria-pressed', String(as === 'known')); };
      r.setAs(st.as);
      const row = h('li', { class: 'wi-row' },
        cb,
        h('label', { for: id, class: 'wi-w' },
          h('span', { class: 'wi-word', dir: 'auto', lang: code }, w.word),
          w.meaning ? h('span', { class: 'wi-m' }, w.meaning) : null,
          w.au ? h('span', { class: 'wi-au' }, icon('speaker'), 'Recording') : null,
          had ? h('span', { class: 'wi-had' }, `Already ${had}`) : null),
        h('div', { class: 'seg wi-seg', role: 'group', 'aria-label': `Mark ${w.word} as` }, bL, bK));
      r.row = row;
      row.classList.toggle('off', !r.on);
      return r;
    });
    count = h('p', { class: 'wi-count', 'aria-live': 'polite' });
    body = [
      h('div', { class: 'wi-tools' },
        h('span', null, 'Choose'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => { for (const r of rows) { r.on = true; r.row.querySelector('input').checked = true; r.row.classList.remove('off'); } refresh(); } }, 'All'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => { for (const r of rows) { r.on = false; r.row.querySelector('input').checked = false; r.row.classList.add('off'); } refresh(); } }, 'None'),
        h('span', null, 'Mark all'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => { setAll('learning'); refresh(); } }, 'Learning'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => { setAll('known'); refresh(); } }, 'Known')),
      h('ul', { class: 'wi-list' }, rows.map(r => r.row)),
      count,
      checkRow('wi-cards', 'Make flashcards for learning words', st.cards, v => { st.cards = v; deckBox.hidden = !v; }),
      deckBox,
    ];
  } else {
    ta = h('textarea', { class: 'input', rows: 8, dir: 'auto', lang: code, placeholder: 'One word or phrase per line.\nTo add a meaning, put a tab after the word, then the meaning.' });
    ta.value = prefill;
    file = h('input', { type: 'file', class: 'input', accept: '.txt,.tsv,.csv,text/plain,text/tab-separated-values' });
    file.addEventListener('change', async () => { const f = file.files[0]; if (f) ta.value = decodeBytes(await f.arrayBuffer()); });
    body = [
      field('wi-text', 'Words', ta),
      field('wi-file', 'Or choose a file', file),
      h('fieldset', { class: 'radios' }, h('legend', null, 'Mark them as'),
        [['known', 'Known'], ['learning', 'Learning']].map(([v, l]) => h('div', { class: 'radio' },
          h('input', { type: 'radio', name: 'wi-as', id: 'wi-as-' + v, checked: st.as === v, onchange: () => { st.as = v; } }),
          h('label', { for: 'wi-as-' + v }, l)))),
      checkRow('wi-cards', 'Make flashcards for learning words', st.cards, v => { st.cards = v; deckBox.hidden = !v; }),
      deckBox,
    ];
  }

  go.onclick = async () => {
    await ensureLang(code);
    const kf = keyFn(lang);
    const list = rows ? rows.filter(r => r.on) : ta.value.split(/\r?\n/).map(parseWordLine).filter(Boolean).map(w => ({ ...w, as: st.as }));
    if (st.cards && st.newDeck && st.newDeck.trim() && list.some(w => w.as === 'learning')) st.dk = addDeck(code, st.newDeck) || '';
    let n = 0, skipped = 0;
    for (const { word, meaning, as, au: newAu } of list) {
      const multi = /\s/.test(word);
      const k = multi ? phraseKey(lang, word) : kf(word);
      if (!k) continue;
      const e = entry(code, k);
      // a course's recording goes on the word, unless you've added one of your own
      const au = newAu && !(e && e.au && /^local:/.test(e.au)) ? { au: newAu } : {};
      if (as === 'known') {
        // pasted lists don't demote words you're learning; ticking Known for one word does
        if (!rows && e && e.s === 1) { skipped++; continue; }
        const m = (opts.keep && e && e.m) || meaning;
        putEntry(code, k, { s: 2, ...(m ? { m, f: (e && e.f) || word } : {}), ...(multi ? { p: 1, f: word } : {}), ...au });
      } else {
        const m = (opts.keep && e && e.m) || meaning || (e && e.m) || '';
        const hasCards = !!(e && (e.c || e.c2));
        putEntry(code, k, { s: 1, f: (e && e.f) || word, m, p: multi ? 1 : 0, ...au, ...(st.cards || (e && e.c) ? cardsFor(e, S.settings.reverse) : {}), ...(st.cards && !hasCards ? { dk: st.dk } : {}) });
      }
      n++;
    }
    if (!n) { err.textContent = skipped ? 'Those words are all already being learned.' : 'There were no words to import.'; return; }
    if (opts.onImported) await opts.onImported(n);
    closeModal();
    toast(`Imported ${fmtNum(n)} ${rows ? (n === 1 ? 'entry' : 'entries') : (n === 1 ? 'word' : 'words')}` + (skipped ? ` · kept ${skipped} you’re learning` : ''));
    if (UI.route === 'words') drawList();
    updateBadge();
  };

  openModal(`Import ${lang.name} words`, [
    opts.note ? h('p', { class: 'm-text' }, opts.note) : null,
    ...body,
    err,
    h('div', { class: 'm-actions' }, go),
  ], { wide: true, onClose: opts.onClose });
  refresh();
}

/* ---------- import from Anki ----------
   Each note becomes a word: one field is the word, another its meaning. Cards keep their schedule
   and history. Cloze notes, image occlusion and notes without a word in text are skipped. */
function pickAnkiFile() {
  const inp = h('input', { type: 'file', accept: '.apkg,.colpkg', hidden: true });
  inp.addEventListener('change', () => { const f = inp.files[0]; inp.remove(); if (f) openAnkiImport(f); });
  document.body.append(inp);
  inp.click();
}
const ANKI_WORD = /^(word|term|front|expression|vocab(ulary)?|target|foreign|lemma|headword|question)$/i;
const ANKI_MEANING = /^(meaning|definition|back|english|translation|gloss|answer|glossary)$/i;
const ANKI_EXTRA = { r: /^(root|dictionary form|lemma form)$/i, n: /^(notes?|grammar|usage)$/i, x: /^(sentence|example( sentence)?)$/i, o: /^source$/i };
async function openAnkiImport(file) {
  const code = S.settings.cur;
  const lang = L();
  openModal('Import from Anki', [h('p', { class: 'm-text thinking' }, `Reading ${file.name}…`)]);
  let pk;
  try {
    await ensureLang(code);
    pk = await readAnkiPackage(file);
  } catch (e) {
    openModal('Import from Anki', [h('p', { class: 'error' }, (e && e.message) || 'That Anki package couldn’t be read.')]);
    return;
  }
  const st = { sched: true, audio: true, keepDecks: true, newDeck: '' };
  const groups = [];
  for (const t of pk.types.values()) {
    const notes = pk.notes.filter(n => n.mid === t.id);
    if (!notes.length) continue;
    const cloze = t.cloze || /cloze/i.test(t.name) || notes.some(n => /\{\{c\d+::/.test(n.flds.join('')));
    const occl = /image occlusion/i.test(t.name);
    const g = { t, notes, skip: cloze ? 'Cloze notes can’t be imported yet' : occl ? 'Image occlusion can’t be imported' : t.fields.length < 1 ? 'No fields' : '' };
    const idx = re => t.fields.findIndex(f => re.test(f.trim()));
    g.w = idx(ANKI_WORD); if (g.w < 0) g.w = 0;
    g.m = idx(ANKI_MEANING); if (g.m < 0 || g.m === g.w) g.m = t.fields.length > 1 ? (g.w === 0 ? 1 : 0) : -1;
    groups.push(g);
  }
  if (!groups.length) { openModal('Import from Anki', [h('p', { class: 'm-text' }, 'That package has no notes.')]); return; }
  const usedDecks = new Set(pk.notes.flatMap(n => n.cards.map(c => String(c.odid && +c.odid ? c.odid : c.did))));
  const deckNames = [...usedDecks].map(id => pk.decks.get(id)).filter(n => n && n !== 'Default');
  const hasSound = pk.notes.some(n => /\[sound:/.test(n.flds.join('')));
  const sample = (g, i) => { const n = g.notes.find(x => ankiText(x.flds[i])) || g.notes[0]; return i >= 0 ? ankiText(n.flds[i]).slice(0, 60) : ''; };
  const rows = groups.map((g, gi) => {
    if (g.skip) return h('li', { class: 'ak-type off' }, h('b', null, g.t.name), h('span', { class: 'muted sm' }, `${fmtNum(g.notes.length)} notes · ${g.skip}`));
    const ex = h('p', { class: 'muted xs ak-ex', dir: 'auto' });
    const showEx = () => { ex.textContent = `For example: ${sample(g, g.w) || '—'}${g.m >= 0 ? ' → ' + (sample(g, g.m) || '—') : ''}`; };
    const fsel = (v, none, on) => selectEl([...(none ? [['-1', '(none)']] : []), ...g.t.fields.map((f, i) => [String(i), f])], String(v), x => { on(+x); showEx(); });
    const ws = fsel(g.w, false, v => { g.w = v; }); ws.id = 'ak-w' + gi;
    const ms = fsel(g.m, true, v => { g.m = v; }); ms.id = 'ak-m' + gi;
    showEx();
    return h('li', { class: 'ak-type' },
      h('b', null, g.t.name), h('span', { class: 'muted sm' }, `${fmtNum(g.notes.length)} ${g.notes.length === 1 ? 'note' : 'notes'}`),
      h('div', { class: 'ak-fields' },
        h('label', { for: ws.id }, 'Word'), ws,
        h('label', { for: ms.id }, 'Meaning'), ms),
      ex);
  });
  const deckBox = deckChooser(code, st);
  deckBox.hidden = !!deckNames.length;
  const err = h('p', { class: 'error', role: 'alert' });
  const go = h('button', { class: 'btn primary', type: 'button', id: 'ak-go' }, 'Import');
  go.onclick = async () => {
    go.disabled = true; go.textContent = 'Importing…';
    const kf = keyFn(lang);
    const deckIds = new Map();
    const deckFor = n => {
      if (!(st.keepDecks && deckNames.length)) {
        if (st.newDeck && st.newDeck.trim() && !st.dk) st.dk = addDeck(code, st.newDeck) || '';
        return st.dk || '';
      }
      const c0 = n.cards[0];
      const name = c0 && pk.decks.get(String(+c0.odid ? c0.odid : c0.did));
      if (!name || name === 'Default') return '';
      if (!deckIds.has(name)) deckIds.set(name, addDeck(code, name.split('::').join(' › ')) || '');
      return deckIds.get(name);
    };
    const skipped = { empty: 0, had: 0, cloze: 0 };
    let n = 0, sounds = 0;
    for (const g of groups) {
      if (g.skip) { skipped.cloze += g.notes.length; continue; }
      for (const note of g.notes) {
        const word = ankiText(note.flds[g.w]).split('; ')[0].trim();
        if (!word || /\{\{c\d+::/.test(note.flds.join(''))) { skipped.empty++; continue; }
        const multi = /\s/.test(word);
        const k = multi ? phraseKey(lang, word) : kf(word);
        if (!k) { skipped.empty++; continue; }
        const e = entry(code, k);
        if (e && !e.d && (e.c || e.c2)) { skipped.had++; continue; }
        const patch = { s: 1, f: word, p: multi ? 1 : 0 };
        const m = g.m >= 0 ? ankiText(note.flds[g.m]) : '';
        if (m) patch.m = m; else if (e && e.m) patch.m = e.m;
        g.t.fields.forEach((f, i) => {
          if (i === g.w || i === g.m) return;
          for (const [key, re] of Object.entries(ANKI_EXTRA)) if (re.test(f.trim()) && !patch[key]) { const v = ankiText(note.flds[i]); if (v) patch[key] = v; }
        });
        const byOrd = ord => note.cards.find(c => +c.ord === ord);
        const c1 = byOrd(0) || note.cards[0], c2 = note.cards.length > 1 ? byOrd(1) : null;
        patch.c = st.sched && c1 ? ankiCard(c1, pk.crt, pk.hist) : newCard();
        if (c2) patch.c2 = st.sched ? ankiCard(c2, pk.crt, pk.hist) : newCard();
        else if (S.settings.reverse && patch.m) patch.c2 = newCard();
        patch.dk = deckFor(note);
        if (st.audio && !(e && e.au)) {
          const name = ankiSound(note.flds[g.w]) || ankiSound(note.flds.join(' '));
          const blob = name ? await pk.audio(name).catch(() => null) : null;
          if (blob) { patch.au = (await keepWordAudio(blob)).ref; sounds++; }
        }
        putEntry(code, k, patch);
        n++;
      }
    }
    if (!n) { go.disabled = false; go.textContent = 'Import'; err.textContent = skipped.had ? 'You already have flashcards for all of those words.' : 'None of those notes could be imported.'; return; }
    closeModal();
    const bits = [`Imported ${fmtNum(n)} ${n === 1 ? 'word' : 'words'}`];
    if (sounds) bits.push(`${fmtNum(sounds)} with recordings`);
    const sk = skipped.empty + skipped.had + skipped.cloze;
    if (sk) bits.push(`skipped ${fmtNum(sk)}`);
    openModal('Imported from Anki', [
      h('p', { class: 'm-text' }, bits.join(' · ') + '.'),
      sk ? h('ul', { class: 'm-list' },
        skipped.had ? h('li', null, `${fmtNum(skipped.had)} you already have flashcards for`) : null,
        skipped.cloze ? h('li', null, `${fmtNum(skipped.cloze)} cloze or image occlusion notes`) : null,
        skipped.empty ? h('li', null, `${fmtNum(skipped.empty)} without a word in text (only a picture or sound, for example)`) : null) : null,
      h('div', { class: 'm-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: closeModal }, 'Done')),
    ]);
    if (UI.route === 'words') viewWords(); else if (UI.route === 'library') viewLibrary();
    updateBadge();
  };
  openModal('Import from Anki', [
    h('p', { class: 'm-text' }, `${fmtNum(pk.notes.length)} notes from ${file.name} go into your ${lang.name} words as flashcards. To bring them into another language, switch to it first.`),
    h('ul', { class: 'ak-types' }, rows),
    checkRow('ak-sched', 'Keep Anki’s schedule and review history', st.sched, v => { st.sched = v; }, 'Otherwise the cards start as new.'),
    hasSound ? checkRow('ak-audio', 'Bring the recordings', st.audio, v => { st.audio = v; }, 'They’re kept on this device.') : null,
    deckNames.length ? checkRow('ak-decks', `Keep Anki’s decks (${deckNames.length === 1 ? deckNames[0].split('::').join(' › ') : fmtNum(deckNames.length) + ' decks'})`, st.keepDecks, v => { st.keepDecks = v; deckBox.hidden = v; }) : null,
    deckBox,
    err,
    h('div', { class: 'm-actions' }, go),
  ], { wide: true });
}

/* ---------- options ---------- */
function viewOptions() {
  const v = $('#view');
  v.replaceChildren();
  if (Cloud.via === 'site') refreshUsage(); // fills in the storage bar when it arrives
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
      checkRow('o-au', 'Play recordings on flashcards automatically', st.autoAudio !== false, x => setSettings({ autoAudio: x })),
      checkRow('o-rev', 'Give each new flashcard word a reverse card too (meaning → word)', st.reverse, x => setSettings({ reverse: x })),
      (() => {
        const missing = [];
        for (const l of st.langs) if (S.loaded.has(l.code)) for (const [k, e] of vmap(l.code)) if (!e.d && e.s === 1 && e.c && !e.c2) missing.push([l.code, k]);
        return missing.length ? h('div', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => {
          for (const [code, k] of missing) putEntry(code, k, { c2: newCard() });
          toast(`Added ${fmtNum(missing.length)} reverse card${missing.length === 1 ? '' : 's'}`);
          viewOptions(); updateBadge();
        } }, `Add reverse cards to ${fmtNum(missing.length)} existing word${missing.length === 1 ? '' : 's'}`)) : null;
      })(),
      h('p', { class: 'muted sm' }, 'Group a language’s flashcards into decks from its Words page. To start over, you can delete every flashcard; your words and meanings stay.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => { go('words'); setTimeout(() => openDecks(), 50); } }, `${L().name} decks`),
        h('button', { class: 'btn danger', type: 'button', onclick: deleteEveryCard }, 'Delete all flashcards'))),
    ACCT ? h('section', { class: 'opt' },
      h('h2', { class: 'sec' }, 'Account'),
      h('p', { class: 'muted' }, Acct.user
        ? `Signed in as ${(Acct.profile && Acct.profile.display_name) || Acct.user.email || 'you'}. Texts, word lists and OCR models you share are kept in your account.`
        : 'Optional. Sign in to keep texts, word lists and OCR models online, and share them by link or in the shared library.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => go('account') }, Acct.user ? 'Your account' : 'Sign in'),
        h('button', { class: 'btn', type: 'button', onclick: () => go('shared') }, 'Shared library')),
      h('h3', { class: 'sub' }, 'Sharing meanings'),
      h('p', { class: 'muted sm' }, 'Meanings you share appear as suggestions when other learners tap the same word, together with any dialect, Persian equivalent and source you add. ' + GLOSS_NOTICE),
      checkRow('o-share', 'Share the meanings I save from now on', !!st.shareAll, async x => {
        if (x && !Acct.user) { setSettings({ shareAll: false }); acctSignIn('options'); viewOptions(); return; }
        if (x && !(await glossConsent())) { viewOptions(); return; }
        setSettings({ shareAll: x });
      }),
      h('p', { class: 'muted xs' }, 'You can also share or stop sharing a single word from its panel.')) : null,
    window.claude ? h('section', { class: 'opt' },
      h('h2', { class: 'sec' }, 'Claude'),
      h('p', { class: 'muted' }, Cloud.sample
        ? `Claude can suggest meanings, translate sentences${Cloud.imageOCR ? ' and transcribe photos and scanned PDFs' : ''}. Each request uses your Claude usage.`
        : 'Claude suggestions aren’t available in this view.'),
      checkRow('o-ai', 'Show “Ask Claude” in the word panel', st.ai, x => setSettings({ ai: x })),
      field('o-tier', 'Suggestion speed', tier)) : geminiOptions(st, tier),
    h('section', { class: 'opt' },
      h('h2', { class: 'sec' }, 'Saving and backup'),
      h('p', null, h('span', { class: 'sync-inline', id: 'opt-sync' }, syncText)),
      usageBox(),
      h('p', { class: 'muted' }, Cloud.state === 'local'
        ? (ACCT
          ? 'Your texts and words are kept in this browser. Sign in to save them to your account and read on any device, or back up regularly so nothing is lost if the browser clears its storage.'
          : 'Your texts and words are kept in this browser. Back up regularly so nothing is lost if the browser clears its storage. To move to another device, restore the backup file there.')
        : Cloud.via === 'site'
          ? 'Your texts, words and flashcards are saved to your account, privately, and appear on any device where you sign in. Recordings stay on the device where you added them.'
          : 'Your texts, words and flashcards are saved to your Claude account, privately, and appear on any device where you open this page.'),
      Cloud.state === 'local' && ACCT && !Acct.user ? h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => acctSignIn('options') }, 'Sign in with Google')) : null,
      Cloud.state === 'local' ? h('p', { class: 'muted sm', id: 'o-last-backup' }, S.meta.backupAt ? `Last backup: ${daysAgo(S.meta.backupAt)}.` : 'No backup saved from this browser yet.') : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: async () => { if (await saveBackupFile() && UI.route === 'options') viewOptions(); } }, 'Back up everything')),
      field('o-restore', 'Restore from a backup file', restoreIn, 'Adds the backup’s texts and words. Anything newer here is kept.')),
    h('section', { class: 'opt' },
      h('h2', { class: 'sec' }, 'How it works'),
      h('ul', { class: 'help' },
        h('li', null, `Words you haven’t met are underlined in teal. Tap one to see its panel, write a meaning${Cloud.sample ? ` or ask ${aiName()}` : ' (the dictionary links help)'}, and add it as a flashcard.`),
        h('li', null, 'Words you’re learning are shaded terracotta. The shade fades as a word’s flashcard becomes well known.'),
        h('li', null, 'Turning the page marks the underlined words you didn’t tap as known. You can undo it, or switch it off above.'),
        h('li', null, 'Tap “+ word after” in the panel to save a phrase, such as a compound verb.'),
        h('li', null, 'Keyboard: ← → move between words · K known · L learning · I ignore · A add flashcard · [ ] turn pages · in review, Space shows the answer, 1–4 grade it and R plays the recording.'),
        h('li', null, 'Words can have a recording: words from a course come with the course’s recordings, and you can add your own in a word’s panel, under Recording.'))),
    SITE ? h('section', { class: 'opt' },
      h('h2', { class: 'sec' }, 'About'),
      h('p', null, `Khānesh is a free reader for language learners, hosted by ${SITE.name}. ${ACCT ? 'Your texts and words stay in this browser unless you sign in, which saves them to your account.' : 'It has no server: your texts and words stay in this browser.'}`),
      h('ul', { class: 'help' },
        h('li', null, h('a', { href: SITE.guide }, 'Reader guide'), ': importing texts, flashcards, Anki, scanned books and recordings'),
        h('li', null, h('a', { href: SITE.home }, `${SITE.name} home`)),
        h('li', null, 'Free for noncommercial use under the ', h('a', { href: 'LICENSE.txt' }, 'PolyForm Noncommercial License'), '; fonts and libraries are listed in ', h('a', { href: 'THIRD-PARTY.txt' }, 'their own notices'), '.'))) : null));
}

/* ---------- start-up ---------- */
async function boot(hot) {
  await Local.open();
  // A phone's browser can leave an earlier Khānesh (such as the word import over a course page) holding
  // the storage open; then reading waits forever. Say so, rather than show an empty page.
  let first;
  try { first = await withTimeout(Promise.all(['settings', 'stats', 'lessons', 'pending', 'meta'].map(k => Local.get(k))), 8000, 'reading'); }
  catch (e) {
    if (e && e.code === 'timeout') throw new Error('Khānesh couldn’t read the words saved in this browser, probably because another Khānesh is still open in a tab or in the background. Close other Zabanestan tabs, then reload this page');
    throw e;
  }
  const [st, stats, lessons, pending, meta] = first;
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
  courseWordsIncoming().catch(err => console.error(err));
}

/* Words sent from a course page on the website ("Add these words to Khānesh"), through this browser's
   storage: shown in the word import, ready to add as learning words. */
const EMBED = document.documentElement.classList.contains('embed');
function tellCourse(msg) { if (EMBED) try { window.parent.postMessage(msg, location.origin); } catch { } }
async function courseWordsIncoming() {
  let got = null;
  try {
    got = JSON.parse(localStorage.getItem('khanesh-incoming-words') || 'null');
    localStorage.removeItem('khanesh-incoming-words');
  } catch { return; }
  if (!got || !got.lang || !Array.isArray(got.lines) || !got.lines.length || Date.now() - (got.at || 0) > 3600000) { tellCourse({ type: 'khanesh-import-closed', n: 0 }); return; }
  const before = S.settings.cur;
  useLang(got.lang, got.name);
  if (S.settings.cur !== got.lang) await switchLang(got.lang);
  if (!EMBED && UI.route !== 'words') go('words');
  let added = 0;
  openWordImport(got.lines.map(String).join('\n'), { as: 'learning', keep: true, pick: true,
    onImported: n => { added = n; },
    // over a course page: save, put Khānesh back on the language you were reading, then hand back to the course
    onClose: !EMBED ? null : () => (async () => {
      if (before && before !== got.lang && L(before)) await switchLang(before);
      await Persist.write();
      // let go of this browser's storage, so a Khānesh opened next isn't kept waiting by this frame
      if (Sync.has()) { try { await withTimeout(Sync.flush(), 10000, 'save'); } catch { /* kept for next time */ } }
      if (Local.idb) { try { Local.idb.close(); } catch { } Local.idb = null; Local.mode = 'memory'; }
    })().catch(e => console.error(e)).then(() => tellCourse({ type: 'khanesh-import-closed', n: added })),
    note: `From ${String(got.from || 'a course')}. Checked words will be imported to Khānesh reader as flashcards. Leave words checked or unchecked, and mark as known or unknown according to your preferences.` });
  tellCourse({ type: 'khanesh-import-open' });
}
function start(hot) {
  boot(hot || {}).catch(err => {
    console.error(err);
    const v = $('#view');
    if (v) v.replaceChildren(h('p', { class: 'error' }, 'Khānesh couldn’t start: ' + ((err && err.message) || err) + '. Reload the page to try again.'));
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

/* Options › AI help, on the website: the person's own Gemini key, kept in this browser. */
function geminiOptions(st, tier) {
  const on = !!(Cloud.sample && Cloud.sample.provider === 'Gemini');
  const sec = h('section', { class: 'opt', id: 'opt-ai' }, h('h2', { class: 'sec' }, 'AI help'));
  if (on) {
    sec.append(
      h('p', null, 'Gemini is on. It can suggest meanings, translate sentences and transcribe photos and scanned PDFs.'),
      h('p', { class: 'muted' }, 'Your key is kept only in this browser, and requests go straight from here to Google. On Google’s free tier, what you send may be used to improve Google’s products, so don’t send anything private.'),
      checkRow('o-ai', 'Show “Ask Gemini” in the word panel', st.ai, x => setSettings({ ai: x })),
      field('o-tier', 'Suggestion speed', tier),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => {
        Gemini.forget(); connectGemini(); toast('Gemini key removed from this browser'); viewOptions();
      } }, 'Remove my key')));
    return sec;
  }
  const input = h('input', { id: 'o-gkey', class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', dir: 'ltr', placeholder: 'Paste your key' });
  const msg = h('p', { class: 'sm', role: 'status', 'aria-live': 'polite' });
  const save = h('button', { class: 'btn primary', type: 'button' }, 'Turn on');
  const go_ = async () => {
    const key = input.value.trim();
    if (!key) { msg.className = 'error sm'; msg.textContent = 'Paste your key first.'; return; }
    save.disabled = true; msg.className = 'muted sm'; msg.textContent = 'Checking the key…';
    try {
      const models = await geminiCheckKey(key);
      Gemini.remember(key, models);
      connectGemini();
      toast('Gemini is on');
      viewOptions();
      const el = document.getElementById('opt-ai'); if (el) el.scrollIntoView({ block: 'start' });
    } catch (e) {
      save.disabled = false; msg.className = 'error sm';
      msg.textContent = e.code === 'new_key_refused' ? 'Google refused this new-style key. This is a known problem on Google’s side: delete your keys on the Google AI Studio key page, create a new one there, and try again.'
        : e.code === 'bad_key' ? 'Google didn’t accept that key. Check that you copied all of it, and if you made it just now, wait a minute and try again.'
        : e.code === 'offline' ? 'Couldn’t reach Google. Check your connection and try again.'
        : e.code === 'region' ? 'Gemini isn’t available in your region.'
        : e.code === 'no_models' ? 'That key works, but it has no Gemini models that can write text.'
        : e.code === 'rate_limited' ? 'Google is busy right now. Try again in a minute.'
        : 'Something went wrong checking the key. Try again.';
    }
  };
  save.addEventListener('click', go_);
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') go_(); });
  sec.append(
    h('p', null, 'Get suggestions for meanings, sentence translations and transcriptions of scanned pages from Google’s Gemini. It needs a key, which is free with any Google account and takes about a minute to get:'),
    h('ol', { class: 'steps' },
      h('li', null, 'Open ', h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'Google AI Studio’s key page'), ' and sign in with your Google account. The first time, accept Google’s terms.'),
      h('li', null, 'Tap ', h('b', null, 'Create API key'), '. If it asks for a project, choose any one or let it make a new one.'),
      h('li', null, 'Copy the key it shows. It’s a long code that starts with ', h('code', null, 'AQ.'), ' (older keys start with ', h('code', null, 'AIza'), ').'),
      h('li', null, 'Come back here, paste it below and tap ', h('b', null, 'Turn on'), '.')),
    SITE ? h('p', { class: 'muted sm' }, 'Stuck? The ', h('a', { href: SITE.guide + '#ai' }, 'reader guide'), ' has the steps in more detail, with answers to common problems.') : null,
    field('o-gkey', 'Gemini key', input, 'Kept only in this browser. It isn’t saved to your account or sent anywhere but Google.'),
    msg,
    h('div', { class: 'actions' }, save),
    checkRow('o-ai-hint', 'Mention AI help in the word panel', st.ai !== false, x => setSettings({ ai: x })));
  return sec;
}

/* Options › Saving: how much of the account's storage is in use, and what to do when it's full. */
function fmtBytes(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
function usageBox() {
  const u = Cloud.usage;
  if (Cloud.via !== 'site' || !u) return h('div', { id: 'opt-usage', hidden: true });
  const pct = Math.min(100, Math.round((u.used / u.limit) * 100));
  const tight = Sync.full || Sync.held.size > 0 || u.texts > u.text_limit * 0.9;
  const box = h('div', { id: 'opt-usage', class: 'usage' },
    h('p', { class: 'sm' }, `Using ${fmtBytes(u.used)} of ${fmtBytes(u.limit)} in your account`),
    h('div', { class: 'progress usage-bar' + (tight ? ' tight' : ''), role: 'progressbar', 'aria-label': 'Account storage used', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) },
      h('i', { style: `width: ${pct}%` })));
  if (!tight) return box;
  const largest = (u.largest || []).map(x => {
    const m = S.lessons.get(x.lesson);
    return m && !m.del ? h('li', null, h('span', { dir: 'auto' }, m.title), h('span', { class: 'muted' }, ` · ${fmtBytes(x.bytes)}`)) : null;
  }).filter(Boolean);
  const n = Sync.held.size;
  box.append(
    h('p', { class: 'sm' }, Sync.full
      ? 'Your account is full, so new changes are saved only in this browser until there’s room.'
      : n ? `Your account has no room for more texts, so ${n === 1 ? 'one text is' : `${n} texts are`} saved only in this browser. Your words and flashcards still sync.`
        : 'Your account is nearly full. Texts take up most of the space; words and flashcards take very little.'),
    largest.length ? h('p', { class: 'muted sm' }, 'Your largest texts:') : null,
    largest.length ? h('ul', { class: 'usage-list sm' }, largest) : null,
    h('p', { class: 'muted sm' }, 'To make room, delete texts you’ve finished from the Library. Their words and flashcards stay. Texts waiting in this browser are added to your account as soon as there’s space.'));
  return box;
}

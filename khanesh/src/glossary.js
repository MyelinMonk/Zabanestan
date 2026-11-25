/* ---------- shared meanings ----------
   On the website, people can share the meaning they gave a word (with an optional dialect or place,
   Persian equivalent and source). Anyone who taps the same word sees shared meanings as suggestions,
   with how many people gave each one, best first. Signed-in learners can vote a suggestion up or down,
   which only changes the order: nothing is hidden by votes. Sharing is off unless the person switches it on, for a word or
   for all their words, and the first time they're told how shared meanings may be used.
   The rules live in the database (supabase/schema.sql, "shared word meanings"). */
const GLOSS_NOTICE = 'Shared meanings are public: anyone using the reader can see them, without your name. By sharing, you agree that Zabanestan may use them in its learning materials, such as dictionaries, under the CC BY-SA 4.0 license.';
const Glossary = {
  cache: new Map(), // `${lang}\n${key}` → suggestions (array), or a promise while loading
  on() { return !!ACCT && !window.claude; },
  okLang(code) { return /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(code || ''); },
};

// Suggestions for some words of one language, from cache when we have them.
async function glossFetch(code, keys) {
  if (!Glossary.on() || !Glossary.okLang(code)) return new Map();
  const out = new Map(), want = [];
  for (const k of new Set(keys)) {
    const c = Glossary.cache.get(code + '\n' + k);
    if (Array.isArray(c)) out.set(k, c); else want.push(k);
  }
  for (let i = 0; i < want.length; i += 400) {
    const part = want.slice(i, i + 400);
    let rows = [];
    try {
      await acctClient();
      const { data, error } = await Acct.client.rpc('gloss_suggestions', { p_lang: code, p_keys: part });
      if (error) throw error;
      rows = data || [];
    } catch { return out; } // offline, or the service isn't there: no suggestions this time
    for (const k of part) out.set(k, []);
    for (const r of rows) out.get(r.word_key) && out.get(r.word_key).push(r);
    for (const k of part) Glossary.cache.set(code + '\n' + k, out.get(k));
  }
  return out;
}

// After a word's entry changes: share it, update it or take it back, as its switch says.
function glossQueue(code, key) {
  if (!Glossary.on() || !Glossary.okLang(code)) return;
  const q = S.meta.glossQ || (S.meta.glossQ = {});
  q[code + '\n' + key] = 1;
  Persist.touch();
  clearTimeout(glossQueue.t);
  glossQueue.t = setTimeout(glossFlush, 1500);
}
async function glossFlush() {
  const q = S.meta.glossQ;
  if (!q || !Object.keys(q).length || !Acct.user || glossFlush.running) return;
  glossFlush.running = true;
  try {
    for (const id of Object.keys(q)) {
      const [code, key] = id.split('\n');
      const e = entry(code, key);
      const T = Acct.client.from('glosses');
      let res;
      if (e && e.sh && e.m) {
        res = await T.upsert({
          author: Acct.user.id, lang: code, word_key: key.slice(0, 80), word: (e.f || key).slice(0, 80),
          meaning: e.m.slice(0, 300), dialect: (e.dl || '').slice(0, 80), persian: (e.fa || '').slice(0, 80), source: (e.sr || '').slice(0, 200),
        }, { onConflict: 'author,lang,word_key' });
      } else {
        res = await T.delete().eq('author', Acct.user.id).eq('lang', code).eq('word_key', key);
      }
      if (res && res.error) {
        if (/a lot of words today/.test(res.error.message || '')) { toast('You’ve shared a lot of words today. The rest will be shared tomorrow.'); break; }
        if (/violates check constraint/.test(res.error.message || '')) { delete q[id]; continue; } // too long, or not a language code we can share
        break; // offline: try again later
      }
      delete q[id];
      Glossary.cache.delete(code + '\n' + key);
    }
    Persist.touch();
  } catch { /* try again later */ } finally { glossFlush.running = false; }
}

// The first time someone shares, say how shared meanings may be used.
async function glossConsent() {
  if (S.meta.glossOk) return true;
  const ok = await confirmBox('Share with other learners?', GLOSS_NOTICE, 'Share');
  if (ok) { S.meta.glossOk = 1; Persist.touch(); }
  return ok;
}

// In the word panel: suggestions from other learners, and the switch to share this word.
function glossPanel(ctx) {
  if (!Glossary.on() || !Glossary.okLang(ctx.code)) return null;
  const box = h('div', { class: 'gl', id: 'f-gl' });
  const list = h('div', { class: 'gl-list', 'aria-live': 'polite' });
  const e = entry(ctx.code, ctx.key);
  const shared = !!(e && e.sh);
  const sw = h('input', { type: 'checkbox', id: 'f-sh', checked: shared || (!e && !!S.settings.shareAll) });
  sw.addEventListener('change', async () => {
    if (sw.checked && !Acct.user) { sw.checked = false; acctSignIn('word'); return; }
    if (sw.checked && !(await glossConsent())) { sw.checked = false; return; }
    commitSheet();
    const cur = entry(ctx.code, ctx.key);
    if (cur || sw.checked) putEntry(ctx.code, ctx.key, { ...readFields(), ...contextPatch(ctx, cur), sh: sw.checked ? 1 : 0 });
    glossQueue(ctx.code, ctx.key);
    afterEntryChange(ctx);
    toast(sw.checked ? (readFields().m ? 'Shared with other learners' : 'This word’s meaning will be shared once you write one') : 'No longer shared');
  });
  box.append(list,
    h('label', { class: 'gl-share', for: 'f-sh' }, sw,
      h('span', null, Acct.user ? 'Share this meaning with other learners' : 'Share this meaning with other learners (sign in first)')));
  // load suggestions without holding up the panel
  glossFetch(ctx.code, [ctx.key]).then(m => {
    if (UI.sheet !== ctx || !box.isConnected) return;
    const rows = (m.get(ctx.key) || []).filter(r => !(r.mine && r.people === 1));
    if (!rows.length) return;
    list.replaceChildren(h('p', { class: 'gl-head' }, 'From other learners'),
      ...rows.slice(0, 5).map(r => glossRow(ctx, r)));
  });
  return box;
}
function glossRow(ctx, r) {
  const use = () => {
    const m = $('#f-m'), fa = $('#f-fa'), dl = $('#f-dl'), sr = $('#f-sr');
    if (m) m.value = r.meaning;
    if (fa && !fa.value.trim() && r.persian && r.persian[0]) fa.value = r.persian[0];
    if (sr && !sr.value.trim() && r.sources && r.sources[0]) sr.value = r.sources[0];
    if (dl && !dl.value.trim() && r.dialects && r.dialects.length === 1) dl.value = r.dialects[0];
    commitSheet(); renderSheet();
  };
  const bits = [];
  if (r.dialects && r.dialects.length) bits.push(h('span', null, (r.dialects.length > 1 ? 'Dialects: ' : 'Dialect: ') + r.dialects.join(', ')));
  if (r.persian && r.persian.length) bits.push(h('span', null, 'Persian: ', h('span', { lang: 'fa', dir: 'rtl' }, r.persian.join('، '))));
  if (r.sources && r.sources.length) bits.push(h('span', null, 'Source: ' + r.sources.join('; ')));
  const row = h('div', { class: 'gl-item' },
    h('div', { class: 'gl-main' },
      h('span', { class: 'gl-m', dir: 'auto' }, r.meaning),
      h('span', { class: 'muted xs' }, r.people === 1 ? '1 person' : `${r.people} people`)),
    bits.length ? h('p', { class: 'gl-bits muted xs' }, bits) : null,
    h('div', { class: 'gl-act' },
      h('button', { class: 'btn sm', type: 'button', onclick: use }, 'Use this'),
      // you can't vote on a meaning you gave yourself: you're already counted among its people
      !r.mine ? glossVotes(ctx, r, () => row.replaceWith(glossRow(ctx, r))) : null,
      !r.mine ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => glossReport(r) }, 'Report') : null));
  return row;
}
function glossVotes(ctx, r, redraw) {
  const b = (v, label, glyph, n) => h('button', {
    class: 'btn sm gl-vote', type: 'button', 'aria-pressed': String((r.my_vote || 0) === v),
    'aria-label': `${label} (${n})`, title: label, onclick: () => glossVote(ctx, r, v, redraw),
  }, h('span', { 'aria-hidden': 'true' }, glyph), h('span', { 'aria-hidden': 'true' }, String(n)));
  return h('span', { class: 'gl-votes', role: 'group', 'aria-label': 'Vote on this meaning' },
    b(1, 'Good meaning', '▲', r.ups || 0), b(-1, 'Not right', '▼', r.downs || 0));
}
// Vote a suggestion up or down; the same vote again takes it back.
async function glossVote(ctx, r, v, redraw) {
  if (!Acct.user) { acctSignIn('word'); return; }
  const was = r.my_vote || 0, now = was === v ? 0 : v;
  const T = Acct.client.from('gloss_votes');
  const key = { lang: ctx.code, word_key: ctx.key.slice(0, 80), meaning_key: r.meaning.trim().toLowerCase().slice(0, 300) };
  const res = now
    ? await T.upsert({ voter: Acct.user.id, ...key, vote: now }, { onConflict: 'voter,lang,word_key,meaning_key' })
    : await T.delete().eq('voter', Acct.user.id).eq('lang', key.lang).eq('word_key', key.word_key).eq('meaning_key', key.meaning_key);
  if (res && res.error) { toast(/voted a lot today/.test(res.error.message || '') ? 'You’ve voted a lot today. Try again tomorrow.' : 'Couldn’t save your vote. Try again later.'); return; }
  if (was === 1) r.ups--; else if (was === -1) r.downs--;
  if (now === 1) r.ups = (r.ups || 0) + 1; else if (now === -1) r.downs = (r.downs || 0) + 1;
  r.my_vote = now;
  Glossary.cache.delete(ctx.code + '\n' + ctx.key);
  redraw();
}
async function glossReport(r) {
  if (!Acct.user) { acctSignIn('report'); return; }
  if (!(await confirmBox('Report this meaning?', `“${r.meaning}” will be checked by the Zabanestan team. Report it if it’s abusive or spam. If it’s just not right, vote it down instead.`, 'Report'))) return;
  const rows = (r.ids || []).map(id => ({ gloss: id, reason: 'reported from the reader' }));
  const { error } = await Acct.client.from('gloss_reports').upsert(rows, { onConflict: 'gloss,reporter', ignoreDuplicates: true });
  toast(error ? 'Couldn’t send the report. Try again later.' : 'Thanks. The team will take a look.');
}

/* ---------- interlinear glosses ----------
   Reading option: a short meaning under each word, like an interlinear edition. It comes from the
   reader's own meaning first, then (on the website) the meaning other learners agree on most, then,
   if chosen, an AI suggestion for the new and learning words that still have none. */
const GLOSS_MODES = [['off', 'Off'], ['mine', 'Your meanings'], ['shared', 'Yours, then other learners’']];
function glossModes() {
  const m = GLOSS_MODES.filter(([v]) => v !== 'shared' || Glossary.on());
  if (Cloud.sample) m.push(['ai', `Yours, ${Glossary.on() ? 'other learners’, ' : ''}then ${aiName()}’s for the rest`]);
  return m;
}
function glossMode() {
  const m = S.settings.gloss || 'off';
  return glossModes().some(([v]) => v === m) ? m : (m === 'off' ? 'off' : 'mine');
}
function shortGloss(m) {
  let s = String(m || '').split(/[;\n]/)[0].trim();
  if (s.length > 28) s = s.slice(0, 27).trim() + '…';
  return s;
}
// Put the glosses on the words of the current page (and again when a meaning changes).
async function glossPage(R, onlyKeys) {
  const box = $('#rtext');
  const mode = glossMode();
  if (!box) return;
  box.classList.toggle('glossed', mode !== 'off');
  if (mode === 'off' || !R || UI.reader !== R) return;
  const code = R.lang.code;
  const keys = onlyKeys || [...R.spans.keys()];
  const set = (k, g, src) => {
    for (const sp of R.spans.get(k) || []) {
      if (g) { sp.dataset.g = g; sp.dataset.gs = src; } else { delete sp.dataset.g; delete sp.dataset.gs; }
    }
  };
  const need = [];
  for (const k of keys) {
    const e = entry(code, k);
    if (e && e.m) set(k, shortGloss(e.m), 'own');
    else { set(k, '', ''); need.push(k); }
  }
  if (!need.length) return;
  const page = R.page;
  let rest = need;
  if (mode === 'shared' || mode === 'ai') {
    const found = await glossFetch(code, need);
    if (UI.reader !== R || R.page !== page) return;
    rest = [];
    for (const k of need) {
      const top = (found.get(k) || [])[0];
      if (top && top.people + (top.ups || 0) - (top.downs || 0) > 0 && !entry(code, k)?.m) set(k, shortGloss(top.meaning), 'shared'); else rest.push(k);
    }
  }
  if (mode !== 'ai' || !Cloud.sample) return;
  // AI only for words still being learned; known and ignored words get no request
  R.aiGloss = R.aiGloss || new Map();
  const ask = [];
  for (const k of rest) {
    const st = (entry(code, k) || {}).s || 0;
    if (st === 2 || st === 3) continue;
    if (R.aiGloss.has(k)) { set(k, R.aiGloss.get(k), 'ai'); continue; }
    ask.push(k);
  }
  if (!ask.length) return;
  const forms = new Map();
  for (const k of ask) { const sp = (R.spans.get(k) || [])[0]; if (sp) forms.set(sp.textContent, k); }
  const pageText = R.flat.length ? [...new Set(R.flat.map(sp => sp.closest('p')))].map(p => p.textContent).join('\n').slice(0, 4000) : '';
  const words = [...forms.keys()].slice(0, 120);
  try {
    const r = await Cloud.sample.json(
      `Here is a passage in ${R.lang.name}:\n\n${pageText}\n\nFor each of these words from the passage, give a very short ${R.lang.gloss || 'English'} gloss (1–3 words) of what it means in this passage. Reply with only a JSON object whose keys are the words exactly as listed and whose values are the glosses.\n\n${JSON.stringify(words)}`,
      { modelTier: 'quick', cache: { gcTime: 86400000 } });
    if (UI.reader !== R || R.page !== page || !r || typeof r !== 'object') return;
    for (const [form, g] of Object.entries(r)) {
      const k = forms.get(form);
      if (!k || typeof g !== 'string' || !g.trim() || entry(code, k)?.m) continue;
      R.aiGloss.set(k, shortGloss(g));
      set(k, shortGloss(g), 'ai');
    }
  } catch (e) {
    if (!glossPage.warned) { glossPage.warned = true; toast(aiErrorText(e)); }
  }
}

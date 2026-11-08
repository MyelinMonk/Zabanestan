'use strict';
/* =====================================================================
   Khwānish · core: utilities, languages, tokenizer, FSRS scheduler
   ===================================================================== */
const APPV = 2;
// Set by the website build (window.KH_SITE): where the page keeps its own copies
// of the PDF and Anki libraries, and links back to the site that hosts it.
const SITE = (typeof window !== 'undefined' && window.KH_SITE) || null;
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const ROLLOVER = 4 * HOUR; // a "day" starts at 4 am local time, as in Anki

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let lateValue;
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') lateValue = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  if (lateValue !== undefined) el.value = lateValue;
  return el;
}

// For the DOM's own append() and replaceChildren(), which print null and arrays as text instead of skipping them.
const nodes = (...xs) => xs.flat(Infinity).filter(x => x != null && x !== false);
// Load a script once; resolves when it has run, rejects if it can't be fetched.
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => res();
    s.onerror = () => { s.remove(); rej(new Error('Couldn’t load ' + src)); };
    document.head.append(s);
  });
}
// A library path relative to the page, made absolute (workers need a full address).
const absUrl = u => /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : new URL(u, document.baseURI).href;
// "today", "yesterday", "5 days ago"
function daysAgo(ts) {
  const n = Math.round((dayStart() - dayStart(ts)) / DAY); // round: days around a clock change last 23 or 25 hours
  return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function hash32(s) {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193); }
  return x >>> 0;
}
const pad2 = n => String(n).padStart(2, '0');
function dayKey(ts = Date.now()) {
  const d = new Date(ts - ROLLOVER);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function dayStart(ts = Date.now()) {
  const d = new Date(ts - ROLLOVER); d.setHours(0, 0, 0, 0);
  return d.getTime() + ROLLOVER;
}
function fmtIvl(ms) {
  if (ms < HOUR) return Math.max(1, Math.round(ms / MIN)) + 'm';
  if (ms < DAY) return Math.round(ms / HOUR) + 'h';
  const d = ms / DAY;
  if (d < 30) return Math.round(d) + 'd';
  if (d < 365) return (d / 30).toFixed(1).replace(/\.0$/, '') + 'mo';
  return (d / 365).toFixed(1).replace(/\.0$/, '') + 'y';
}
function relDue(ts, now = Date.now()) {
  const ms = ts - now;
  if (ms <= 0) return 'due now';
  return 'due in ' + fmtIvl(ms);
}
const fmtNum = n => Number(n || 0).toLocaleString('en-US');
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej({ code: 'timeout', message: (label || 'request') + ' timed out' }), ms); }),
  ]);
}
const enc = new TextEncoder();
const utf8len = s => enc.encode(s).length;
async function pool(items, n, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const it = items[i++]; await fn(it); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

/* ---------------------------------------------------------------------
   Languages
   --------------------------------------------------------------------- */
// Normalisation profiles. eq = letter equivalences used when matching words
// (the text itself is never changed); marks = ignore optional Arabic/Hebrew
// vowel signs; stress = ignore acute/grave stress accents (Cyrillic textbooks).
const PROFILES = {
  perso:    { eq: 'ي=ی ك=ک ى=ی ۀ=ه', marks: true },
  kurd:     { eq: 'ي=ی ك=ک ى=ی', marks: true },
  pashto:   { eq: 'ك=ک', marks: true },
  balochi:  { eq: 'ي=ی ك=ک ى=ی', marks: true },
  urdu:     { eq: 'ي=ی ك=ک', marks: true },
  arabic:   { marks: true },
  hebrew:   { marks: true },
  cyrl:     { stress: true },
  ossetian: { stress: true, eq: 'æ=ӕ' },
  latin:    {},
  french:   { elisions: "l' d' j' m' n' s' t' c' qu' jusqu' lorsqu' puisqu' quoiqu'" },
  zaza:     { caseLocale: 'tr' },
  azeri:    { caseLocale: 'az' },
  mixed:    { eq: 'ي=ی ك=ک ى=ی', marks: true },
  mixedAz:  { eq: 'ي=ی ك=ک ى=ی', marks: true, caseLocale: 'az' },
  pali:     { eq: 'ṁ=ṃ' },
  sanskrit: { eq: 'ṁ=ṃ r̥̄=ṝ r̥=ṛ l̥̄=ḹ l̥=ḷ' },
};

const DICTS = {
  wikt: s => ({ n: 'Wiktionary', u: 'https://en.wiktionary.org/wiki/Special:Search?search={w}&go=Go' + (s ? '#' + s.replace(/ /g, '_') : '') }),
  glosbe: c => ({ n: 'Glosbe', u: `https://glosbe.com/${c}/en/{w}` }),
  gt: c => ({ n: 'Google Translate', u: `https://translate.google.com/?sl=${c || 'auto'}&tl=en&text={w}&op=translate` }),
  vajehyab: () => ({ n: 'Vajehyab', u: 'https://vajehyab.com/?q={w}' }),
  abadis: () => ({ n: 'Abadis', u: 'https://abadis.ir/fatofa/{w-}/' }),
  steingass: () => ({ n: 'Steingass', u: 'https://dsal.uchicago.edu/cgi-bin/app/steingass_query.py?qs={w}&searchhws=yes' }),
  dpd: () => ({ n: 'DPD', u: 'https://www.dpdict.net/?q={w}' }),
  pts: () => ({ n: 'PTS (DSAL)', u: 'https://dsal.uchicago.edu/cgi-bin/app/pali_query.py?qs={w}&searchhws=yes' }),
  learnsanskrit: () => ({ n: 'LearnSanskrit', u: 'https://www.learnsanskrit.cc/translate?search={w}&dir=au' }),
  wordreference: () => ({ n: 'WordReference', u: 'https://www.wordreference.com/fren/{w}' }),
  cnrtl: () => ({ n: 'CNRTL', u: 'https://www.cnrtl.fr/definition/{w}' }),
  larousse: () => ({ n: 'Larousse', u: 'https://www.larousse.fr/dictionnaires/francais/{w}' }),
  dwds: () => ({ n: 'DWDS', u: 'https://www.dwds.de/wb/{w}' }),
};

// grp: mine | iranian | indic | other.  roster: Zabanestan Core Roster.
const CATALOG = [
  // the six study languages
  { code: 'fa', name: 'Persian', native: 'فارسی', grp: 'mine', prof: 'perso', gt: 'fa', wikt: 'Persian', tts: 'fa', x: ['vajehyab', 'abadis', 'steingass'] },
  { code: 'mzn', name: 'Mazandarani', native: 'مازرونی', grp: 'mine', roster: true, prof: 'perso', wikt: 'Mazanderani', glosbe: 'mzn' },
  { code: 'fr', name: 'French', native: 'français', grp: 'mine', prof: 'french', gt: 'fr', wikt: 'French', tts: 'fr', x: ['wordreference', 'cnrtl', 'larousse'] },
  { code: 'tg', name: 'Tajik', native: 'тоҷикӣ', grp: 'mine', prof: 'cyrl', gt: 'tg', wikt: 'Tajik', glosbe: 'tg' },
  { code: 'pi', name: 'Pali', native: 'pāḷi', grp: 'mine', prof: 'pali', wikt: 'Pali', x: ['dpd', 'pts'], nogt: true },
  { code: 'sa', name: 'Sanskrit', native: 'संस्कृतम्', grp: 'mine', prof: 'sanskrit', gt: 'sa', wikt: 'Sanskrit', x: ['learnsanskrit'] },
  // Zabanestan Core Roster
  { code: 'glk', name: 'Gilaki', native: 'گیلکی', grp: 'iranian', roster: true, prof: 'perso', wikt: 'Gilaki', glosbe: 'glk' },
  { code: 'smy', name: 'Semnani', native: 'سمنانی', grp: 'iranian', prof: 'perso', wikt: 'Semnani' },
  { code: 'tly', name: 'Taleshi', native: 'تالشی · Tolışi', grp: 'iranian', roster: true, prof: 'mixedAz', wikt: 'Talysh', glosbe: 'tly' },
  { code: 'haz', name: 'Hazaragi', native: 'هزارگی', grp: 'iranian', roster: true, prof: 'perso', wikt: 'Hazaragi', x: ['vajehyab', 'abadis'] },
  { code: 'wbl', name: 'Wakhi', native: 'ښیکوار', grp: 'iranian', roster: true, prof: 'mixed', wikt: 'Wakhi' },
  { code: 'sgh', name: 'Shughni', grp: 'iranian', roster: true, prof: 'mixed', wikt: 'Shughni' },
  { code: 'sgh-x-rushani', name: 'Rushani', grp: 'iranian', roster: true, prof: 'mixed', wikt: 'Shughni' },
  { code: 'srh', name: 'Sarikoli', grp: 'iranian', roster: true, prof: 'mixed', wikt: 'Sarikoli' },
  { code: 'yai', name: 'Yaghnobi', native: 'яғнобӣ', grp: 'iranian', roster: true, prof: 'cyrl', wikt: 'Yaghnobi' },
  { code: 'bal', name: 'Balochi', native: 'بلوچی', grp: 'iranian', roster: true, prof: 'balochi', gt: 'bal', wikt: 'Baluchi', glosbe: 'bal' },
  { code: 'os', name: 'Ossetian', native: 'ирон ӕвзаг', grp: 'iranian', roster: true, prof: 'ossetian', wikt: 'Ossetian', glosbe: 'os' },
  { code: 'kmr', name: 'Kurmanji', native: 'Kurmancî', grp: 'iranian', roster: true, prof: 'mixed', gt: 'ku', wikt: 'Northern Kurdish', glosbe: 'kmr' },
  { code: 'ckb', name: 'Sorani', native: 'سۆرانی', grp: 'iranian', roster: true, prof: 'kurd', gt: 'ckb', wikt: 'Central Kurdish', glosbe: 'ckb' },
  { code: 'sdh', name: 'Southern Kurdish', grp: 'iranian', roster: true, prof: 'kurd', wikt: 'Southern Kurdish', glosbe: 'sdh' },
  { code: 'lki', name: 'Laki', native: 'لەکی', grp: 'iranian', roster: true, prof: 'kurd', wikt: 'Laki' },
  { code: 'lrc', name: 'Luri', native: 'لری', grp: 'iranian', roster: true, prof: 'perso', wikt: 'Northern Luri', glosbe: 'lrc' },
  { code: 'hac', name: 'Gorani', native: 'گۆرانی', grp: 'iranian', roster: true, prof: 'kurd', wikt: 'Gurani', glosbe: 'hac' },
  { code: 'lrl', name: 'Achomi', native: 'اچُمی', grp: 'iranian', roster: true, prof: 'perso', wikt: 'Achomi' },
  { code: 'zza', name: 'Zazaki', native: 'Zazakî', grp: 'iranian', roster: true, prof: 'zaza', wikt: 'Zazaki', glosbe: 'zza' },
  { code: 'bsh', name: 'Katë', grp: 'other', roster: true, prof: 'mixed', wikt: 'Kamkata-viri' }, // Nuristani
  // more Iranian languages
  { code: 'prs', name: 'Dari', native: 'دری', grp: 'iranian', prof: 'perso', wikt: 'Dari', x: ['vajehyab', 'abadis'] },
  { code: 'ps', name: 'Pashto', native: 'پښتو', grp: 'iranian', prof: 'pashto', gt: 'ps', wikt: 'Pashto', glosbe: 'ps' },
  { code: 'bqi', name: 'Bakhtiari', grp: 'iranian', prof: 'perso', wikt: 'Bakhtiari' },
  { code: 'luz', name: 'Southern Luri', grp: 'iranian', prof: 'perso', wikt: 'Southern Luri' },
  { code: 'vaf', name: 'Vafsi', grp: 'iranian', prof: 'perso', wikt: 'Vafsi' },
  { code: 'kfm', name: 'Khunsari', grp: 'iranian', prof: 'perso', wikt: 'Khunsari' },
  { code: 'gbz', name: 'Zoroastrian Dari', grp: 'iranian', prof: 'perso', wikt: 'Zoroastrian Dari' },
  { code: 'bsg', name: 'Bashkardi', grp: 'iranian', prof: 'perso', wikt: 'Bashkardi' },
  { code: 'zum', name: 'Kumzari', grp: 'iranian', prof: 'mixed', wikt: 'Kumzari' },
  { code: 'jpr', name: 'Judeo-Persian', grp: 'iranian', prof: 'hebrew', wikt: 'Judeo-Persian' },
  { code: 'bhh', name: 'Bukhori', grp: 'iranian', prof: 'mixed', wikt: 'Bukhori' },
  { code: 'jdt', name: 'Juhuri (Judeo-Tat)', grp: 'iranian', prof: 'mixed', wikt: 'Judeo-Tat' },
  { code: 'ttt', name: 'Tat', grp: 'iranian', prof: 'mixedAz', wikt: 'Tat' },
  { code: 'isk', name: 'Ishkashimi', grp: 'iranian', prof: 'mixed', wikt: 'Ishkashimi' },
  { code: 'yah', name: 'Yazghulami', grp: 'iranian', prof: 'mixed', wikt: 'Yazghulami' },
  { code: 'mnj', name: 'Munji', grp: 'iranian', prof: 'mixed', wikt: 'Munji' },
  { code: 'oru', name: 'Ormuri', grp: 'iranian', prof: 'mixed', wikt: 'Ormuri' },
  { code: 'prc', name: 'Parachi', grp: 'iranian', prof: 'mixed', wikt: 'Parachi' },
  { code: 'pal', name: 'Middle Persian', grp: 'iranian', prof: 'mixed', wikt: 'Middle Persian', nogt: true },
  { code: 'xpr', name: 'Parthian', grp: 'iranian', prof: 'mixed', wikt: 'Parthian', nogt: true },
  { code: 'ae', name: 'Avestan', grp: 'iranian', prof: 'mixed', wikt: 'Avestan', nogt: true },
  { code: 'peo', name: 'Old Persian', grp: 'iranian', prof: 'mixed', wikt: 'Old Persian', nogt: true },
  { code: 'sog', name: 'Sogdian', grp: 'iranian', prof: 'mixed', wikt: 'Sogdian', nogt: true },
  { code: 'xbc', name: 'Bactrian', grp: 'iranian', prof: 'mixed', wikt: 'Bactrian', nogt: true },
  { code: 'kho', name: 'Khotanese', grp: 'iranian', prof: 'mixed', wikt: 'Khotanese', nogt: true },
  // Indo-Aryan
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', grp: 'indic', prof: 'latin', gt: 'hi', wikt: 'Hindi', tts: 'hi' },
  { code: 'ur', name: 'Urdu', native: 'اردو', grp: 'indic', prof: 'urdu', gt: 'ur', wikt: 'Urdu', tts: 'ur' },
  { code: 'ks', name: 'Kashmiri', grp: 'indic', prof: 'mixed', wikt: 'Kashmiri' },
  { code: 'khw', name: 'Khowar', grp: 'indic', prof: 'mixed', wikt: 'Khowar' },
  { code: 'scl', name: 'Shina', grp: 'indic', prof: 'mixed', wikt: 'Shina' },
  { code: 'rmt', name: 'Domari', grp: 'indic', prof: 'mixed', wikt: 'Domari' },
  { code: 'rom', name: 'Romani', grp: 'indic', prof: 'latin', wikt: 'Romani' },
  // other
  { code: 'de', name: 'German', native: 'Deutsch', grp: 'other', prof: 'latin', gt: 'de', wikt: 'German', tts: 'de', x: ['dwds'] },
  { code: 'ar', name: 'Arabic', native: 'العربية', grp: 'other', prof: 'arabic', gt: 'ar', wikt: 'Arabic', tts: 'ar' },
  { code: 'az', name: 'Azerbaijani', native: 'Azərbaycanca', grp: 'other', prof: 'azeri', gt: 'az', wikt: 'Azerbaijani' },
  { code: 'azb', name: 'South Azerbaijani', grp: 'other', prof: 'perso', wikt: 'South Azerbaijani' },
  { code: 'tk', name: 'Turkmen', grp: 'other', prof: 'latin', gt: 'tk', wikt: 'Turkmen' },
  { code: 'uz', name: 'Uzbek', grp: 'other', prof: 'mixed', gt: 'uz', wikt: 'Uzbek' },
  { code: 'ru', name: 'Russian', native: 'русский', grp: 'other', prof: 'cyrl', gt: 'ru', wikt: 'Russian', tts: 'ru' },
];
const CATALOG_BY_CODE = Object.fromEntries(CATALOG.map(p => [p.code, p]));
// The website copy starts with the site's own scope: Persian and the Core Roster.
const DEFAULT_LANGS = SITE ? ['fa', ...CATALOG.filter(p => p.roster).map(p => p.code)] : ['fa', 'mzn', 'fr', 'tg', 'pi', 'sa'];

function dictUrl(u, q) {
  return u.split('{w-}').join(encodeURIComponent(q.trim().replace(/\s+/g, '-'))).split('{w}').join(encodeURIComponent(q));
}
function defaultDicts(p) {
  const out = (p.x || []).map(k => DICTS[k]());
  out.push(DICTS.wikt(p.wikt || p.name));
  if (p.glosbe) out.push(DICTS.glosbe(p.glosbe));
  if (!p.nogt) out.push(DICTS.gt(p.gt));
  return out;
}
function makeLang(p) {
  const prof = PROFILES[p.prof || 'mixed'] || {};
  return {
    code: p.code, name: p.name, native: p.native || '',
    dir: p.dir || 'auto',
    eq: p.eq ?? prof.eq ?? '',
    marks: p.marks ?? !!prof.marks,
    stress: p.stress ?? !!prof.stress,
    caseLocale: p.caseLocale ?? prof.caseLocale ?? '',
    splitHyphen: p.splitHyphen ?? true,
    elisions: p.elisions ?? prof.elisions ?? '',
    noSpaces: !!p.noSpaces,
    gloss: p.gloss || 'English',
    tts: p.tts || '',
    dicts: p.dicts ? p.dicts.map(d => ({ n: d.n, u: d.u })) : defaultDicts(p),
  };
}
function fixLang(l) {
  const base = makeLang({ code: l.code, name: l.name || l.code, prof: 'latin' });
  return { ...base, ...l };
}

/* ---------------------------------------------------------------------
   Matching keys: how a word on the page is matched to your saved words
   --------------------------------------------------------------------- */
const AR_MARKS = /[\u064B-\u0652\u0654\u0670\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g;
const ALWAYS_STRIP = /[\u0640\u200B-\u200F\u00AD\uFEFF\u202A-\u202E\u2066-\u2069]/g;
const keyFnCache = new Map();
function keyFn(lang) {
  let f = keyFnCache.get(lang.code);
  if (f) return f;
  const loc = lang.caseLocale || lang.code;
  const lower = s => { try { return s.toLocaleLowerCase(loc); } catch { return s.toLowerCase(); } };
  const prep = s => {
    let k = String(s).normalize('NFC').replace(ALWAYS_STRIP, '');
    if (lang.marks) k = k.replace(AR_MARKS, '');
    if (lang.stress) k = k.normalize('NFD').replace(/[\u0300\u0301]/g, '').normalize('NFC');
    return lower(k).replace(/[\u2019\u2018\u02BC`´]/g, "'");
  };
  const pairs = String(lang.eq || '').split(/\s+/)
    .map(p => { const i = p.indexOf('='); return i > 0 ? [prep(p.slice(0, i)), prep(p.slice(i + 1))] : null; })
    .filter(p => p && p[0])
    .sort((a, b) => b[0].length - a[0].length);
  f = s => {
    let k = prep(s);
    for (const [a, b] of pairs) if (k.includes(a)) k = k.split(a).join(b);
    return k;
  };
  keyFnCache.set(lang.code, f);
  return f;
}
function phraseKey(lang, text) {
  const kf = keyFn(lang);
  return tokenizer(lang)(text).filter(t => t.w).map(t => kf(t.s)).join(' ');
}

/* ---------------------------------------------------------------------
   Tokenizer
   --------------------------------------------------------------------- */
const TERM = /[.!?…؟۔।॥|׃。！？]/;
const HAS_LETTER = /\p{L}/u;
const tokCache = new Map();
function tokenizer(lang) {
  let fn = tokCache.get(lang.code);
  if (fn) return fn;
  const J = "'\u2019\u02BC\u05F3\u05F4\u00B7" + (lang.splitHyphen ? '' : '\\-\u2010\u2011');
  const W = '\\p{L}\\p{M}\\p{N}\u200C\u200D\u00AD';
  const re = new RegExp(`[${W}]+(?:[${J}][${W}]+)*`, 'gu');
  const elis = String(lang.elisions || '').split(/\s+/).filter(Boolean)
    .map(e => e.replace(/\u2019/g, "'").toLowerCase()).sort((a, b) => b.length - a.length);
  let seg = null;
  if (lang.noSpaces && typeof Intl !== 'undefined' && Intl.Segmenter) {
    try { seg = new Intl.Segmenter(lang.code, { granularity: 'word' }); } catch { seg = null; }
  }
  fn = function tokenize(text) {
    const out = [];
    let last = 0;
    const push = (s, w) => { if (s) out.push({ s, w }); };
    for (const m of text.matchAll(re)) {
      if (m.index > last) push(text.slice(last, m.index), false);
      let t = m[0];
      last = m.index + t.length;
      if (!HAS_LETTER.test(t)) { push(t, false); continue; }
      if (seg) {
        for (const g of seg.segment(t)) push(g.segment, !!g.isWordLike && HAS_LETTER.test(g.segment));
        continue;
      }
      if (elis.length && /['\u2019]/.test(t)) {
        const low = t.replace(/\u2019/g, "'").toLowerCase();
        const e = elis.find(e => low.startsWith(e) && low.length > e.length);
        if (e) { push(t.slice(0, e.length), true); t = t.slice(e.length); }
      }
      push(t, true);
    }
    if (last < text.length) push(text.slice(last), false);
    return out;
  };
  tokCache.set(lang.code, fn);
  return fn;
}
function resetLangCaches(code) {
  if (code) { keyFnCache.delete(code); tokCache.delete(code); }
  else { keyFnCache.clear(); tokCache.clear(); }
}

// Split a text into paragraphs of tokens; each word token gets its key and
// each token a sentence number (sid) within its paragraph.
function analyze(text, lang) {
  const tok = tokenizer(lang), kf = keyFn(lang);
  const paras = [];
  let gap = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) { gap = paras.length > 0; continue; }
    const toks = tok(line);
    let sid = 0, wc = 0;
    for (const t of toks) {
      t.sid = sid;
      if (t.w) { t.k = kf(t.s); wc++; }
      else if (TERM.test(t.s)) sid++;
    }
    paras.push({ toks, wc, gap });
    gap = false;
  }
  return paras;
}
function countWords(text, lang) {
  const tok = tokenizer(lang);
  let n = 0;
  for (const line of text.split('\n')) for (const t of tok(line)) if (t.w) n++;
  return n;
}
// Pages are lists of blocks {p: paragraph index, a: first token, b: end token}.
function paginate(paras, per) {
  const pages = [];
  let cur = [], cw = 0;
  const flush = () => { if (cur.length) { pages.push(cur); cur = []; cw = 0; } };
  paras.forEach((p, pi) => {
    if (p.wc > per * 1.4) {
      let a = 0, chunkW = 0;
      for (let i = 0; i < p.toks.length; i++) {
        const t = p.toks[i];
        if (t.w) chunkW++;
        const brk = !t.w && ((TERM.test(t.s) && cw + chunkW >= per) || (/\s/.test(t.s) && cw + chunkW >= per * 2));
        if (brk && i + 1 < p.toks.length) {
          cur.push({ p: pi, a, b: i + 1 }); flush();
          a = i + 1; chunkW = 0;
        }
      }
      if (a < p.toks.length) { cur.push({ p: pi, a, b: p.toks.length }); cw += chunkW; if (cw >= per) flush(); }
    } else {
      if (cw > 0 && cw + p.wc > per * 1.15) flush();
      cur.push({ p: pi, a: 0, b: p.toks.length });
      cw += p.wc;
      if (cw >= per) flush();
    }
  });
  flush();
  if (!pages.length) pages.push([]);
  return pages;
}

/* ---------------------------------------------------------------------
   Text clean-up for imports
   --------------------------------------------------------------------- */
function cleanText(raw, kind) {
  let t = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (kind === 'html') {
    const doc = new DOMParser().parseFromString(
      t.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/blockquote)\b[^>]*>/gi, m => m + '\n'), 'text/html');
    doc.querySelectorAll('script,style,noscript').forEach(n => n.remove());
    t = doc.body ? doc.body.textContent : '';
  } else if (kind === 'srt' || kind === 'vtt') {
    t = t.split('\n').filter(line => !/^WEBVTT/.test(line) && !/^\d+$/.test(line.trim()) && !/-->/.test(line)).join('\n');
  }
  // Arabic presentation forms (from old PDFs) → ordinary letters
  t = t.replace(/[\uFB50-\uFDFF\uFE70-\uFEFE]+/g, s => s.normalize('NFKC'));
  t = t.normalize('NFC')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[ \t\u00A0]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t;
}
function decodeBytes(buf, fallback) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder(fallback || 'windows-1256').decode(buf); }
}
function chunkText(text, maxBytes) {
  const out = [];
  let cur = '', curB = 0;
  const parts = [];
  for (let i = 0; i < text.length;) {
    const j = text.indexOf('\n', i);
    const end = j < 0 ? text.length : j + 1;
    parts.push(text.slice(i, end)); i = end;
  }
  for (const part of parts) {
    const b = utf8len(part);
    if (curB + b > maxBytes && cur) { out.push(cur); cur = ''; curB = 0; }
    if (b > maxBytes) {
      let s = part;
      while (s.length) {
        let n = Math.floor(maxBytes / 4);
        out.push(s.slice(0, n)); s = s.slice(n);
      }
      continue;
    }
    cur += part; curB += b;
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

/* ---------------------------------------------------------------------
   Timed text: subtitles (.srt, .vtt), lyrics (.lrc) and helper-script JSON
   --------------------------------------------------------------------- */
function parseTimecode(s) {
  const m = String(s).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  return ((+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (m[4] ? +m[4].padEnd(3, '0') : 0);
}
function fmtClock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  return (hh ? hh + ':' + pad2(mm) : mm) + ':' + pad2(ss);
}
function stripCueText(t) {
  return String(t)
    .replace(/<\d{1,2}:\d{2}[:.\d]*>/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lrm;|&rlm;/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').trim();
}
// → { cues: [{s, e, t, gap}], title, lang, credit, source }
function parseTimed(raw, name) {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  const out = { cues: [] };
  if (ext === 'json' || /^\s*\{/.test(text)) {
    let j;
    try { j = JSON.parse(text); } catch { throw new Error('That JSON file couldn’t be read.'); }
    if (!j || !Array.isArray(j.cues)) throw new Error('That JSON file has no timed lines in it.');
    out.title = j.title; out.lang = j.lang; out.credit = j.credit; out.source = j.source;
    out.cues = j.cues.map(c => ({ s: Math.max(0, +c.s || 0), e: +c.e || 0, t: String(c.t || '').replace(/\s*\n\s*/g, ' ').trim(), gap: !!c.gap }))
      .filter(c => c.t);
  } else if (ext === 'lrc' || (/^\[\d+:\d{2}/m.test(text) && !/-->/.test(text))) {
    for (const line of text.split('\n')) {
      const stamps = [...line.matchAll(/\[(\d+:\d{2}(?:[.,]\d{1,3})?)\]/g)];
      if (!stamps.length) continue;
      const t = stripCueText(line.replace(/\[[^\]]*\]/g, ''));
      for (const st of stamps) { const s = parseTimecode(st[1]); if (s != null && t) out.cues.push({ s, e: 0, t }); }
    }
    out.cues.sort((a, b) => a.s - b.s);
  } else {
    let prev = [];
    for (const block of text.split(/\n{2,}/)) {
      const lines = block.split('\n').filter(l => l.trim() !== '');
      const ti = lines.findIndex(l => l.includes('-->'));
      if (ti < 0) continue;
      const [a, rest] = lines[ti].split('-->');
      const s = parseTimecode(a), e = parseTimecode((rest || '').trim().split(/\s+/)[0]);
      if (s == null || e == null) continue;
      const tl = lines.slice(ti + 1).map(stripCueText).filter(Boolean);
      // YouTube's rolling captions repeat the previous line: keep only what's new
      const fresh = tl.filter(l => !prev.includes(l));
      prev = tl;
      const t = fresh.join(' ').trim();
      if (!t) continue;
      out.cues.push({ s, e, t });
    }
    out.cues.sort((a, b) => a.s - b.s);
  }
  // fill in missing ends, merge exact repeats
  const cues = [];
  out.cues.forEach((c, i) => {
    const nextS = i + 1 < out.cues.length ? out.cues[i + 1].s : c.s + 5000;
    const e = c.e > c.s ? c.e : Math.max(c.s + 500, nextS);
    const last = cues[cues.length - 1];
    if (last && last.t === c.t && c.s - last.e < 1500) { last.e = Math.max(last.e, e); return; }
    cues.push({ s: c.s, e, t: c.t, gap: !!c.gap });
  });
  out.cues = cues;
  return out;
}

/* ---------------------------------------------------------------------
   FSRS-5 scheduler (default weights), with Anki-style learning steps
   --------------------------------------------------------------------- */
const FSRS = (() => {
  const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
    1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
  const DECAY = -0.5, FACTOR = 19 / 81;
  const LEARN = [1 * MIN, 10 * MIN], RELEARN = [10 * MIN];
  const clampD = d => clamp(d, 1, 10);
  const initS = g => Math.max(W[g - 1], 0.1);
  const initD = g => clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);
  const nextD = (d, g) => {
    const d1 = d + (-W[6] * (g - 3)) * (10 - d) / 9;
    return clampD(W[7] * initD(4) + (1 - W[7]) * d1);
  };
  const R = (t, s) => Math.pow(1 + FACTOR * t / s, DECAY);
  const recallS = (d, s, r, g) => s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) *
    (Math.exp((1 - r) * W[10]) - 1) * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1));
  const forgetS = (d, s, r) => W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]);
  const shortS = (s, g) => s * Math.exp(W[17] * (g - 3 + W[18]));
  const ivlDays = (s, ret, maxIvl) => clamp(Math.round(s / FACTOR * (Math.pow(ret, 1 / DECAY) - 1)), 1, maxIvl);
  const fuzz = d => d < 3 ? d : d + Math.round((Math.random() * 2 - 1) * Math.max(1, Math.round(d * 0.05)));

  function next(c, g, now, o = {}) {
    const ret = o.ret || 0.9, maxIvl = o.maxIvl || 36500;
    const n = { ...c, rp: (c.rp || 0) + 1 };
    const toReview = days => {
      const d = clamp(o.fuzz ? fuzz(days) : days, 1, maxIvl);
      n.q = 2; n.st = 0; n.ivl = d; n.due = dayStart(now) + d * DAY;
    };
    if (!c.q) {
      n.S = initS(g); n.D = initD(g);
      if (g === 4) toReview(ivlDays(n.S, ret, maxIvl));
      else {
        n.q = 1; n.st = g === 3 ? 1 : 0;
        n.due = now + (g === 1 ? LEARN[0] : g === 2 ? (LEARN[0] + LEARN[1]) / 2 : LEARN[1]);
      }
    } else if (c.q === 1 || c.q === 3) {
      const steps = c.q === 1 ? LEARN : RELEARN;
      const st = Math.min(c.st || 0, steps.length - 1);
      n.S = shortS(c.S, g); n.D = nextD(c.D, g);
      if (g === 1) { n.st = 0; n.due = now + steps[0]; }
      else if (g === 2) n.due = now + (st === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[st]);
      else if (g === 3) {
        if (st + 1 < steps.length) { n.st = st + 1; n.due = now + steps[st + 1]; }
        else toReview(ivlDays(n.S, ret, maxIvl));
      } else toReview(Math.max(ivlDays(n.S, ret, maxIvl), ivlDays(shortS(c.S, 3), ret, maxIvl) + 1));
    } else {
      const t = Math.max(0, (now - (c.lr || now)) / DAY);
      const r = R(t, c.S);
      n.D = nextD(c.D, g);
      if (g === 1) {
        n.S = Math.min(forgetS(c.D, c.S, r), c.S);
        n.lp = (c.lp || 0) + 1; n.q = 3; n.st = 0; n.due = now + RELEARN[0];
      } else {
        const sH = recallS(c.D, c.S, r, 2), sG = recallS(c.D, c.S, r, 3), sE = recallS(c.D, c.S, r, 4);
        let iH = ivlDays(sH, ret, maxIvl), iG = ivlDays(sG, ret, maxIvl), iE = ivlDays(sE, ret, maxIvl);
        iH = Math.min(iH, iG); iG = Math.max(iG, iH + 1); iE = Math.max(iE, iG + 1);
        n.S = g === 2 ? sH : g === 3 ? sG : sE;
        toReview(g === 2 ? iH : g === 3 ? iG : iE);
      }
    }
    n.lr = now;
    return n;
  }
  function preview(c, now, o) {
    const out = {};
    for (const g of [1, 2, 3, 4]) out[g] = next(c, g, now, { ...o, fuzz: false }).due - now;
    return out;
  }
  function retrievability(c, now = Date.now()) {
    if (!c || !c.q || !c.S) return null;
    return R(Math.max(0, (now - c.lr) / DAY), c.S);
  }
  // Interval as Anki's review log records it: days for review cards, negative seconds for learning steps.
  function ivlCode(c, now) {
    if (!c || !c.q) return 0;
    if (c.q === 2) return c.ivl || Math.max(1, Math.round((c.due - (c.lr || now)) / DAY));
    return -Math.max(60, Math.round((c.due - (c.lr || now)) / 1000));
  }
  // Answer a card and append [time (s), grade, type (0 learn, 1 review, 2 relearn), new interval, old interval] to its history.
  function answer(c, g, now, o) {
    const n = next(c, g, now, o);
    const type = !c.q || c.q === 1 ? 0 : c.q === 2 ? 1 : 2;
    n.h = [...(c.h || []), [Math.round(now / 1000), g, type, ivlCode(n, now), ivlCode(c, now)]].slice(-200);
    return n;
  }
  return { next, answer, preview, retrievability, ivlCode, W };
})();
const newCard = () => ({ q: 0, due: Date.now(), S: 0, D: 0, rp: 0, lp: 0, lr: 0, st: 0 });
// The flashcards a word should have: keep existing ones, add missing ones.
function cardsFor(e, reverse) {
  const c = (e && e.c) || newCard();
  const c2 = (e && e.c2) || (reverse ? newCard() : null);
  return { c, c2 };
}
// Each word has up to two cards: 1 = word→meaning, 2 = meaning→word.
const cardOf = (e, d) => e ? (d === 2 ? e.c2 : e.c) : null;

/* ---------------------------------------------------------------------
   Built-in sample texts (all public domain)
   --------------------------------------------------------------------- */
const SAMPLES = {
  fa: [{ id: 'saadi', title: 'Saadi · Banī Ādam (Golestān)', text:
`بنی آدم اعضای یکدیگرند
که در آفرینش ز یک گوهرند
چو عضوی به درد آورد روزگار
دگر عضوها را نماند قرار
تو کز محنت دیگران بی‌غمی
نشاید که نامت نهند آدمی` }],
  fr: [{ id: 'corbeau', title: 'La Fontaine · Le Corbeau et le Renard', text:
`Maître Corbeau, sur un arbre perché,
Tenait en son bec un fromage.
Maître Renard, par l'odeur alléché,
Lui tint à peu près ce langage :
« Hé ! bonjour, Monsieur du Corbeau.
Que vous êtes joli ! que vous me semblez beau !
Sans mentir, si votre ramage
Se rapporte à votre plumage,
Vous êtes le Phénix des hôtes de ces bois. »
À ces mots le Corbeau ne se sent pas de joie ;
Et pour montrer sa belle voix,
Il ouvre un large bec, laisse tomber sa proie.
Le Renard s'en saisit, et dit : « Mon bon Monsieur,
Apprenez que tout flatteur
Vit aux dépens de celui qui l'écoute :
Cette leçon vaut bien un fromage, sans doute. »
Le Corbeau, honteux et confus,
Jura, mais un peu tard, qu'on ne l'y prendrait plus.` }],
  tg: [{ id: 'rudaki', title: 'Rudaki · Bū-yi Jū-yi Mūliyān', text:
`Бӯи ҷӯи Мӯлиён ояд ҳаме,
Ёди ёри меҳрубон ояд ҳаме.` }],
  pi: [{ id: 'dhp1', title: 'Dhammapada 1–2 · Yamakavagga', text:
`Manopubbaṅgamā dhammā, manoseṭṭhā manomayā;
Manasā ce paduṭṭhena, bhāsati vā karoti vā;
Tato naṃ dukkhamanveti, cakkaṃva vahato padaṃ.

Manopubbaṅgamā dhammā, manoseṭṭhā manomayā;
Manasā ce pasannena, bhāsati vā karoti vā;
Tato naṃ sukhamanveti, chāyāva anapāyinī.` }],
  sa: [{ id: 'gita247', title: 'Bhagavad Gītā 2.47', text:
`कर्मण्येवाधिकारस्ते मा फलेषु कदाचन ।
मा कर्मफलहेतुर्भूर्मा ते सङ्गोऽस्त्वकर्मणि ॥ २.४७ ॥` }],
};

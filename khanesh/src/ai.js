/* ---------- AI help with the person's own Gemini key ----------
   On the website there's no Claude, so people can paste a key from Google AI Studio (free for anyone
   with a Google account). The key stays in this browser: it's never synced to an account or sent
   anywhere but Google. This object answers the same calls the reader makes to Claude: a prompt, with
   optional images, gives { text }; .json() gives the parsed object; .limits() says how many images. */
const GEMINI_KEY_STORE = 'khanesh-gemini-key';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const Gemini = {
  models: null, // { quick, default, complex }: chosen from what the key can use
  key() { try { return localStorage.getItem(GEMINI_KEY_STORE) || ''; } catch { return ''; } },
  forget() { try { localStorage.removeItem(GEMINI_KEY_STORE); localStorage.removeItem(GEMINI_KEY_STORE + '-models'); } catch { } },
  remember(key, models) {
    try { localStorage.setItem(GEMINI_KEY_STORE, key); localStorage.setItem(GEMINI_KEY_STORE + '-models', JSON.stringify(models)); } catch { }
  },
  savedModels() { try { return JSON.parse(localStorage.getItem(GEMINI_KEY_STORE + '-models') || 'null'); } catch { return null; } },
};

// Pick models from the key's list, newest first: Flash-Lite for quick work, Flash for the rest, and Pro
// for careful page reading when the key has it. "-latest" names follow Google's newest versions.
function pickGeminiModels(names) {
  const ok = names.filter(n => /^gemini-/.test(n) && !/(tts|image|audio|live|embedding|exp|computer|robotics|veo|imagen|native)/.test(n));
  const ver = n => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  const best = test => {
    const c = ok.filter(test);
    if (!c.length) return null;
    const latest = c.find(n => /-latest$/.test(n) && !/\d/.test(n.replace(/^gemini-/, '')));
    if (latest) return latest;
    return c.sort((a, b) => ver(b) - ver(a) || /preview/.test(a) - /preview/.test(b) || a.length - b.length)[0];
  };
  const flash = best(n => /flash/.test(n) && !/lite/.test(n));
  const lite = best(n => /flash-lite/.test(n)) || flash;
  const pro = best(n => /pro/.test(n));
  return flash || lite ? { quick: lite || flash, default: flash || lite, complex: pro || flash || lite } : null;
}

async function geminiFetch(path, key, body, signal) {
  let res;
  try {
    res = await fetch(`${GEMINI_API}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'x-goog-api-key': key }, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    throw Object.assign(new Error('offline'), { code: 'offline' });
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || res.statusText || 'error';
    const why = JSON.stringify((data && data.error && data.error.details) || '');
    const code = res.status === 429 ? 'rate_limited'
      : /ACCESS_TOKEN_TYPE_UNSUPPORTED/.test(msg + why) ? 'new_key_refused'
      : /API_KEY_INVALID|API key not valid|API_KEY/i.test(msg + why) || res.status === 401 ? 'bad_key'
      : res.status === 403 ? 'bad_key'
      : /too large|exceeds|payload/i.test(msg) || res.status === 413 ? 'prompt_too_large'
      : /location|region|country/i.test(msg) ? 'region'
      : 'failed';
    throw Object.assign(new Error(msg), { code });
  }
  return data;
}

// Check a key and choose its models; throws with a code when the key doesn't work.
async function geminiCheckKey(key) {
  const names = [];
  let token = '';
  for (let i = 0; i < 5; i++) {
    const data = await geminiFetch(`models?pageSize=200${token ? '&pageToken=' + encodeURIComponent(token) : ''}`, key);
    for (const m of (data && data.models) || []) {
      if ((m.supportedGenerationMethods || []).includes('generateContent')) names.push(String(m.name).replace(/^models\//, ''));
    }
    token = data && data.nextPageToken;
    if (!token) break;
  }
  const models = pickGeminiModels(names);
  if (!models) throw Object.assign(new Error('no models'), { code: 'no_models' });
  return models;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function geminiSample(key, models) {
  const cache = new Map();
  const call = async (prompt, opts = {}, json = false) => {
    const model = models[opts.modelTier] || models.default;
    const parts = [{ text: prompt }];
    for (const img of opts.images || []) parts.push({ inline_data: { mime_type: img.type || 'image/png', data: await blobToBase64(img) } });
    const body = { contents: [{ role: 'user', parts }] };
    if (json) body.generationConfig = { responseMimeType: 'application/json' };
    const memo = !opts.images && opts.cache ? model + '\n' + json + '\n' + prompt : null;
    if (memo && cache.has(memo)) return cache.get(memo);
    const data = await geminiFetch(`models/${encodeURIComponent(model)}:generateContent`, key, body, opts.signal);
    const cand = data && data.candidates && data.candidates[0];
    if (!cand) {
      const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
      throw Object.assign(new Error('no answer'), { code: blocked ? 'refused' : 'failed' });
    }
    if (/SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(cand.finishReason || '') && !(cand.content && cand.content.parts)) {
      throw Object.assign(new Error('blocked'), { code: 'refused' });
    }
    const text = ((cand.content && cand.content.parts) || []).filter(p => !p.thought).map(p => p.text || '').join('');
    const out = { text };
    if (memo) cache.set(memo, out);
    if (typeof opts.onText === 'function') opts.onText({ text });
    return out;
  };
  const sample = (prompt, opts) => call(prompt, opts, false);
  sample.json = async (prompt, opts) => {
    const r = await call(prompt, opts, true);
    const t = r.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    try { return JSON.parse(t); } catch { throw Object.assign(new Error('bad json'), { code: 'invalid_json' }); }
  };
  sample.limits = async () => ({ images: { maxCount: 10 } });
  sample.provider = 'Gemini';
  return sample;
}

// Turn Gemini on (or off) for this page, from what's saved in the browser.
function connectGemini() {
  if (window.claude) return; // inside Claude, Claude does this
  const key = Gemini.key();
  const models = key && (Gemini.savedModels() || null);
  if (key && models) {
    Cloud.sample = geminiSample(key, models);
    Cloud.imageOCR = true;
  } else {
    Cloud.sample = null;
    Cloud.imageOCR = false;
  }
  UI.capsChanged();
}

// What the reader calls the AI it's using.
function aiName() { return Cloud.sample && Cloud.sample.provider === 'Gemini' ? 'Gemini' : 'Claude'; }

// Look up a selected word: a dictionary entry (Wiktionary, through the free
// dictionaryapi.dev), or for terms and names a Wikipedia summary.
const Define = (() => {
  const cache = new Map();

  // Forms to try when the exact word has no entry: "analyses" → "analysis", "biases" → "bias"
  function forms(w) {
    const out = [w];
    const add = (x) => x && x.length > 2 && !out.includes(x) && out.push(x);
    if (/ses$/.test(w)) add(w.replace(/ses$/, 'sis'));
    if (/ies$/.test(w)) add(w.replace(/ies$/, 'y'));
    if (/es$/.test(w)) add(w.slice(0, -2));
    if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
    if (/ied$/.test(w)) add(w.replace(/ied$/, 'y'));
    if (/ed$/.test(w)) add(w.slice(0, -2)), add(w.slice(0, -1));
    if (/ing$/.test(w)) add(w.slice(0, -3)), add(w.slice(0, -3) + 'e');
    if (/ly$/.test(w)) add(w.slice(0, -2));
    return out;
  }

  async function dictionary(word) {
    for (const w of forms(word.toLowerCase())) {
      const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`;
      let res = await fetch(url);
      // a passing hiccup on their side: one more try
      if (res.status >= 500 || res.status === 429) {
        await new Promise((r) => setTimeout(r, 700));
        res = await fetch(url);
      }
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`the dictionary answered ${res.status}`);
      const entries = await res.json();
      const e = entries[0];
      const meanings = [];
      for (const en of entries)
        for (const m of en.meanings || []) {
          const have = meanings.find((x) => x.pos === m.partOfSpeech);
          const defs = (m.definitions || []).map((d) => ({ d: d.definition, ex: d.example || '' }));
          if (have) have.defs.push(...defs);
          else meanings.push({ pos: m.partOfSpeech, defs, synonyms: (m.synonyms || []).slice(0, 6) });
        }
      const ph = (e.phonetics || []).find((p) => p.text) || {};
      const audio = ((e.phonetics || []).find((p) => p.audio) || {}).audio || '';
      return { kind: 'dict', word: e.word, phonetic: e.phonetic || ph.text || '', audio, meanings, source: (e.sourceUrls || [])[0] || `https://en.wiktionary.org/wiki/${encodeURIComponent(e.word)}` };
    }
    return null;
  }

  async function wikipedia(term) {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term.replace(/ /g, '_'))}?redirect=true`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Wikipedia answered ${res.status}`);
    const s = await res.json();
    if (!s.extract || s.type === 'disambiguation') return null;
    return { kind: 'wiki', title: s.title, extract: s.extract, url: (s.content_urls && s.content_urls.mobile && s.content_urls.mobile.page) || `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title)}` };
  }

  // A word or a short term from the selection, trimmed of punctuation.
  function term(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/(\p{L})- (\p{L})/gu, '$1$2') // a word hyphenated across a line
      .replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '')
      .trim();
  }

  async function lookup(text) {
    const t = term(text);
    if (!t) return null;
    if (cache.has(t)) return cache.get(t);
    const single = !/\s/.test(t);
    let out = null;
    // a single word: dictionary first; a phrase or a name: Wikipedia first
    const tries = single ? [() => dictionary(t), () => wikipedia(t)] : [() => wikipedia(t), () => dictionary(t)];
    let lastErr = null;
    for (const f of tries) {
      try {
        out = await f();
      } catch (err) {
        lastErr = err;
      }
      if (out) break;
    }
    if (!out && lastErr) throw navigator.onLine ? lastErr : new Error('You’re offline: looking up words needs internet.');
    cache.set(t, out);
    return out;
  }

  // One line to keep as a highlight note.
  function brief(r) {
    if (!r) return '';
    if (r.kind === 'wiki') return `${r.title}: ${r.extract.split(/(?<=\.)\s/)[0]}`;
    const m = r.meanings[0];
    return m ? `${r.word} (${m.pos}): ${m.defs[0].d}` : r.word;
  }

  return { lookup, term, brief };
})();

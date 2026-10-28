// Reading aloud with the device's own voices (Web Speech API), one sentence
// at a time: short utterances are what Android's speech engine handles
// reliably, and they let the reader follow along and turn pages.
const Speech = (() => {
  const supported = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';

  // Blocks of running text, in reading order, up to the reference list.
  // Figures and tables are skipped: read aloud they're noise.
  const BLOCKS = 'h1, h2, h3, h4, h5, p, li, blockquote, figcaption';
  function blocks(doc) {
    const out = [];
    for (const el of doc.querySelectorAll(BLOCKS)) {
      if (el.closest('figure, table, nav, .cover, .refs, .ltx_bibliography')) continue;
      if (/^h\d$/.test(el.localName) && /^\s*(\d+\.?\s*)?(references|bibliography|literature cited|works cited)\b/i.test(el.textContent)) break;
      // the innermost block holds the text (a <li> wrapping <p>s is read as its <p>s)
      if (el.querySelector(BLOCKS)) continue;
      if (!el.textContent.trim()) continue;
      out.push(el);
    }
    return out;
  }

  // Citation markers aren't read: [12], [3–5], superscript ¹²
  const isMarker = (node) => {
    const el = node.parentElement;
    if (!el) return false;
    const sup = el.closest('sup');
    return !!sup && /^[\s\d,–\-*†‡]+$/.test(sup.textContent);
  };

  // The block's text with each sentence's place in it, so a sentence can be
  // highlighted and found on the page.
  function sentences(el) {
    const doc = el.ownerDocument;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let raw = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, start: raw.length, skip: isMarker(n) });
      raw += n.data;
    }
    const skipped = nodes.filter((x) => x.skip).map((x) => [x.start, x.start + x.node.data.length]);
    const spans = [];
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      for (const s of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(raw)) spans.push([s.index, s.index + s.segment.length]);
    } else {
      const re = /[^.!?]+(?:[.!?]+["”’)]*\s*|$)/g;
      for (let m; (m = re.exec(raw)) && m[0]; ) spans.push([m.index, m.index + m[0].length]);
    }
    // "et al." and "Fig." end in a full stop but not a sentence: rejoin
    const merged = [];
    for (const sp of spans) {
      const prev = merged.at(-1);
      if (prev && /\b(et al|e\.g|i\.e|Fig|Figs|Eq|Eqs|Ref|Refs|No|vs|cf|approx|ca|Dr|Mr|Mrs|Ms|St)\.\s*$/i.test(raw.slice(prev[0], prev[1]))) prev[1] = sp[1];
      else merged.push([...sp]);
    }
    const rangeAt = (a, b) => {
      const at = (off, end) => {
        for (const x of nodes) if (off < x.start + x.node.data.length || (end && off === x.start + x.node.data.length)) return [x.node, Math.max(0, off - x.start)];
        const last = nodes.at(-1);
        return [last.node, last.node.data.length];
      };
      const r = doc.createRange();
      r.setStart(...at(a, false));
      r.setEnd(...at(b, true));
      return r;
    };
    return merged
      .map(([a, b]) => {
        // drop citation markers inside the sentence
        let text = '';
        let i = a;
        for (const [s, e] of skipped) {
          if (e <= a || s >= b) continue;
          text += raw.slice(i, Math.max(i, s));
          i = Math.max(i, e);
        }
        text += raw.slice(i, b);
        // trim the trailing space so the highlight stops at the full stop
        const end = a + raw.slice(a, b).trimEnd().length;
        return { text: speakable(text), range: () => rangeAt(a + (raw.slice(a, b).length - raw.slice(a, b).trimStart().length), end) };
      })
      .filter((s) => /\p{L}|\d/u.test(s.text));
  }

  // What a listener wants to hear, not what the page prints.
  function speakable(t) {
    return t
      .replace(/\s+/g, ' ')
      .replace(/\[\s*\d+(?:\s*[-–,]\s*\d+)*\s*\]/g, '') // [12], [3–5]
      .replace(/\(([^()]*?\b(?:1[89]|20)\d\d[a-z]?\b[^()]*?)\)/g, (m, inner) => (/\p{Lu}\p{Ll}+/u.test(inner) && !/[=<>]/.test(inner) ? '' : m)) // (Smith et al., 2019)
      .replace(/\bet al\./g, 'et al')
      .replace(/\be\.g\.,?/g, 'for example')
      .replace(/\bi\.e\.,?/g, 'that is')
      .replace(/\bFigs?\.\s*(?=\d)/g, 'Figure ')
      .replace(/\bEqs?\.\s*(?=\d|\()/g, 'Equation ')
      .replace(/\bvs\./g, 'versus')
      .replace(/\s+([,.;:])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function voices() {
    if (!supported) return [];
    const lang = (navigator.language || 'en').slice(0, 2);
    return speechSynthesis
      .getVoices()
      .slice()
      .sort((a, b) => (b.lang.startsWith(lang) - a.lang.startsWith(lang)) || (b.lang.startsWith('en') - a.lang.startsWith('en')) || (b.localService - a.localService) || a.name.localeCompare(b.name));
  }
  // voices load late on some browsers
  const voicesReady = () =>
    new Promise((resolve) => {
      if (!supported || speechSynthesis.getVoices().length) return resolve();
      speechSynthesis.addEventListener('voiceschanged', () => resolve(), { once: true });
      setTimeout(resolve, 1500);
    });

  // Speak one sentence. Resolves when it's done, false if it was cut off.
  let current = null; // held so Chrome doesn't drop the utterance (and its end event)
  function say(text, { rate = 1, voice = '' } = {}) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate;
      const v = voice && speechSynthesis.getVoices().find((x) => x.name === voice);
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      }
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearInterval(watch);
        resolve(ok);
      };
      u.onend = () => finish(true);
      u.onerror = (e) => finish(e.error === 'interrupted' || e.error === 'canceled' ? false : true);
      current = u;
      speechSynthesis.speak(u);
      // some engines never send "end": notice when nothing is speaking any more
      let idle = 0;
      const watch = setInterval(() => {
        if (speechSynthesis.speaking || speechSynthesis.pending) idle = 0;
        else if (++idle >= 3) finish(true);
      }, 500);
    });
  }
  function stop() {
    if (supported) speechSynthesis.cancel();
    current = null;
  }

  return { supported, blocks, sentences, speakable, voices, voicesReady, say, stop };
})();

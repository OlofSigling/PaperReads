// Ask Claude about a paper, with the user's own Anthropic API key.
//
// The paper (EPUB text, else the PDF itself) goes first in the conversation
// and is cached, so follow-up questions only pay full price for the new
// turn. The conversation is stored on the paper exactly as sent, because
// the API checks that earlier turns are unchanged when they come back.
const Ask = (() => {
  const base = new URL('.', document.baseURI).href;
  const MODELS = {
    'claude-opus-5-5': { label: 'Claude Opus 5.5', note: 'most capable', price: [4, 20], fallbacks: true },
    'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', note: 'faster, half the price', price: [2, 10], fallbacks: true },
    'claude-haiku-5-5': { label: 'Claude Haiku 5.5', note: 'cheapest', price: [0.1, 0.5], fallbacks: false },
  };
  const DEFAULT_MODEL = 'claude-opus-5-5';
  const MAX_TEXT = 600000; // characters; ~150k tokens, plenty for any paper

  const SYSTEM = `You are a reading companion inside PaperReads, an app for reading research papers. The user is reading the paper given at the start of the conversation and asks you about it.

Answer from the paper. When something isn't in it, say so plainly, and keep what the paper says separate from your own background knowledge. Point to where things are (section, figure, table, page) so the user can check. Be direct about weaknesses, gaps and overclaims when they're relevant; the user keeps a list of concerns about each paper.

Keep answers short unless asked for depth: lead with the answer, then the support. Use plain language before notation. Light Markdown only (short paragraphs, **bold**, bullet lists); no tables or headings unless asked.`;

  let sdk = null;
  async function client() {
    const key = await DB.setting('anthropicKey', '');
    if (!key) throw new Error('Add your Anthropic API key in Settings first.');
    if (!sdk) sdk = await import(base + 'vendor/anthropic-sdk.min.mjs');
    // The key stays on this device and goes only to api.anthropic.com.
    return { Anthropic: sdk.default, api: new sdk.default({ apiKey: key, dangerouslyAllowBrowser: true }) };
  }

  async function model() {
    const m = await DB.setting('claudeModel', DEFAULT_MODEL);
    return MODELS[m] ? m : DEFAULT_MODEL;
  }

  // The EPUB as plain text with headings and paragraphs kept.
  async function epubText(blob) {
    const JSZip = await Epubify.jszip();
    const zip = await JSZip.loadAsync(blob);
    const opfPath = /full-path="([^"]+)"/.exec(await zip.file('META-INF/container.xml').async('string'))[1];
    const opf = new DOMParser().parseFromString(await zip.file(opfPath).async('string'), 'application/xml');
    const dir = opfPath.includes('/') ? opfPath.replace(/[^/]+$/, '') : '';
    const items = Object.fromEntries([...opf.querySelectorAll('manifest item')].map((i) => [i.getAttribute('id'), i.getAttribute('href')]));
    const out = [];
    for (const ref of opf.querySelectorAll('spine itemref')) {
      const href = items[ref.getAttribute('idref')];
      const f = href && zip.file(dir + decodeURIComponent(href));
      if (!f) continue;
      const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xhtml+xml');
      if (doc.querySelector('parsererror') || doc.querySelector('.cover, div.cover')) continue;
      for (const el of doc.querySelectorAll('h1, h2, h3, h4, p, li, figcaption, blockquote, pre, td, th')) {
        if (el.closest('li, figcaption, blockquote') && el.closest('li, figcaption, blockquote') !== el) continue;
        const t = el.textContent.replace(/\s+/g, ' ').trim();
        if (!t) continue;
        const h = /^h(\d)$/.exec(el.localName);
        out.push(h ? `${'#'.repeat(Number(h[1]))} ${t}` : el.localName === 'li' ? `- ${t}` : t);
      }
    }
    return out.join('\n\n').slice(0, MAX_TEXT);
  }

  function base64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // The first block of the conversation: the paper itself. Built the same
  // way every time so the cached prefix stays identical between turns.
  async function paperBlock(p) {
    const meta = [`Title: ${p.title}`, p.authors?.length ? `Authors: ${p.authors.join(', ')}` : '', p.year ? `Year: ${p.year}` : '', p.venue ? `Venue: ${p.venue}` : '', p.doi ? `DOI: ${p.doi}` : '']
      .filter(Boolean)
      .join('\n');
    const epub = p.hasEpub && (await DB.get('epubs', p.id));
    if (epub) {
      const text = await epubText(epub.blob).catch(() => '');
      if (text.length > 500) return { kind: 'EPUB text', block: { type: 'text', text: `<paper>\n${meta}\n\n${text}\n</paper>` } };
    }
    const pdf = p.hasPdf && (await DB.get('pdfs', p.id));
    if (pdf && pdf.blob.size < 30e6) {
      return { kind: 'PDF', block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await base64(pdf.blob) }, title: p.title } };
    }
    return { kind: 'details only', block: { type: 'text', text: `<paper>\n${meta}\n\nAbstract: ${p.abstract || '(none stored)'}\n\n(Only these details are available, not the full text.)\n</paper>` } };
  }

  // What the user has written about the paper, for the first question only
  // (later turns must not change what was already sent).
  function userNotes(p) {
    const open = (p.concerns || []).filter((c) => !c.done).map((c) => `- ${c.text}${c.quote ? ` (on: "${c.quote}")` : ''}`);
    const parts = [];
    if (p.notes && p.notes.trim()) parts.push(`My notes so far:\n${p.notes.trim()}`);
    if (open.length) parts.push(`My open concerns:\n${open.join('\n')}`);
    return parts.length ? `\n\n<my_notes>\n${parts.join('\n\n')}\n</my_notes>` : '';
  }

  function cost(m, usage) {
    const [inP, outP] = MODELS[m]?.price || MODELS[DEFAULT_MODEL].price;
    const u = usage || {};
    return ((u.input_tokens || 0) * inP + (u.cache_creation_input_tokens || 0) * inP * 1.25 + (u.cache_read_input_tokens || 0) * inP * 0.1 + (u.output_tokens || 0) * outP) / 1e6;
  }

  /**
   * Ask a question. history is the stored conversation (paper.chat).
   * onText(delta) streams the answer. Returns the two turns to append.
   */
  async function ask(p, history, question, { quote = '', onText = () => {}, signal } = {}) {
    const { Anthropic, api } = await client();
    const m = await model();
    const first = !history.length;
    const prompt = `${quote ? `About this passage:\n"${quote}"\n\n` : ''}${question}${first ? userNotes(p) : ''}`;
    const userTurn = { role: 'user', content: [{ type: 'text', text: prompt }], question, quote, ts: Date.now() };
    const { block, kind } = await paperBlock(p);
    const messages = [...history, userTurn].map((t, i) => ({
      role: t.role,
      // the paper rides in front of the first question, rebuilt each time
      content: i === 0 ? [block, ...t.content] : t.content,
    }));
    const betas = ['thinking-binding-controls-2026-08-01'];
    const params = {
      model: m,
      max_tokens: 16000,
      system: SYSTEM,
      messages,
      cache_control: { type: 'ephemeral' },
      output_config: { effort: 'medium' },
      // If the paper text changed since earlier turns (EPUB remade), drop the
      // old reasoning instead of failing the request.
      thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    };
    if (MODELS[m].fallbacks) {
      // A safety-classifier decline is retried on Anthropic's recommended model.
      betas.push('server-side-fallback-2026-07-01');
      params.fallbacks = 'default';
    }
    let final;
    try {
      const stream = api.beta.messages.stream({ ...params, betas }, { signal });
      stream.on('text', (t) => onText(t));
      final = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error('Your API key wasn’t accepted. Check it in Settings.');
      if (err instanceof Anthropic.PermissionDeniedError) throw new Error('Your API key isn’t allowed to use this model.');
      if (err instanceof Anthropic.RateLimitError) throw new Error('Too many requests right now. Wait a moment and try again.');
      if (err instanceof Anthropic.APIUserAbortError) throw new Error('Stopped.');
      if (err instanceof Anthropic.APIConnectionError) throw new Error('Couldn’t reach Anthropic. Are you online?');
      if (err instanceof Anthropic.APIError) throw new Error(err.error?.error?.message || err.message);
      throw err;
    }
    const text = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let notice = '';
    if (final.stop_reason === 'refusal') notice = 'Claude declined to answer this.';
    else if (final.stop_reason === 'max_tokens') notice = 'The answer was cut off (too long).';
    const answer = {
      role: 'assistant',
      content: final.content, // kept verbatim: thinking blocks must come back unchanged
      text,
      notice,
      model: final.model || m,
      cost: cost(m, final.usage),
      source: kind,
      ts: Date.now(),
    };
    // A refused turn can't be continued; keep it out of the history sent next time.
    if (final.stop_reason === 'refusal') answer.excluded = true;
    return [userTurn, answer];
  }

  // The history to send: skip refused exchanges.
  function sendable(chat) {
    const out = [];
    for (let i = 0; i < chat.length; i += 2) if (chat[i + 1] && !chat[i + 1].excluded) out.push(chat[i], chat[i + 1]);
    return out;
  }

  // A tiny request to check the key works.
  async function test() {
    const { Anthropic, api } = await client();
    try {
      await api.models.retrieve(await model());
      return true;
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error('That key wasn’t accepted.');
      if (err instanceof Anthropic.APIConnectionError) throw new Error('Couldn’t reach Anthropic. Are you online?');
      throw new Error(err.message);
    }
  }

  return { ask, sendable, test, MODELS, DEFAULT_MODEL };
})();

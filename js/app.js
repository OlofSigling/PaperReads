/* PaperReads — offline paper tracker. Plain JS, no build step. */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const main = $('#main');

  const STATUS = { want: 'Want to read', reading: 'Reading', read: 'Read', none: 'Catalogued' };
  const LINK_TYPES = { related: 'Related to', cites: 'Cites', builds: 'Builds on' };
  const LINK_INVERSE = { related: 'Related to', cites: 'Cited by', builds: 'Built on by' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------- helpers ----------
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const now = () => Date.now();
  const today = () => localDate(new Date());
  function localDate(d) {
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  }
  const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
  const authorsShort = (a) => (!a || !a.length ? 'Unknown authors' : a.length > 2 ? `${a[0]} et al.` : a.join(' & '));

  function pct(p) {
    if (p.totalPages) return Math.min(1, (p.currentPage || 0) / p.totalPages);
    return Math.min(1, (p.percent || 0) / 100);
  }
  function progressLabel(p) {
    if (p.totalPages) return `p. ${p.currentPage || 0} / ${p.totalPages}`;
    return `${Math.round(p.percent || 0)}%`;
  }

  // toast(msg) or toast(msg, { label, run }) for a one-tap action.
  function toast(msg, action) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('has-action', !!action);
    if (action) {
      const b = el.appendChild(document.createElement('button'));
      b.type = 'button';
      b.textContent = action.label;
      b.onclick = () => {
        el.classList.remove('show');
        action.run();
      };
    }
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), action ? 6000 : 2600);
  }

  // Reaching the end doesn't finish a paper (a slider nudged to 100% happens);
  // finishing is the user's call, offered here.
  function offerFinish(p, after = () => {}) {
    toast('At the end', {
      label: 'Mark as read',
      run: async () => {
        const fresh = await DB.get('papers', p.id);
        await setStatus(fresh, 'read');
        toast('🎉 Marked as read');
        after();
      },
    });
  }

  function parseQuery(qs) {
    return Object.fromEntries(new URLSearchParams(qs || ''));
  }

  function stars(rating, interactive) {
    let html = `<span class="stars${interactive ? ' interactive' : ''}" ${interactive ? 'role="radiogroup" aria-label="Rating"' : `aria-label="${rating || 0} of 5 stars"`}>`;
    for (let i = 1; i <= 5; i++) {
      const on = i <= (rating || 0);
      html += interactive
        ? `<button type="button" class="star${on ? ' on' : ''}" data-rate="${i}" aria-label="${i} star${i > 1 ? 's' : ''}">★</button>`
        : `<span class="star${on ? ' on' : ''}">★</span>`;
    }
    return html + '</span>';
  }

  function progressBar(p) {
    return `<div class="bar" role="progressbar" aria-valuenow="${Math.round(pct(p) * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${(pct(p) * 100).toFixed(1)}%"></span></div>`;
  }

  const EPUB_BADGE = '<span class="badge epub" title="Has an EPUB to read">📖 EPUB</span>';
  function paperRow(p, extra = '') {
    return `<li class="paper-row">
      <a href="#/paper/${p.id}" class="paper-link">
        <span class="pr-title">${esc(p.title || 'Untitled')}</span>
        <span class="pr-meta">${esc(authorsShort(p.authors))}${p.year ? ` · ${p.year}` : ''}${p.venue ? ` · ${esc(p.venue)}` : ''}</span>
        ${p.status === 'reading' ? `<span class="pr-progress">${progressBar(p)}<small>${progressLabel(p)}</small></span>` : ''}
        <span class="pr-badges">
          <span class="badge s-${p.status}">${STATUS[p.status]}</span>
          ${p.rating ? stars(p.rating) : ''}
          ${p.hasPdf ? '<span class="badge">PDF</span>' : ''}
          ${p.hasEpub ? EPUB_BADGE : ''}
          ${(p.tags || []).slice(0, 3).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}
        </span>
      </a>${extra}
    </li>`;
  }

  // ---------- data ops ----------
  async function papers() {
    return DB.all('papers');
  }

  // Each field remembers when it last changed (p.ft), so sync can take the
  // newest of each field rather than the newest whole paper: a position read
  // on the phone and a note typed on the laptop both survive.
  async function savePaper(p) {
    const t = now();
    const old = await DB.get('papers', p.id);
    const ft = { ...(old && old.ft), ...p.ft };
    const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
    for (const k of new Set([...Object.keys(p), ...Object.keys(old || {})])) {
      if (k === 'ft' || k === 'updatedAt') continue;
      if (!old || !same(old[k], p[k])) ft[k] = t;
    }
    p.ft = ft;
    p.updatedAt = t;
    await DB.put('papers', p);
    return p;
  }

  async function nextQueueOrder() {
    const all = await papers();
    return all.filter((p) => p.status === 'want').reduce((m, p) => Math.max(m, p.queueOrder ?? 0), 0) + 1;
  }

  async function logProgress(p, value, isPercent) {
    let delta = 0;
    if (isPercent) {
      p.percent = Math.max(0, Math.min(100, value));
    } else {
      const v = Math.max(0, p.totalPages ? Math.min(p.totalPages, value) : value);
      delta = v - (p.currentPage || 0);
      p.currentPage = v;
    }
    await DB.put('progress', { paperId: p.id, date: today(), ts: now(), page: p.currentPage || 0, percent: p.percent || 0, delta });
    if ((p.status === 'want' || p.status === 'none') && pct(p) > 0) await setStatus(p, 'reading', true);
    await savePaper(p);
    return pct(p) >= 1 && p.status !== 'read'; // at the end, not yet marked read
  }

  async function setStatus(p, status, skipSave) {
    const prev = p.status;
    p.status = status;
    if (status === 'reading' && !p.startedAt) p.startedAt = now();
    if (status === 'want' && prev !== 'want') p.queueOrder = await nextQueueOrder();
    // off the list: its old place mustn't pin the group it heads (that group then follows its papers' places)
    if (prev === 'want' && status !== 'want') delete p.queueOrder;
    if (status === 'read') {
      p.finishedAt = p.finishedAt || now();
      if (!p.startedAt) p.startedAt = p.finishedAt;
      // Count the unread remainder so "pages read" stays honest.
      if (p.totalPages && (p.currentPage || 0) < p.totalPages) {
        await DB.put('progress', { paperId: p.id, date: today(), ts: now(), page: p.totalPages, percent: 100, delta: p.totalPages - (p.currentPage || 0) });
        p.currentPage = p.totalPages;
      } else if (!p.totalPages) p.percent = 100;
    } else if (prev === 'read') {
      p.finishedAt = null;
    }
    if (!skipSave) await savePaper(p);
  }

  // ---------- discovery trails: which paper led you to which ----------
  // Each paper may name the one it was found through (p.foundVia), which
  // makes a tree: the paper you started from at the root, snowballed
  // references below it.
  function trailOf(all) {
    const byId = new Map(all.map((x) => [x.id, x]));
    const kids = new Map();
    for (const x of all) if (x.foundVia && byId.has(x.foundVia) && x.foundVia !== x.id) (kids.get(x.foundVia) || kids.set(x.foundVia, []).get(x.foundVia)).push(x);
    for (const list of kids.values()) list.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    const ancestors = (p) => {
      const out = [];
      const seen = new Set([p.id]);
      for (let x = byId.get(p.foundVia); x && !seen.has(x.id); x = byId.get(x.foundVia)) {
        out.unshift(x);
        seen.add(x.id);
      }
      return out;
    };
    const descendants = (id) => {
      const out = new Set();
      const walk = (i) => (kids.get(i) || []).forEach((k) => !out.has(k.id) && (out.add(k.id), walk(k.id)));
      walk(id);
      return out;
    };
    const rootOf = (p) => ancestors(p)[0] || p;
    return { byId, kids, ancestors, descendants, rootOf };
  }

  function trailTree(node, kids, current, seen = new Set()) {
    seen.add(node.id);
    const children = (kids.get(node.id) || []).filter((k) => !seen.has(k.id));
    return `<li><a href="#/paper/${node.id}" class="t-node${node.id === current ? ' current' : ''}"><span class="t-dot s-${node.status}" title="${STATUS[node.status]}"></span><span>${esc(node.title)}</span>${node.year ? `<span class="muted small"> ${node.year}</span>` : ''}</a>${
      children.length ? `<ul>${children.map((k) => trailTree(k, kids, current, seen)).join('')}</ul>` : ''
    }</li>`;
  }

  // Deleted papers wait in a bin on this device for 30 days, files and all.
  const TRASH_DAYS = 30;
  async function trashed() {
    const t = (await DB.setting('trash', {})) || {};
    const cutoff = now() - TRASH_DAYS * 864e5;
    const old = Object.keys(t).filter((id) => t[id].deletedAt < cutoff);
    if (old.length) {
      old.forEach((id) => delete t[id]);
      await DB.setSetting('trash', t);
    }
    return t;
  }

  // Bring a deleted paper back from the bin or from Drive's history. It's
  // saved as new, so sync treats it as newer than its deletion.
  async function restoreRecords({ paper, rows = {}, pdf = null, epub = null, children = [] }) {
    const p = { ...paper };
    delete p.ft;
    p.hasPdf = !!pdf;
    p.hasEpub = !!epub;
    if (p.foundVia && !(await DB.get('papers', p.foundVia))) p.foundVia = null;
    if (p.status === 'want' && p.queueOrder == null) p.queueOrder = await nextQueueOrder();
    await savePaper(p);
    if (pdf) await DB.put('pdfs', { ...pdf, mtime: undefined });
    if (epub) await DB.put('epubs', { ...epub, mtime: undefined });
    for (const store of ['progress', 'highlights', 'links']) {
      for (const r of rows[store] || []) {
        if (store === 'links' && !(await DB.get('papers', r.fromId === p.id ? r.toId : r.fromId))) continue;
        const row = { ...r };
        delete row.id;
        delete row.mtime;
        await DB.put(store, row);
      }
    }
    // papers that moved up when it was deleted go back under it
    for (const [cid, was] of children) {
      const c = await DB.get('papers', cid);
      if (c && (c.foundVia || null) === was) {
        c.foundVia = p.id;
        await savePaper(c);
      }
    }
    return p;
  }

  async function deletePaper(id) {
    // papers found through this one move up to where it was found
    const gone = await DB.get('papers', id);
    if (gone) {
      const [pdf, epub, progress, highlights, linksFrom, linksTo] = await Promise.all([
        DB.get('pdfs', id),
        DB.get('epubs', id),
        DB.byIndex('progress', 'paperId', id),
        DB.byIndex('highlights', 'paperId', id),
        DB.byIndex('links', 'fromId', id),
        DB.byIndex('links', 'toId', id),
      ]);
      const children = (await papers()).filter((x) => x.foundVia === id).map((x) => [x.id, gone.foundVia || null]);
      const t = await trashed();
      t[id] = { deletedAt: now(), paper: gone, pdf: pdf || null, epub: epub || null, rows: { progress, highlights, links: [...linksFrom, ...linksTo] }, children };
      await DB.setSetting('trash', t);
    }
    for (const child of (await papers()).filter((x) => x.foundVia === id)) {
      child.foundVia = (gone && gone.foundVia) || null;
      await savePaper(child);
    }
    await DB.del('papers', id);
    await DB.del('pdfs', id);
    await DB.del('epubs', id);
    await DB.delWhere('progress', 'paperId', id);
    await DB.delWhere('highlights', 'paperId', id);
    await DB.delWhere('links', 'fromId', id);
    await DB.delWhere('links', 'toId', id);
  }

  // Re-reads the paper so a slow download can't overwrite edits made meanwhile.
  async function attachPdf(id, file) {
    await DB.put('pdfs', { paperId: id, blob: file, name: file.name || 'paper.pdf', size: file.size, addedAt: now() });
    const p = await DB.get('papers', id);
    p.hasPdf = true;
    if (!p.totalPages) {
      const n = await Lookup.countPdfPages(file);
      if (n) p.totalPages = n;
    }
    await savePaper(p);
    return p;
  }

  async function attachEpub(id, file, { cover = null, source = 'Imported', missingFigures = 0 } = {}) {
    await DB.put('epubs', { paperId: id, blob: file, name: file.name || 'paper.epub', size: file.size, cover, source, missingFigures, addedAt: now() });
    const p = await DB.get('papers', id);
    p.hasEpub = true;
    p.format = 'epub';
    p.epubCfi = null; // a new file invalidates the old reading position
    await savePaper(p);
    return p;
  }

  const isEpub = (f) => f && (f.type === 'application/epub+zip' || /\.epub$/i.test(f.name || ''));
  // A saved web page: Chrome's "Download page" makes .mhtml.
  const isWebFile = (f) => f && (/^(text\/html|multipart\/related|message\/rfc822|application\/x-mimearchive)$/.test(f.type) || /\.(mhtml?|mht|html?)$/i.test(f.name || ''));
  const fileKind = (f) => (isEpub(f) ? 'EPUB' : isWebFile(f) ? 'web page' : 'PDF');

  // EPUB from a web page (fetched or saved), stored on the paper.
  async function makeWebEpub(id, page) {
    const p = await DB.get('papers', id);
    const res = await Epubify.make(p, { source: 'web', page });
    await attachEpub(id, res.file, { cover: res.cover, source: res.source, missingFigures: res.missingFigures });
    return res;
  }

  // Make an EPUB in the background and store it (used after adding a paper).
  async function makeEpubFor(id, source = 'auto') {
    const p = await DB.get('papers', id);
    const pdf = await DB.get('pdfs', id);
    const res = await Epubify.make(p, { source, pdf: pdf ? { blob: pdf.blob, name: pdf.name } : null });
    await attachEpub(id, res.file, { cover: res.cover, source: res.source, missingFigures: res.missingFigures });
    return res;
  }

  function downloadFile(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // Share sheet when the browser can share this file type, else save it.
  async function shareOrSave(file, title) {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title });
      } catch {}
    } else {
      downloadFile(file);
      toast('Saved to Downloads. Open it from there with any reader app');
    }
  }

  // ---------- concerns: a per-paper list, shared by the paper page and reader ----------
  // Stored on the paper record (so backups and merges carry it along).
  const openConcerns = (p) => (p.concerns || []).filter((c) => !c.done).length;

  function concernsUI(root, paperId, { jump = null, onChange = () => {} } = {}) {
    const mutate = async (fn) => {
      const p = await DB.get('papers', paperId);
      p.concerns = p.concerns || [];
      fn(p.concerns, p);
      await savePaper(p);
      await draw();
      onChange(p);
    };
    async function draw() {
      const p = await DB.get('papers', paperId);
      const list = [...(p.concerns || [])].sort((a, b) => a.done - b.done || a.createdAt - b.createdAt);
      const open = openConcerns(p);
      root.innerHTML = `<h3>Concerns ${list.length ? `<span class="badge ${open ? 's-concern' : ''}">${open} open${list.length - open ? ` · ${list.length - open} resolved` : ''}</span>` : ''}</h3>
        <ul class="concerns">${
          list
            .map(
              (c) => `<li class="${c.done ? 'done' : ''}" data-id="${c.id}">
                <input type="checkbox" class="c-done" ${c.done ? 'checked' : ''} aria-label="Resolved">
                <div class="c-body">
                  ${c.quote ? `<q class="c-quote">${esc(c.quote.length > 220 ? c.quote.slice(0, 220) + '…' : c.quote)}</q>` : ''}
                  <span class="c-text" role="button" tabindex="0" title="Tap to edit">${c.text ? esc(c.text) : '<em class="muted">Add a note…</em>'}</span>
                  ${c.cfi ? (jump ? '<button type="button" class="link small c-jump">Show in text</button>' : p.hasEpub ? `<a class="link small" href="#/read/${paperId}?cfi=${encodeURIComponent(c.cfi)}">Show in reader</a>` : '') : ''}
                </div>
                <button type="button" class="btn small danger-ghost c-del" aria-label="Delete concern">×</button>
              </li>`
            )
            .join('') || '<li class="muted small">No concerns yet. Note doubts, methodological issues, things to check.</li>'
        }</ul>
        <form class="row c-add"><input name="t" placeholder="Add a concern…" autocomplete="off" aria-label="New concern"><button class="btn">Add</button></form>`;
      const byId = (el) => el.closest('li').dataset.id;
      $$('.c-done', root).forEach((cb) => cb.addEventListener('change', () => mutate((cs) => (cs.find((c) => c.id === byId(cb)).done = cb.checked))));
      $$('.c-del', root).forEach((b) =>
        b.addEventListener('click', () => {
          if (confirm('Delete this concern?')) mutate((cs) => cs.splice(cs.findIndex((c) => c.id === byId(b)), 1));
        })
      );
      $$('.c-text', root).forEach((span) => {
        const edit = () => {
          const id = byId(span);
          const current = (list.find((c) => c.id === id) || {}).text || '';
          const ta = document.createElement('textarea');
          ta.rows = 3;
          ta.value = current;
          span.replaceWith(ta);
          ta.focus();
          ta.addEventListener('blur', () => mutate((cs) => (cs.find((c) => c.id === id).text = ta.value.trim())));
        };
        span.addEventListener('click', edit);
        span.addEventListener('keydown', (e) => e.key === 'Enter' && edit());
      });
      if (jump) $$('.c-jump', root).forEach((b) => b.addEventListener('click', () => jump((list.find((c) => c.id === byId(b)) || {}).cfi)));
      $('.c-add', root).addEventListener('submit', (e) => {
        e.preventDefault();
        const text = e.target.t.value.trim();
        if (text) mutate((cs) => cs.push({ id: uid(), text, done: false, createdAt: now() }));
      });
    }
    draw();
    return {
      refresh: draw,
      add: (c) => mutate((cs) => cs.push({ id: uid(), done: false, createdAt: now(), text: '', ...c })),
    };
  }

  // A small dialog asking for a line of text; resolves null on cancel.
  const askNote = (title, initial = '') =>
    new Promise((resolve) => {
      const dlg = $('#dialog');
      dlg.innerHTML = `<form method="dialog" class="dlg"><h3>${esc(title)}</h3>
        <textarea name="note" rows="4" placeholder="Your note">${esc(initial)}</textarea>
        <div class="row end"><button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn primary">Save</button></div></form>`;
      dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? $('[name=note]', dlg).value.trim() : null);
      dlg.showModal();
      $('[name=note]', dlg).focus();
    });

  // ---------- Ask Claude: a conversation per paper, on the paper page and in the reader ----------
  const money = (d) => (d < 0.01 ? '<1¢' : d < 1 ? `${Math.round(d * 100)}¢` : `$${d.toFixed(2)}`);

  // Just enough Markdown for chat answers: paragraphs, lists, bold, italics, code.
  function md(text) {
    const inline = (t) =>
      esc(t)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    for (const line of String(text || '').split('\n')) {
      const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      const h = /^#{1,4}\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) {
          flushList();
          list = { tag, items: [] };
        }
        list.items.push((ul || ol)[1]);
      } else if (!line.trim()) {
        flushPara();
        flushList();
      } else if (h) {
        flushPara();
        flushList();
        out.push(`<p><strong>${inline(h[1])}</strong></p>`);
      } else {
        if (list) flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
    return out.join('');
  }

  const ASK_SUGGESTIONS = ['Summarise the main claims and evidence', 'What are the weak points?', 'Explain the methods simply', 'What should I check before believing this?'];

  function askUI(root, paperId, { addConcern = null } = {}) {
    let quote = '';
    let busy = false;
    let controller = null;
    const turnHtml = (t, i) =>
      t.role === 'user'
        ? `<div class="turn u">${t.quote ? `<q>${esc(t.quote.length > 200 ? t.quote.slice(0, 200) + '…' : t.quote)}</q>` : ''}${esc(t.question)}</div>`
        : `<div class="turn a">${md(t.text)}${t.notice ? `<p class="muted small">${esc(t.notice)}</p>` : ''}
            <div class="turn-actions"><button type="button" class="link small" data-tonote="${i}">→ Notes</button>${addConcern ? `<button type="button" class="link small" data-toconcern="${i}">→ Concern</button>` : ''}<span class="muted small" title="${esc(Ask.MODELS[t.model]?.label || t.model || '')}, from the paper’s ${esc(t.source || 'text')}">${money(t.cost || 0)}</span></div></div>`;

    async function draw() {
      const [p, key] = await Promise.all([DB.get('papers', paperId), DB.setting('anthropicKey', '')]);
      const chat = p.chat || [];
      const total = chat.reduce((sum, t) => sum + (t.cost || 0), 0);
      if (!key) {
        root.innerHTML = `<h3>Ask Claude</h3><p class="muted small">Ask questions about this paper, have passages explained, or get help with your concerns. Add your Anthropic API key in <a href="#/settings">Settings</a> to start.</p>`;
        return;
      }
      root.innerHTML = `<h3>Ask Claude ${total ? `<span class="muted small">${money(total)} so far</span>` : ''}</h3>
        <div class="chat">${chat.map(turnHtml).join('')}<div class="turn u" id="ask-q" hidden></div><div class="turn a" id="ask-live" hidden></div></div>
        ${chat.length ? '' : `<div class="chips">${ASK_SUGGESTIONS.map((x) => `<button type="button" class="chip" data-suggest>${esc(x)}</button>`).join('')}</div>`}
        <div class="ask-quote" ${quote ? '' : 'hidden'}><q>${esc(quote.length > 200 ? quote.slice(0, 200) + '…' : quote)}</q><button type="button" class="r-btn" id="ask-unquote" aria-label="Don’t ask about this passage">✕</button></div>
        <form class="ask-form"><textarea name="q" rows="2" placeholder="${quote ? 'What about this passage?' : 'Ask about this paper…'}" aria-label="Question"></textarea><button class="btn primary" id="ask-go">Ask</button></form>
        <p class="muted small" id="ask-err" hidden></p>
        ${chat.length ? '<button type="button" class="link small" id="ask-clear">Clear conversation</button>' : ''}`;
      const form = $('.ask-form', root);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (busy) return controller && controller.abort();
        const q = form.q.value.trim();
        if (q) send(q);
      });
      form.q.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
      });
      $$('[data-suggest]', root).forEach((b) => b.addEventListener('click', () => send(b.textContent)));
      $('#ask-unquote', root)?.addEventListener('click', () => {
        quote = '';
        draw();
      });
      $('#ask-clear', root)?.addEventListener('click', async () => {
        if (!confirm('Clear this conversation?')) return;
        const fresh = await DB.get('papers', paperId);
        fresh.chat = [];
        await savePaper(fresh);
        draw();
      });
      $$('[data-tonote]', root).forEach((b) =>
        b.addEventListener('click', async () => {
          const fresh = await DB.get('papers', paperId);
          const t = fresh.chat[Number(b.dataset.tonote)];
          const q = fresh.chat[Number(b.dataset.tonote) - 1];
          fresh.notes = `${(fresh.notes || '').trim()}${fresh.notes ? '\n\n' : ''}Q: ${q ? q.question : ''}\nClaude: ${t.text.trim()}`;
          await savePaper(fresh);
          toast('Added to your notes');
        })
      );
      $$('[data-toconcern]', root).forEach((b) =>
        b.addEventListener('click', async () => {
          const fresh = await DB.get('papers', paperId);
          const i = Number(b.dataset.toconcern);
          const t = fresh.chat[i];
          const q = fresh.chat[i - 1] || {};
          const first = t.text.trim().split(/\n\s*\n/)[0].replace(/[*_`#]/g, '');
          const text = await askNote('Concern', first.length > 300 ? first.slice(0, 300) + '…' : first);
          if (text === null) return;
          await addConcern({ text, quote: q.quote || '' });
          toast('Concern added');
        })
      );
      const chatEl = $('.chat', root);
      chatEl.scrollTop = chatEl.scrollHeight;
    }

    async function send(question) {
      if (busy) return;
      busy = true;
      const form = $('.ask-form', root);
      const qEl = $('#ask-q', root);
      const live = $('#ask-live', root);
      const err = $('#ask-err', root);
      $('.chips', root)?.remove();
      err.hidden = true;
      qEl.hidden = false;
      qEl.innerHTML = `${quote ? `<q>${esc(quote.length > 200 ? quote.slice(0, 200) + '…' : quote)}</q>` : ''}${esc(question)}`;
      live.hidden = false;
      live.innerHTML = '<p class="muted thinking">Reading the paper and thinking…</p>';
      form.q.value = '';
      form.q.disabled = true;
      $('#ask-go', root).textContent = 'Stop';
      controller = new AbortController();
      let text = '';
      let frame = 0;
      const chatEl = $('.chat', root);
      try {
        const p = await DB.get('papers', paperId);
        const turns = await Ask.ask(p, Ask.sendable(p.chat || []), question, {
          quote,
          signal: controller.signal,
          onText: (d) => {
            text += d;
            if (frame) return;
            frame = requestAnimationFrame(() => {
              frame = 0;
              live.innerHTML = md(text);
              chatEl.scrollTop = chatEl.scrollHeight;
            });
          },
        });
        const fresh = await DB.get('papers', paperId);
        fresh.chat = [...(fresh.chat || []), ...turns];
        await savePaper(fresh);
        quote = '';
        busy = false;
        await draw();
      } catch (e) {
        busy = false;
        await draw();
        const box = $('.ask-form', root);
        if (box) box.q.value = question;
        const errEl = $('#ask-err', root);
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = e.message;
        }
      }
    }

    draw();
    return {
      refresh: draw,
      // ask about a selected passage
      quote(text) {
        quote = text;
        draw().then(() => $('.ask-form textarea', root)?.focus());
      },
    };
  }

  async function allTags() {
    const counts = {};
    for (const p of await papers()) for (const t of p.tags || []) counts[t] = (counts[t] || 0) + 1;
    return counts;
  }

  // ---------- router ----------
  const routes = [
    [/^#?\/?$/, viewHome],
    [/^#\/library$/, viewLibrary],
    [/^#\/queue$/, viewQueue],
    [/^#\/stats$/, viewStats],
    [/^#\/collections$/, viewCollections],
    [/^#\/backup$/, viewBackup],
    [/^#\/settings$/, viewSettings],
    [/^#\/friends$/, viewFriends],
    [/^#\/trash$/, viewTrash],
    [/^#\/friend\/(.+)$/, (q, uid) => viewFriend(uid)],
    [/^#\/trails$/, viewTrails],
    [/^#\/trail\/(.+)$/, (q, id) => viewTrails(q, id)],
    [/^#\/add$/, (q) => viewEdit(null, q)],
    [/^#\/edit\/(.+)$/, (q, id) => viewEdit(id, q)],
    [/^#\/paper\/(.+)$/, (q, id) => viewPaper(id)],
    [/^#\/read\/(.+)$/, (q, id) => viewReader(id, q)],
  ];

  // Views that hold resources (the EPUB reader) register a cleanup here.
  let teardown = null;

  // Renders run one at a time so a slow view can't paint over a newer one.
  let routing = Promise.resolve();
  function route() {
    routing = routing.then(renderRoute, renderRoute);
    return routing;
  }

  async function renderRoute() {
    if (teardown) {
      const t = teardown;
      teardown = null;
      await t();
    }
    const [path, qs] = location.hash.split('?');
    const q = parseQuery(qs);
    for (const [re, fn] of routes) {
      const m = re.exec(path || '');
      if (m) {
        $$('.nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href').split('?')[0] === (path || '#/')));
        try {
          await fn(q, ...m.slice(1).map(decodeURIComponent));
        } catch (err) {
          console.error(err);
          main.innerHTML = `<p class="empty">Something went wrong: ${esc(err.message)}</p>`;
        }
        return;
      }
    }
    location.hash = '#/';
  }

  function setTitle(t) {
    $('#page-title').textContent = t;
    document.title = t === 'PaperReads' ? t : `${t} · PaperReads`;
  }

  // ---------- views ----------
  async function viewHome() {
    setTitle('PaperReads');
    const all = await papers();
    const year = new Date().getFullYear();
    const goal = await DB.setting('goal:' + year, 0);
    const done = all.filter((p) => p.status === 'read' && p.finishedAt && new Date(p.finishedAt).getFullYear() === year).length;
    const reading = all.filter((p) => p.status === 'reading').sort((a, b) => b.updatedAt - a.updatedAt);
    const queue = queueList(all).slice(0, 3);
    const recent = all.filter((p) => p.status === 'read').sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)).slice(0, 3);

    if (!all.length) {
      main.innerHTML = `<section class="empty-hero">
        <h2>Your paper shelf is empty</h2>
        <p>Add a paper by DOI, arXiv link or title, or install the app and share a link to it from your browser.</p>
        <a class="btn primary" href="#/add">Add a paper</a>
        <a class="link" href="#/backup">Restore from a backup</a>
      </section>`;
      return;
    }

    // Nudge when the only copy of the library has gone a while without a backup.
    const lastBackup = await DB.setting('lastBackup', null);
    const ageDays = lastBackup ? Math.floor((Date.now() - lastBackup) / 86400000) : null;
    const nudge = lastBackup ? ageDays >= 30 : all.length >= 5;

    main.innerHTML = `
      ${nudge ? `<section class="card nudge"><p>${lastBackup ? `Last backup was ${ageDays} days ago.` : 'Your library isn’t backed up yet.'}</p><a class="btn small" href="#/backup">Back up</a></section>` : ''}
      <section class="card goal-card">
        <div class="row between"><h2>${year} goal</h2><a href="#/stats" class="link">Stats →</a></div>
        ${goal ? `<p class="big">${done} <small>of ${goal} papers</small></p>
          <div class="bar"><span style="width:${Math.min(100, (done / goal) * 100).toFixed(1)}%"></span></div>`
          : `<p class="big">${done} <small>papers read this year</small></p><a href="#/stats" class="link">Set a reading goal</a>`}
      </section>
      <section>
        <h2 class="section-h">Currently reading</h2>
        ${reading.length ? `<ul class="list">${reading.map((p) => paperRow(p, `<span class="q-actions col">${p.hasEpub ? `<a class="btn small primary" href="#/read/${p.id}">Read</a>` : ''}<button class="btn small" data-quick="${p.id}">Update</button></span>`)).join('')}</ul>` : '<p class="empty">Nothing in progress. Pick something from your queue.</p>'}
      </section>
      <section>
        <div class="row between"><h2 class="section-h">Next up</h2><a href="#/queue" class="link">Queue →</a></div>
        ${queue.length ? `<ul class="list">${queue.map((p) => paperRow(p, `<button class="btn small" data-start="${p.id}">Start</button>`)).join('')}</ul>` : '<p class="empty">Your want-to-read list is empty.</p>'}
      </section>
      ${recent.length ? `<section><h2 class="section-h">Recently finished</h2><ul class="list">${recent.map((p) => paperRow(p)).join('')}</ul></section>` : ''}
    `;
    $$('[data-quick]').forEach((b) => b.addEventListener('click', () => quickProgress(b.dataset.quick)));
    $$('[data-start]').forEach((b) =>
      b.addEventListener('click', async () => {
        const p = await DB.get('papers', b.dataset.start);
        await setStatus(p, 'reading');
        toast('Started reading');
        route();
      })
    );
  }

  async function quickProgress(id) {
    const p = await DB.get('papers', id);
    const dlg = $('#dialog');
    const isPct = !p.totalPages;
    dlg.innerHTML = `<form method="dialog" class="dlg">
      <h3>${esc(p.title)}</h3>
      <label>${isPct ? 'Percent read' : `Page reached (of ${p.totalPages})`}
        <input type="number" name="v" inputmode="numeric" min="0" ${isPct ? 'max="100"' : `max="${p.totalPages}"`} value="${isPct ? Math.round(p.percent || 0) : p.currentPage || 0}" required>
      </label>
      <input type="range" name="r" min="0" max="${isPct ? 100 : p.totalPages}" value="${isPct ? Math.round(p.percent || 0) : p.currentPage || 0}">
      <div class="row end"><button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn primary">Save</button></div>
    </form>`;
    const num = $('[name=v]', dlg);
    const rng = $('[name=r]', dlg);
    rng.addEventListener('input', () => (num.value = rng.value));
    num.addEventListener('input', () => (rng.value = num.value));
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'ok') return;
      const atEnd = await logProgress(p, Number(num.value), isPct);
      if (atEnd) offerFinish(p, route);
      else toast('Progress saved');
      route();
    };
    dlg.showModal();
    num.select();
  }

  async function viewLibrary(q) {
    setTitle('Library');
    const all = await papers();
    const cols = await DB.all('collections');
    const tags = Object.keys(await allTags()).sort();
    const status = q.status || '';
    const sort = q.sort || 'added';
    const term = (q.q || '').toLowerCase();

    let list = all.filter((p) => {
      if (status && p.status !== status) return false;
      if (q.col && !(p.collections || []).includes(q.col)) return false;
      if (q.tag && !(p.tags || []).includes(q.tag)) return false;
      if (term) {
        const hay = [p.title, (p.authors || []).join(' '), p.venue, p.year, p.doi, p.arxiv, (p.tags || []).join(' '), p.notes, p.abstract].join(' ').toLowerCase();
        if (!term.split(/\s+/).every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    const sorters = {
      added: (a, b) => b.addedAt - a.addedAt,
      title: (a, b) => (a.title || '').localeCompare(b.title || ''),
      year: (a, b) => (b.year || 0) - (a.year || 0),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0),
      finished: (a, b) => (b.finishedAt || 0) - (a.finishedAt || 0),
    };
    list.sort(sorters[sort] || sorters.added);

    const link = (patch) => {
      const params = new URLSearchParams({ ...q, ...patch });
      for (const [k, v] of [...params]) if (!v) params.delete(k);
      return `#/library?${params}`;
    };

    main.innerHTML = `
      <form class="search" id="search"><input type="search" name="q" placeholder="Search title, author, tag, notes…" value="${esc(q.q || '')}" aria-label="Search library"></form>
      <nav class="chips" aria-label="Filter by status">
        ${[['', 'All'], ['want', 'Want'], ['reading', 'Reading'], ['read', 'Read'], ['none', 'Catalogued']]
          .map(([s, l]) => `<a class="chip${status === s ? ' on' : ''}" href="${link({ status: s })}">${l} <small>${s ? all.filter((p) => p.status === s).length : all.length}</small></a>`)
          .join('')}
      </nav>
      <div class="filters">
        <select id="f-col" aria-label="Collection"><option value="">All collections</option>${cols.sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<option value="${c.id}"${q.col === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <select id="f-tag" aria-label="Tag"><option value="">All tags</option>${tags.map((t) => `<option${q.tag === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <select id="f-sort" aria-label="Sort">
          ${[['added', 'Recently added'], ['title', 'Title'], ['year', 'Year'], ['rating', 'Rating'], ['finished', 'Recently finished']].map(([v, l]) => `<option value="${v}"${sort === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <p class="muted count">${list.length} paper${list.length === 1 ? '' : 's'}</p>
      ${list.length ? `<ul class="list">${list.map((p) => paperRow(p)).join('')}</ul>` : '<p class="empty">No papers match.</p>'}
      <p class="muted small trash-link"><a href="#/trash">🗑 Recently deleted</a></p>
    `;
    $('#search').addEventListener('submit', (e) => {
      e.preventDefault();
      location.hash = link({ q: e.target.q.value.trim() });
    });
    $('#f-col').addEventListener('change', (e) => (location.hash = link({ col: e.target.value })));
    $('#f-tag').addEventListener('change', (e) => (location.hash = link({ tag: e.target.value })));
    $('#f-sort').addEventListener('change', (e) => (location.hash = link({ sort: e.target.value })));
  }

  // ---------- reading order: trails grouped under the paper they started from ----------
  // Each "want to read" paper sits in the group of its trail's top paper
  // (p.foundVia chains); groups are ordered by the top paper's queueOrder,
  // papers inside a group by subOrder among their siblings (else date added).
  function queueGroups(all) {
    const t = trailOf(all);
    const want = all.filter((p) => p.status === 'want');
    const groups = new Map();
    for (const p of want) {
      const root = t.rootOf(p);
      if (!groups.has(root.id)) groups.set(root.id, { root, want: [] });
      groups.get(root.id).want.push(p);
    }
    const sibling = (a, b) => (a.subOrder ?? Infinity) - (b.subOrder ?? Infinity) || (a.addedAt || 0) - (b.addedAt || 0);
    // the papers to show under a group: wanted ones and the papers leading to them
    for (const g of groups.values()) {
      g.shown = new Set();
      for (const p of g.want) for (const x of [p, ...t.ancestors(p)]) g.shown.add(x.id);
      g.order = g.root.queueOrder ?? Math.min(...g.want.map((p) => p.queueOrder ?? Infinity));
      g.kids = (id) => (t.kids.get(id) || []).filter((k) => g.shown.has(k.id)).sort(sibling);
      // the group's wanted papers in reading order: the top paper, then depth first
      g.flat = [];
      const walk = (p) => {
        if (p.status === 'want') g.flat.push(p);
        g.kids(p.id).forEach(walk);
      };
      walk(g.root);
    }
    return [...groups.values()].sort((a, b) => a.order - b.order || (a.root.addedAt || 0) - (b.root.addedAt || 0));
  }
  const queueList = (all) => queueGroups(all).flatMap((g) => g.flat);

  async function viewQueue() {
    setTitle('Want to read');
    const all = await papers();
    const groups = queueGroups(all);
    if (!groups.length) {
      main.innerHTML = '<p class="empty">Your queue is empty. Papers marked “Want to read” show up here in priority order.</p>';
      return;
    }
    let open = new Set();
    try {
      open = new Set(JSON.parse(localStorage.getItem('paperreads.queue-open') || '[]'));
    } catch {}
    const meta = (p) => `${p.hasEpub ? EPUB_BADGE + ' ' : ''}${esc(authorsShort(p.authors))}${p.year ? ` · ${p.year}` : ''}`;
    const badge = (p) => (p.status === 'want' ? '' : `<span class="badge s-${p.status}">${STATUS[p.status]}</span>`);
    const start = (p) => (p.status === 'want' ? `<button class="btn small" data-start="${p.id}">Start</button>` : '');
    const node = (g, p) => {
      const kids = g.kids(p.id);
      return `<li class="q-node" data-id="${p.id}">
        <div class="q-row">${g.kids(p.foundVia).length > 1 ? '<span class="handle" aria-label="Drag to reorder">☰</span>' : '<span class="handle-gap"></span>'}
          <a href="#/paper/${p.id}" class="paper-link${p.status === 'want' ? '' : ' dim'}"><span class="pr-title">${esc(p.title)}</span><span class="pr-meta">${badge(p)} ${meta(p)}</span></a>${start(p)}</div>
        ${kids.length ? `<ul class="q-sub" data-parent="${p.id}">${kids.map((k) => node(g, k)).join('')}</ul>` : ''}
      </li>`;
    };
    main.innerHTML = `<p class="muted">Drag ☰ to reorder. Swipe a paper right to archive it (it stays in your library as Catalogued), left to delete it (Recently deleted keeps it for 30 days). Papers you found through another one are grouped under the paper the trail started from; open a group to see (and order) them.</p>
      <ul class="list queue" id="queue">${groups
        .map((g, i) => {
          const kids = g.kids(g.root.id);
          const count = g.want.filter((p) => p.id !== g.root.id).length;
          const isOpen = open.has(g.root.id);
          return `<li class="paper-row q-item${kids.length ? ' q-group' : ''}" data-id="${g.root.id}">
            <span class="handle" aria-label="Drag to reorder">☰</span>
            <span class="q-num">${i + 1}</span>
            <div class="q-main">
              <a href="#/paper/${g.root.id}" class="paper-link${g.root.status === 'want' ? '' : ' dim'}"><span class="pr-title">${esc(g.root.title)}</span><span class="pr-meta">${badge(g.root)} ${meta(g.root)}</span></a>
              ${kids.length ? `<button type="button" class="q-toggle" data-toggle="${g.root.id}" aria-expanded="${isOpen}">${isOpen ? '▾' : '▸'} ${count} found through it</button>` : ''}
            </div>
            <span class="q-actions">
              <button class="btn small icon" data-top="${g.root.id}" aria-label="Move to top" title="Move to top">⤒</button>
              ${start(g.root)}
            </span>
            ${kids.length ? `<ul class="q-sub q-sub-top" data-parent="${g.root.id}" ${isOpen ? '' : 'hidden'}>${kids.map((k) => node(g, k)).join('')}</ul>` : ''}
          </li>`;
        })
        .join('')}</ul>`;

    const ul = $('#queue');
    const byId = new Map(all.map((p) => [p.id, p]));
    // Save through savePaper so the new order syncs (it dates the changed field).
    const persist = async (list) => {
      const top = list === ul;
      const lis = [...list.children].filter((li) => li.dataset.id);
      for (const [i, li] of lis.entries()) {
        const p = byId.get(li.dataset.id);
        const key = top ? 'queueOrder' : 'subOrder';
        if (p[key] === i + 1) continue;
        p[key] = i + 1;
        await savePaper(p);
      }
      if (top) $$(':scope > li > .q-num', ul).forEach((el, i) => (el.textContent = i + 1));
    };

    // Pointer-based drag (works with touch, no library), within one list:
    // the groups, or the papers under one parent.
    let dragging = null;
    ul.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.handle');
      if (!handle) return;
      dragging = handle.closest('li');
      dragging.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    ul.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const list = dragging.parentElement;
      const items = [...list.children].filter((li) => li !== dragging);
      const after = items.find((li) => {
        const r = li.getBoundingClientRect();
        return e.clientY < r.top + Math.min(r.height, 56) / 2;
      });
      if (after) list.insertBefore(dragging, after);
      else list.appendChild(dragging);
      if (e.clientY < 80) window.scrollBy(0, -8);
      if (e.clientY > window.innerHeight - 100) window.scrollBy(0, 8);
    });
    const end = () => {
      if (!dragging) return;
      const list = dragging.parentElement;
      dragging.classList.remove('dragging');
      dragging = null;
      persist(list);
    };
    ul.addEventListener('pointerup', end);
    ul.addEventListener('pointercancel', end);
    swipeRows(ul, byId, () => $$(':scope > li > .q-num', ul).forEach((el, i) => (el.textContent = i + 1)));

    $$('[data-toggle]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.toggle;
        const sub = b.closest('li').querySelector(':scope > .q-sub');
        sub.hidden = !sub.hidden;
        if (sub.hidden) open.delete(id);
        else open.add(id);
        b.setAttribute('aria-expanded', String(!sub.hidden));
        b.textContent = b.textContent.replace(/^[▸▾]/, sub.hidden ? '▸' : '▾');
        try {
          localStorage.setItem('paperreads.queue-open', JSON.stringify([...open]));
        } catch {}
      })
    );
    $$('[data-top]').forEach((b) =>
      b.addEventListener('click', async () => {
        ul.prepend(b.closest('li'));
        await persist(ul);
      })
    );
    $$('[data-start]').forEach((b) =>
      b.addEventListener('click', async () => {
        const p = await DB.get('papers', b.dataset.start);
        await setStatus(p, 'reading');
        toast('Started reading');
        route();
      })
    );
  }


  // Swipe a queue row: right archives (off the reading list, kept as
  // Catalogued), left deletes. Both can be undone from the toast; a delete
  // only happens once the undo has passed.
  const pendingDeletes = new Map(); // id → timer
  async function finishDelete(id) {
    clearTimeout(pendingDeletes.get(id));
    pendingDeletes.delete(id);
    await deletePaper(id);
    if (/^#\/queue/.test(location.hash)) route();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') for (const id of [...pendingDeletes.keys()]) finishDelete(id);
  });

  function swipeRows(ul, byId, renumber) {
    let s = null;
    const rowOf = (target) => target.closest('.q-row') || target.closest('#queue > li');
    ul.addEventListener('dragstart', (e) => e.preventDefault()); // a link's own drag would cancel the swipe
    ul.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || e.target.closest('.handle, button, .q-toggle')) return;
      const el = rowOf(e.target);
      if (!el) return;
      s = { el, li: el.closest('li'), x: e.clientX, y: e.clientY, dx: 0, on: false, id: el.closest('li').dataset.id };
    });
    ul.addEventListener('pointermove', (e) => {
      if (!s) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (!s.on) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) return (s = null); // scrolling
        if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        s.on = true;
        try {
          ul.setPointerCapture(e.pointerId);
        } catch {}
        const list = s.el.offsetParent;
        s.bg = document.createElement('div');
        s.bg.className = 'swipe-bg';
        s.bg.style.top = `${s.el.offsetTop}px`;
        s.bg.style.height = `${s.el.offsetHeight}px`;
        s.bg.innerHTML = '<span>📥 Archive</span><span>Delete 🗑</span>';
        (list || ul).appendChild(s.bg);
        s.el.classList.add('swiping');
      }
      s.dx = dx;
      s.el.style.transform = `translateX(${dx}px)`;
      s.bg.classList.toggle('archive', dx > 0);
      s.bg.classList.toggle('delete', dx < 0);
      e.preventDefault();
    });
    const done = async () => {
      if (!s) return;
      const { el, li, dx, on, id, bg } = s;
      s = null;
      if (!on) return;
      // the tap that ends a swipe isn't a click on the link
      const eat = (ev) => (ev.preventDefault(), ev.stopPropagation());
      ul.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => ul.removeEventListener('click', eat, true), 400);
      const w = el.offsetWidth;
      if (Math.abs(dx) < Math.max(90, w * 0.35)) {
        el.style.transition = 'transform .18s';
        el.style.transform = '';
        setTimeout(() => {
          el.classList.remove('swiping');
          el.style.transition = '';
          bg.remove();
        }, 200);
        return;
      }
      el.style.transition = 'transform .18s';
      el.style.transform = `translateX(${dx > 0 ? w : -w}px)`;
      await new Promise((r) => setTimeout(r, 180));
      bg.remove();
      const p = byId.get(id);
      const parent = li.parentElement;
      const next = li.nextSibling;
      li.remove();
      renumber();
      const putBack = () => {
        el.classList.remove('swiping');
        el.style.transition = '';
        el.style.transform = '';
        parent.insertBefore(li, next);
        renumber();
      };
      if (dx > 0) {
        const before = { ...p };
        await setStatus(p, 'none');
        toast('Archived (now Catalogued)', {
          label: 'Undo',
          run: async () => {
            await savePaper(before);
            Object.assign(p, before);
            if (/^#\/queue/.test(location.hash)) putBack();
          },
        });
      } else {
        pendingDeletes.set(id, setTimeout(() => finishDelete(id), 6500));
        toast('Deleted (kept in Recently deleted)', {
          label: 'Undo',
          run: () => {
            clearTimeout(pendingDeletes.get(id));
            pendingDeletes.delete(id);
            if (/^#\/queue/.test(location.hash)) putBack();
          },
        });
      }
    };
    ul.addEventListener('pointerup', done);
    ul.addEventListener('pointercancel', done);
  }

  async function viewPaper(id) {
    const p = await DB.get('papers', id);
    if (!p) {
      main.innerHTML = '<p class="empty">Paper not found.</p>';
      return;
    }
    setTitle('Paper');
    const [cols, highlights, linksFrom, linksTo, pdf, epub, log, all, tagCounts, friendsOn] = await Promise.all([
      DB.all('collections'),
      DB.byIndex('highlights', 'paperId', id),
      DB.byIndex('links', 'fromId', id),
      DB.byIndex('links', 'toId', id),
      DB.get('pdfs', id),
      DB.get('epubs', id),
      DB.byIndex('progress', 'paperId', id),
      papers(),
      allTags(),
      Social.config(),
    ]);
    const byId = Object.fromEntries(all.map((x) => [x.id, x]));
    const related = [
      ...linksFrom.map((l) => ({ l, other: byId[l.toId], label: LINK_TYPES[l.type] })),
      ...linksTo.map((l) => ({ l, other: byId[l.fromId], label: LINK_INVERSE[l.type] })),
    ].filter((r) => r.other);
    const trail = trailOf(all);
    const trailAnc = trail.ancestors(p);
    const trailKids = trail.kids.get(id) || [];
    const trailDesc = trail.descendants(id); // can't be found via its own descendants
    const isPct = !p.totalPages;
    const format = p.format || (epub && !pdf ? 'epub' : 'pdf');
    const epubSources = Epubify.sources(p, !!pdf);

    main.innerHTML = `
      <article class="paper">
        <h2 class="p-title">${esc(p.title)}</h2>
        <p class="p-authors">${esc((p.authors || []).join(', ') || 'Unknown authors')}</p>
        <p class="muted">${[p.year, esc(p.venue)].filter(Boolean).join(' · ')}</p>
        <p class="ids">
          ${p.doi ? `<a href="https://doi.org/${esc(p.doi)}" target="_blank" rel="noopener">DOI: ${esc(p.doi)}</a>` : ''}
          ${p.arxiv ? `<a href="https://arxiv.org/abs/${esc(p.arxiv)}" target="_blank" rel="noopener">arXiv: ${esc(p.arxiv)}</a>` : ''}
          ${p.url && !p.arxiv ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Link</a>` : ''}
        </p>

        <section class="card files">
          <div class="row between">
            <h3>Read</h3>
            <div class="seg seg-2" role="group" aria-label="Format">
              <button type="button" data-format="pdf" class="${format === 'pdf' ? 'on' : ''}">PDF${pdf ? ' ✓' : ''}</button>
              <button type="button" data-format="epub" class="${format === 'epub' ? 'on' : ''}">EPUB${epub ? ' ✓' : ''}</button>
            </div>
          </div>
          ${format === 'pdf'
            ? pdf
              ? `<p class="muted small">${esc(pdf.name)} · ${(pdf.size / 1048576).toFixed(1)} MB, stored on this phone</p>
                <div class="row wrap"><button class="btn primary" id="pdf-open">Open PDF</button><button class="btn" id="pdf-share">Open with…</button><button class="btn danger-ghost" id="pdf-del">Remove</button></div>`
              : `<p class="muted small">No PDF stored.</p><div class="row wrap">
                  <label class="btn">Attach PDF<input type="file" accept="application/pdf" id="pdf-file" hidden></label>
                  ${p.arxiv ? '<button class="btn" id="pdf-arxiv">Download from arXiv</button>' : ''}
                  ${p.pdfUrl ? `<button class="btn" id="pdf-link">Download from the link</button>` : ''}
                </div>
                ${p.pdfUrl ? `<p class="muted small">This paper was added from <a href="${esc(p.pdfUrl)}" target="_blank" rel="noopener">a PDF link</a>. If the site won’t let the app download it, open the link, download the PDF in your browser, then tap Attach PDF and pick it from Downloads.</p>` : ''}`
            : epub
              ? `<div class="epub-info">${epub.cover ? '<img class="cover-thumb" id="cover-thumb" alt="">' : ''}<div>
                  <p class="muted small">${esc(epub.name)} · ${Math.max(1, Math.round(epub.size / 1024))} KB · from ${esc(epub.source)}</p>
                  ${epub.missingFigures ? `<p class="small note">${epub.missingFigures} figure${epub.missingFigures > 1 ? 's show' : ' shows'} only a caption: the site doesn’t let apps download the images. ${pdf ? 'Tap <b>Remake</b> and choose <b>Stored PDF</b> to take the figures from the PDF.' : 'Attach the PDF (download it in your browser first), then tap <b>Remake</b> and choose <b>Stored PDF</b>.'}</p>` : ''}
                  <div class="row wrap"><a class="btn primary" href="#/read/${p.id}">Read EPUB</a><button class="btn" id="epub-share">Open with…</button></div>
                  <div class="row wrap"><button class="btn small" id="epub-remake">Remake</button><button class="btn small danger-ghost" id="epub-del">Remove</button></div>
                </div></div>`
              : ''}
          ${format === 'epub' ? `<form id="epub-make" class="stack"${epub ? ' hidden' : ''}>
              ${epubSources.length ? `<label>Make an EPUB from
                <select name="source">${epubSources.map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
                <button class="btn primary">Make EPUB</button>` : '<p class="muted small">Add an arXiv ID or DOI, or attach the PDF, to make an EPUB.</p>'}
              <label class="btn">Import .epub<input type="file" accept=".epub,application/epub+zip" id="epub-file" hidden></label>
            </form>
            <pre class="conv-log" id="conv-log" hidden></pre>` : ''}
        </section>

        <section class="card" id="concerns-card"></section>
        <section class="card" id="ask-card"></section>

        <div class="seg" role="group" aria-label="Status">
          ${['want', 'reading', 'read', 'none'].map((s) => `<button type="button" data-status="${s}" class="${p.status === s ? 'on' : ''}">${STATUS[s]}</button>`).join('')}
        </div>

        <section class="card">
          <div class="row between"><h3>Progress</h3><span class="muted">${progressLabel(p)} · ${Math.round(pct(p) * 100)}%</span></div>
          ${progressBar(p)}
          <form id="prog" class="row prog-form">
            <label>${isPct ? 'Percent' : 'Page'} <input type="number" name="v" inputmode="numeric" min="0" max="${isPct ? 100 : p.totalPages}" value="${isPct ? Math.round(p.percent || 0) : p.currentPage || 0}"></label>
            <label>of <input type="number" name="total" inputmode="numeric" min="1" placeholder="pages" value="${p.totalPages || ''}"></label>
            <button class="btn primary">Save</button>
          </form>
          <p class="muted small">${p.startedAt ? `Started ${fmtDate(p.startedAt)}` : ''}${p.finishedAt ? ` · Finished ${fmtDate(p.finishedAt)}` : ''} · Added ${fmtDate(p.addedAt)}</p>
          ${log.length ? `<details><summary>Reading log (${log.length})</summary><ul class="log">${log
            .sort((a, b) => b.ts - a.ts)
            .map((e) => `<li>${e.date}: ${p.totalPages ? `page ${e.page}${e.delta ? ` (${e.delta > 0 ? '+' : ''}${e.delta})` : ''}` : `${Math.round(e.percent)}%`}</li>`)
            .join('')}</ul></details>` : ''}
          ${p.status === 'read' ? `<label class="small">Finished on <input type="date" id="finished" value="${p.finishedAt ? localDate(new Date(p.finishedAt)) : ''}"></label>` : ''}
        </section>

        <section class="card">
          <h3>Rating</h3>
          ${stars(p.rating, true)}
          ${friendsOn ? `<label class="check small"><input type="checkbox" id="p-private"${p.private ? ' checked' : ''}> Keep private: friends don’t see this paper</label>` : ''}
        </section>

        <section class="card">
          <h3>Tags</h3>
          <div class="tags">${(p.tags || []).map((t) => `<span class="tag removable">#${esc(t)} <button type="button" data-untag="${esc(t)}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join('')}</div>
          <form id="tag-form" class="row"><input name="t" list="tag-list" placeholder="Add tag" autocomplete="off"><datalist id="tag-list">${Object.keys(tagCounts).map((t) => `<option value="${esc(t)}">`).join('')}</datalist><button class="btn">Add</button></form>
          <h3>Collections</h3>
          ${cols.length ? `<div class="checks">${cols
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => `<label class="check"><input type="checkbox" data-col="${c.id}"${(p.collections || []).includes(c.id) ? ' checked' : ''}> ${esc(c.name)}</label>`)
            .join('')}</div>` : '<p class="muted small">No collections yet.</p>'}
          <a href="#/collections" class="link small">Manage collections</a>
        </section>

        <section class="card">
          <h3>Notes / review</h3>
          <textarea id="notes" rows="5" placeholder="Your thoughts, summary, review…">${esc(p.notes || '')}</textarea>
          <p class="muted small" id="notes-status"></p>
        </section>

        <section class="card">
          <h3>Highlights</h3>
          <ul class="highlights">${highlights
            .sort((a, b) => (a.page || 0) - (b.page || 0))
            .map((h) => `<li><blockquote>${esc(h.quote)}</blockquote>${h.page ? `<span class="muted small">${h.cfi ? '≈ ' : ''}p. ${h.page}</span>` : ''}${h.note ? `<p class="small">${esc(h.note)}</p>` : ''}<div class="row">${h.cfi && epub ? `<a class="btn small" href="#/read/${p.id}?cfi=${encodeURIComponent(h.cfi)}">Show in reader</a>` : ''}<button class="btn small danger-ghost" data-delh="${h.id}">Delete</button></div></li>`)
            .join('') || '<li class="muted small">No highlights yet.</li>'}</ul>
          <details><summary>Add highlight</summary>
            <form id="hl-form" class="stack">
              <textarea name="quote" rows="3" placeholder="Quote" required></textarea>
              <input name="page" type="number" inputmode="numeric" placeholder="Page">
              <input name="note" placeholder="Your note (optional)">
              <button class="btn primary">Save highlight</button>
            </form>
          </details>
        </section>

        <section class="card" id="trail-card">
          <h3>Discovery trail</h3>
          ${trailAnc.length ? `<p class="small">Found via ${trailAnc.map((a) => `<a href="#/paper/${a.id}">${esc(a.title)}</a>`).join(' › ')}</p>` : '<p class="muted small">Not found through another paper.</p>'}
          ${trailKids.length ? `<p class="small muted">Led to ${trailKids.length} paper${trailKids.length > 1 ? 's' : ''}:</p><ul class="trail">${trailKids.map((k) => trailTree(k, trail.kids, id)).join('')}</ul>` : ''}
          <div class="row wrap"><a class="btn small primary" href="#/add?via=${id}">＋ Add a paper found here</a>${trailAnc.length || trailKids.length ? `<a class="btn small" href="#/trail/${trail.rootOf(p).id}">Whole trail</a>` : ''}</div>
          <details><summary>${p.foundVia ? 'Change' : 'Set'} where you found it</summary>
            <form id="via-form" class="stack">
              <input name="filter" placeholder="Filter your library" autocomplete="off">
              <select name="target" size="5">${all.filter((x) => x.id !== id && !trailDesc.has(x.id)).sort((a, b) => a.title.localeCompare(b.title)).map((x) => `<option value="${x.id}"${x.id === p.foundVia ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}</select>
              <div class="row"><button class="btn primary">Save</button>${p.foundVia ? '<button type="button" class="btn danger-ghost" id="via-clear">Not found via a paper</button>' : ''}</div>
            </form>
          </details>
        </section>

        <section class="card">
          <h3>Related papers</h3>
          <ul class="list compact">${related
            .map((r) => `<li class="paper-row"><a href="#/paper/${r.other.id}" class="paper-link"><span class="muted small">${r.label}</span><span class="pr-title">${esc(r.other.title)}</span></a><button class="btn small danger-ghost" data-unlink="${r.l.id}" aria-label="Remove link">×</button></li>`)
            .join('') || '<li class="muted small">No linked papers.</li>'}</ul>
          <details><summary>Link a paper</summary>
            <form id="link-form" class="stack">
              <select name="type">${Object.entries(LINK_TYPES).map(([k, v]) => `<option value="${k}">This paper ${v.toLowerCase()}…</option>`).join('')}</select>
              <input name="filter" placeholder="Filter your library" autocomplete="off">
              <select name="target" size="5" required>${all.filter((x) => x.id !== id).sort((a, b) => a.title.localeCompare(b.title)).map((x) => `<option value="${x.id}">${esc(x.title)}</option>`).join('')}</select>
              <button class="btn primary">Link</button>
            </form>
          </details>
        </section>

        ${p.abstract ? `<section class="card"><details><summary><h3 class="inline">Abstract</h3></summary><p class="abstract">${esc(p.abstract)}</p></details></section>` : ''}

        <div class="row between actions">
          <a class="btn" href="#/edit/${p.id}">Edit details</a>
          <button class="btn danger" id="delete">Delete</button>
        </div>
      </article>`;

    const rerender = () => viewPaper(id);

    $('#p-private')?.addEventListener('change', async (e) => {
      p.private = e.target.checked || undefined;
      if (!p.private) delete p.private;
      await savePaper(p);
      toast(e.target.checked ? 'Hidden from friends' : 'Friends can see this paper');
    });

    $$('[data-status]').forEach((b) =>
      b.addEventListener('click', async () => {
        await setStatus(p, b.dataset.status);
        toast(`Marked “${STATUS[p.status]}”`);
        rerender();
      })
    );

    $('#prog').addEventListener('submit', async (e) => {
      e.preventDefault();
      const total = parseInt(e.target.total.value, 10) || null;
      if (total !== (p.totalPages || null)) {
        // Switching from percent to pages: carry the percentage over.
        if (total && !p.totalPages && p.percent) p.currentPage = Math.round((p.percent / 100) * total);
        p.totalPages = total;
        await savePaper(p);
        return rerender();
      }
      const atEnd = await logProgress(p, Number(e.target.v.value), !p.totalPages);
      if (atEnd) offerFinish(p, rerender);
      else toast('Progress saved');
      rerender();
    });

    const finishedInput = $('#finished');
    if (finishedInput)
      finishedInput.addEventListener('change', async () => {
        if (!finishedInput.value) return;
        const [y, m, d] = finishedInput.value.split('-').map(Number);
        p.finishedAt = new Date(y, m - 1, d, 12).getTime();
        await savePaper(p);
        toast('Finish date updated');
      });

    $$('[data-rate]').forEach((b) =>
      b.addEventListener('click', async () => {
        const r = Number(b.dataset.rate);
        p.rating = p.rating === r ? 0 : r;
        await savePaper(p);
        rerender();
      })
    );

    const paperConcerns = concernsUI($('#concerns-card'), id);
    askUI($('#ask-card'), id, { addConcern: (c) => paperConcerns.add(c) });

    // Files: PDF / EPUB
    $$('[data-format]').forEach((b) =>
      b.addEventListener('click', async () => {
        p.format = b.dataset.format;
        await savePaper(p);
        rerender();
      })
    );
    if (epub && format === 'epub') {
      const thumb = $('#cover-thumb');
      if (thumb && epub.cover) {
        thumb.src = URL.createObjectURL(epub.cover);
        thumb.onload = () => URL.revokeObjectURL(thumb.src);
      }
      $('#epub-share').addEventListener('click', () => shareOrSave(new File([epub.blob], epub.name, { type: 'application/epub+zip' }), p.title));
      $('#epub-remake').addEventListener('click', () => {
        $('#epub-make').hidden = false;
        $('#epub-remake').hidden = true;
      });
      $('#epub-del').addEventListener('click', async () => {
        if (!confirm('Remove the stored EPUB?')) return;
        await DB.del('epubs', id);
        p.hasEpub = false;
        p.epubCfi = null;
        await savePaper(p);
        rerender();
      });
    }
    const epubFile = $('#epub-file');
    if (epubFile)
      epubFile.addEventListener('change', async () => {
        const f = epubFile.files[0];
        if (!f) return;
        if (!isEpub(f)) return toast('That is not an .epub file');
        await attachEpub(id, f, { source: 'Imported' });
        toast('EPUB saved on this phone');
        rerender();
      });
    const makeForm = $('#epub-make');
    if (makeForm && makeForm.source)
      makeForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('button', makeForm);
        const out = $('#conv-log');
        btn.disabled = true;
        btn.textContent = 'Converting…';
        out.hidden = false;
        out.textContent = '';
        const log = (m) => {
          out.textContent += m + '\n';
          out.scrollTop = out.scrollHeight;
        };
        try {
          const res = await Epubify.make(p, { source: makeForm.source.value, pdf: pdf ? { blob: pdf.blob, name: pdf.name } : null, log });
          await attachEpub(id, res.file, { cover: res.cover, source: res.source, missingFigures: res.missingFigures });
          if (res.warnings.length) alert(res.warnings.join('\n\n'));
          toast('EPUB ready');
          if (location.hash === `#/paper/${id}`) rerender();
        } catch (err) {
          log('✗ ' + (navigator.onLine || makeForm.source.value === 'pdf' ? err.message : 'You are offline. Only the PDF route works offline.'));
          btn.disabled = false;
          btn.textContent = 'Make EPUB';
        }
      });

    // PDF
    const pdfFile = $('#pdf-file');
    if (pdfFile)
      pdfFile.addEventListener('change', async () => {
        if (!pdfFile.files[0]) return;
        await attachPdf(id, pdfFile.files[0]);
        toast('PDF saved on this phone');
        rerender();
      });
    const pdfArxiv = $('#pdf-arxiv');
    if (pdfArxiv)
      pdfArxiv.addEventListener('click', async () => {
        pdfArxiv.disabled = true;
        pdfArxiv.textContent = 'Downloading…';
        try {
          await attachPdf(id, await Lookup.fetchArxivPdf(p.arxiv));
          toast('PDF saved on this phone');
        } catch (err) {
          toast(navigator.onLine ? err.message : 'You are offline');
        }
        rerender();
      });
    const pdfLinkBtn = $('#pdf-link');
    if (pdfLinkBtn)
      pdfLinkBtn.addEventListener('click', async () => {
        pdfLinkBtn.disabled = true;
        pdfLinkBtn.textContent = 'Downloading…';
        try {
          await attachPdf(id, await Lookup.fetchPdf(p.pdfUrl));
          toast('PDF saved on this phone');
        } catch (err) {
          toast(navigator.onLine ? `Couldn’t download it: ${err.message}` : 'You are offline');
        }
        rerender();
      });
    if (pdf && format === 'pdf') {
      const file = new File([pdf.blob], pdf.name, { type: 'application/pdf' });
      $('#pdf-open').addEventListener('click', () => {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        // Android Chrome has no inline PDF viewer; a download hands it to the system viewer.
        if (/Android/i.test(navigator.userAgent)) a.download = pdf.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      });
      $('#pdf-share').addEventListener('click', async () => {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: p.title });
          } catch {}
        } else toast('Sharing files is not supported here');
      });
      $('#pdf-del').addEventListener('click', async () => {
        if (!confirm('Remove the stored PDF?')) return;
        await DB.del('pdfs', id);
        p.hasPdf = false;
        await savePaper(p);
        rerender();
      });
    }

    // Tags & collections
    $('#tag-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const tags = e.target.t.value.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
      if (!tags.length) return;
      p.tags = [...new Set([...(p.tags || []), ...tags])];
      await savePaper(p);
      rerender();
    });
    $$('[data-untag]').forEach((b) =>
      b.addEventListener('click', async () => {
        p.tags = (p.tags || []).filter((t) => t !== b.dataset.untag);
        await savePaper(p);
        rerender();
      })
    );
    $$('[data-col]').forEach((c) =>
      c.addEventListener('change', async () => {
        const set = new Set(p.collections || []);
        c.checked ? set.add(c.dataset.col) : set.delete(c.dataset.col);
        p.collections = [...set];
        await savePaper(p);
      })
    );

    // Notes autosave
    const notes = $('#notes');
    let notesTimer;
    notes.addEventListener('input', () => {
      clearTimeout(notesTimer);
      $('#notes-status').textContent = 'Editing…';
      notesTimer = setTimeout(async () => {
        p.notes = notes.value;
        await savePaper(p);
        $('#notes-status').textContent = 'Saved';
      }, 600);
    });

    // Highlights
    $('#hl-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      await DB.put('highlights', { paperId: id, quote: f.quote.value.trim(), page: parseInt(f.page.value, 10) || null, note: f.note.value.trim(), createdAt: now() });
      rerender();
    });
    $$('[data-delh]').forEach((b) =>
      b.addEventListener('click', async () => {
        await DB.del('highlights', Number(b.dataset.delh));
        rerender();
      })
    );

    // Discovery trail
    const vf = $('#via-form');
    vf.filter.addEventListener('input', () => {
      const t = vf.filter.value.toLowerCase();
      $$('option', vf.target).forEach((o) => (o.hidden = !o.textContent.toLowerCase().includes(t)));
    });
    vf.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!vf.target.value) return;
      const fresh = await DB.get('papers', id);
      fresh.foundVia = vf.target.value;
      await savePaper(fresh);
      rerender();
    });
    $('#via-clear')?.addEventListener('click', async () => {
      const fresh = await DB.get('papers', id);
      fresh.foundVia = null;
      await savePaper(fresh);
      rerender();
    });

    // Related links
    const lf = $('#link-form');
    lf.filter.addEventListener('input', () => {
      const t = lf.filter.value.toLowerCase();
      $$('option', lf.target).forEach((o) => (o.hidden = !o.textContent.toLowerCase().includes(t)));
    });
    lf.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!lf.target.value) return;
      await DB.put('links', { fromId: id, toId: lf.target.value, type: lf.type.value, createdAt: now() });
      rerender();
    });
    $$('[data-unlink]').forEach((b) =>
      b.addEventListener('click', async () => {
        await DB.del('links', Number(b.dataset.unlink));
        rerender();
      })
    );

    $('#delete').addEventListener('click', async () => {
      if (!confirm(`Delete “${p.title}” and its notes, highlights and PDF?`)) return;
      await deletePaper(id);
      toast('Deleted');
      location.hash = '#/library';
    });
  }

  async function viewEdit(id, q) {
    const existing = id ? await DB.get('papers', id) : null;
    setTitle(existing ? 'Edit paper' : 'Add paper');
    const cols = await DB.all('collections');
    let inbox = null;
    if (q.inbox) inbox = await DB.get('inbox', Number(q.inbox));
    const shared = [q.url, q.text, q.title, inbox && inbox.url, inbox && inbox.text].filter(Boolean).join(' ');
    const p = existing || { status: 'want', authors: [], tags: [], collections: [] };
    const sharedTitle = (inbox && inbox.title) || q.title || '';
    const via = !existing && q.via ? await DB.get('papers', q.via) : null; // found through this paper

    main.innerHTML = `
      ${existing ? '' : `<section class="card">
        <form id="lookup" class="stack">
          <label>DOI, arXiv ID, link or title
            <input name="q" placeholder="e.g. 10.1038/nature14539 or arxiv.org/abs/1706.03762" value="${esc(shared || '')}" autocomplete="off">
          </label>
          <div class="row"><button class="btn primary">Look up</button><label class="btn">Open a file…<input type="file" id="add-file" accept=".pdf,.epub,.mhtml,.mht,.html,.htm,application/pdf,application/epub+zip,multipart/related,text/html" hidden></label></div>
          <p class="muted small" id="lookup-status">${inbox && inbox.file ? `Shared ${fileKind(inbox.file)}: ${esc(inbox.file.name)}. ${isWebFile(inbox.file) ? 'It will be made into an EPUB' : 'It will be attached'} when you save.` : 'Fills in the details automatically (needs internet).'}</p>
          <ul class="list compact" id="results"></ul>
        </form>
      </section>`}
      <form id="edit" class="stack card">
        ${via ? `<p class="via-chip small" id="via-chip">↳ Found via <b>${esc(via.title)}</b> <button type="button" class="r-btn" id="via-drop" aria-label="Not found via this paper">✕</button></p>` : ''}
        <div class="note small stack" id="dupe" hidden></div>
        <label>Title <input name="title" required value="${esc(p.title || Lookup.cleanTitle(sharedTitle))}"></label>
        <label>Authors <small class="muted">(one per line)</small><textarea name="authors" rows="3">${esc((p.authors || []).join('\n'))}</textarea></label>
        <div class="row">
          <label>Year <input name="year" type="number" inputmode="numeric" value="${esc(p.year || '')}"></label>
          <label>Pages <input name="totalPages" type="number" inputmode="numeric" min="1" value="${esc(p.totalPages || '')}"></label>
        </div>
        <label>Venue / journal <input name="venue" value="${esc(p.venue || '')}"></label>
        <label>DOI <input name="doi" value="${esc(p.doi || '')}"></label>
        <label>arXiv ID <input name="arxiv" value="${esc(p.arxiv || '')}"></label>
        <label>URL <input name="url" type="url" value="${esc(p.url || '')}"></label>
        <label>Abstract <textarea name="abstract" rows="4">${esc(p.abstract || '')}</textarea></label>
        ${existing ? '' : `<label>Shelf <select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${p.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Tags <small class="muted">(comma separated)</small><input name="tags" value="${esc((p.tags || []).join(', '))}"></label>
        ${cols.length ? `<fieldset><legend>Collections</legend><div class="checks">${cols.map((c) => `<label class="check"><input type="checkbox" name="col" value="${c.id}"> ${esc(c.name)}</label>`).join('')}</div></fieldset>` : ''}
        ${!(inbox && inbox.file) ? `<label class="check" id="getpdf-row"><input type="checkbox" name="getpdf" checked> Save the PDF for offline reading (from arXiv or a PDF link)</label>` : ''}
        ${!(inbox && inbox.file && isEpub(inbox.file)) ? `<label class="check"><input type="checkbox" name="getepub" checked> Make an EPUB for reading in the app</label>` : ''}`}
        <div class="row end"><a class="btn" href="${existing ? `#/paper/${p.id}` : via && q.back === 'read' ? `#/read/${via.id}` : '#/'}">Cancel</a><button class="btn primary">${existing ? 'Save' : 'Add paper'}</button></div>
      </form>`;

    // A file picked here goes through the same path as a shared one.
    $('#add-file')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const id = await DB.put('inbox', { title: '', text: '', url: '', file, receivedAt: now() });
      location.hash = `#/add?inbox=${id}`;
    });

    let viaPaper = via;
    $('#via-drop')?.addEventListener('click', () => {
      viaPaper = null;
      $('#via-chip').remove();
    });

    const form = $('#edit');
    const fill = (meta) => {
      for (const k of ['title', 'year', 'venue', 'doi', 'arxiv', 'url', 'abstract', 'totalPages']) if (meta[k]) form[k].value = meta[k];
      if (meta.authors && meta.authors.length) form.authors.value = meta.authors.join('\n');
      checkDupe();
    };
    const checkDupe = async () => {
      const squash = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      const doi = form.doi.value.trim().toLowerCase();
      const ax = form.arxiv.value.trim().toLowerCase().replace(/v\d+$/, '');
      const title = squash(form.title.value);
      const dupe = (await papers()).find(
        (x) =>
          x.id !== p.id &&
          ((doi && (x.doi || '').toLowerCase() === doi) || (ax && (x.arxiv || '').toLowerCase().replace(/v\d+$/, '') === ax) || (title.length > 10 && squash(x.title) === title))
      );
      const el = $('#dupe');
      el.hidden = !dupe;
      if (!dupe || existing) return;
      // A file that came with this share (or was downloaded from its link)
      // can go straight onto the paper that's already here.
      const file = inbox && inbox.file ? inbox.file : typeof pendingPdf !== 'undefined' ? pendingPdf : null;
      const kind = file ? fileKind(file) : pendingPage ? 'web page' : null;
      const has = kind === 'PDF' ? dupe.hasPdf : dupe.hasEpub;
      const label = kind === 'web page' ? (has ? 'Remake its EPUB from this page' : 'Make its EPUB from this page') : has ? `Replace its ${kind} with this one` : `Add this ${kind} to it`;
      el.innerHTML = `<span>⚠️ Already in your library: <a href="#/paper/${dupe.id}">${esc(dupe.title)}</a></span>${kind ? `<button type="button" class="btn small primary" id="dupe-attach">${label}</button>` : ''}${
        viaPaper && dupe.id !== viaPaper.id && !trailOf(await papers()).descendants(dupe.id).has(viaPaper.id) && dupe.foundVia !== viaPaper.id ? `<button type="button" class="btn small" id="dupe-via">Mark it as found via “${esc(viaPaper.title.length > 50 ? viaPaper.title.slice(0, 50) + '…' : viaPaper.title)}”</button>` : ''
      }`;
      $('#dupe-via')?.addEventListener('click', async () => {
        const d = await DB.get('papers', dupe.id);
        d.foundVia = viaPaper.id;
        await savePaper(d);
        if (q.cites) await DB.put('links', { fromId: viaPaper.id, toId: d.id, type: 'cites', createdAt: now() });
        toast('Added to the trail');
        location.hash = q.back === 'read' ? `#/read/${viaPaper.id}` : `#/paper/${viaPaper.id}`;
      });
      const btn = $('#dupe-attach');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        if (kind === 'web page') {
          btn.textContent = 'Making the EPUB…';
          try {
            await makeWebEpub(dupe.id, pendingPage);
          } catch (err) {
            btn.disabled = false;
            return toast(err.message);
          }
          if (inbox) await DB.del('inbox', inbox.id);
          toast('EPUB ready to read');
          location.hash = `#/paper/${dupe.id}`;
          return;
        }
        if (kind === 'EPUB') await attachEpub(dupe.id, file, { source: 'Shared file' });
        else await attachPdf(dupe.id, file);
        if (inbox) await DB.del('inbox', inbox.id);
        toast(`${kind} added to the paper`);
        location.hash = `#/paper/${dupe.id}`;
        // Its EPUB lacked figure images? The PDF has them: rebuild in the background.
        const ep = kind === 'PDF' && (await DB.get('epubs', dupe.id));
        if (ep && ep.missingFigures) {
          toast('Remaking the EPUB with the figures from the PDF…');
          makeEpubFor(dupe.id)
            .then((res) => {
              toast(res.missingFigures ? 'EPUB remade, but some figures are still missing' : 'EPUB remade with figures');
              if (location.hash === `#/paper/${dupe.id}`) route();
            })
            .catch(() => toast('Couldn’t remake the EPUB. Try Remake on the paper page'));
        }
      });
    };
    form.doi.addEventListener('change', checkDupe);
    form.title.addEventListener('change', checkDupe);

    let pendingPage = null; // a web page (fetched, or a shared saved page) to make the EPUB from
    let pdfLink = null; // shared link that points at a PDF
    let pendingPdf = null; // that PDF, if already downloaded during lookup
    let pdfError = null;
    const lookup = $('#lookup');
    if (lookup) {
      const status = $('#lookup-status');
      const pick = async (r) => {
        status.textContent = 'Fetching details…';
        try {
          fill({ ...(await Lookup.byDoi(r.doi)), url: form.url.value || null });
        } catch {
          fill(r);
        }
      };
      const showList = (list) => {
        $('#results').innerHTML = list
          .map((r, i) => `<li class="paper-row"><button type="button" class="paper-link plain" data-i="${i}"><span class="pr-title">${esc(r.title)}</span><span class="pr-meta">${esc(authorsShort(r.authors))}${r.year ? ` · ${r.year}` : ''}${r.venue ? ` · ${esc(r.venue)}` : ''}${r.notice ? ' · correction notice' : ''}</span></button></li>`)
          .join('');
        $$('#results [data-i]').forEach((btn) =>
          btn.addEventListener('click', async () => {
            $('#results').innerHTML = '';
            await pick(list[btn.dataset.i]);
            status.textContent = 'Check the details and save.';
          })
        );
      };
      // Title search; true when an exact match was filled in.
      const searchTitle = async (title) => {
        const results = await Lookup.search(title);
        if (!results.length) return false;
        if (results[0].confident) {
          // an exact title match: fill it in, but keep the alternatives a tap away
          await pick(results[0]);
          status.textContent = results.length > 1 ? 'Matched by title. Not the right paper? Pick another:' : 'Matched by title. Check the details and save.';
          showList(results.slice(1));
          return true;
        }
        if (!form.title.value) form.title.value = title;
        status.textContent = 'Pick the matching paper:';
        showList(results);
        return true;
      };
      // A web page: a paper's landing page names its DOI; anything else
      // (blog post, article) is saved as itself.
      const usePage = async (page, how) => {
        const meta = Epubify.pageMeta(page);
        if (meta.doi && navigator.onLine) {
          try {
            const { meta: m } = await Lookup.resolve(meta.doi);
            if (m) {
              fill({ ...m, url: m.url || meta.url });
              status.textContent = 'Found the paper this page is about. Check the details and save.';
              if (how === 'Saved web page') pendingPage = page; // a fetched landing page is just a pointer
              return true;
            }
          } catch {}
        }
        if (!meta.title) return false;
        pendingPage = page;
        fill({ ...meta, doi: meta.doi || '' });
        if ($('#getpdf-row')) $('#getpdf-row').hidden = true;
        status.textContent = `${how}. It’ll be saved as an EPUB. Check the details and save.`;
        return true;
      };
      // Work out which paper a PDF is from its contents.
      const identifyFromPdf = async (file) => {
        status.textContent = 'Reading the PDF to find out which paper it is…';
        let info;
        try {
          info = await Lookup.identifyPdf(file);
        } catch {
          return false;
        }
        if (info.doi || info.arxiv) {
          try {
            const { meta } = await Lookup.resolve(info.doi || `arXiv:${info.arxiv}`);
            if (meta) {
              fill(meta);
              status.textContent = 'Found it from the PDF. Check the details and save.';
              return true;
            }
          } catch {}
        }
        if (info.title) {
          if (navigator.onLine && (await searchTitle(info.title).catch(() => false))) return true;
          form.title.value = form.title.value || info.title;
          status.textContent = 'Took the title from the PDF. Fill in the rest, or edit it later.';
          return true;
        }
        return false;
      };

      const run = async () => {
        const input = lookup.q.value.trim();
        if (!input) return;
        $('#results').innerHTML = '';
        pendingPdf = null;
        pdfError = null;
        const ids0 = Lookup.parse(input);
        pdfLink = ids0.url && Lookup.isPdfUrl(ids0.url) ? ids0.url : null;
        if (!navigator.onLine) {
          status.textContent = 'Offline: fill in the details by hand. You can edit them later.';
          fill({ doi: ids0.doi, arxiv: ids0.arxiv, url: ids0.url || (ids0.arxiv ? `https://arxiv.org/abs/${ids0.arxiv}` : '') });
          return;
        }
        status.textContent = 'Looking up…';
        try {
          const { meta, ids } = await Lookup.resolve(input);
          if (meta) {
            fill(meta);
            status.textContent = 'Found it. Check the details and save.';
            return;
          }
          if (ids.url) form.url.value = ids.url;
          // A link straight to a PDF: download it now and read it.
          if (pdfLink) {
            status.textContent = 'Downloading the PDF…';
            try {
              pendingPdf = await Lookup.fetchPdf(pdfLink);
              if (await identifyFromPdf(pendingPdf)) return;
            } catch (err) {
              pdfError = err.message;
            }
          }
          // An ordinary web page: read it directly, if the site allows that.
          let pageError = null;
          if (ids.url && !pdfLink) {
            status.textContent = 'Reading the page…';
            try {
              if (await usePage(await Epubify.fetchPage(ids.url), 'Web page')) return;
            } catch (err) {
              pageError = err.message;
            }
          }
          // No identifier: search Crossref by title (use shared page title if we have it).
          const q2 = Lookup.cleanTitle(ids.url ? sharedTitle || input.replace(ids.url, '') : input);
          if (q2 && (await searchTitle(q2))) return;
          status.textContent = pdfError
            ? `Couldn’t download that PDF (${pdfError}). Download it in your browser and share the file to PaperReads; the app will read the details from it.`
            : q2
              ? 'Nothing found. Fill in by hand.'
              : pageError
                ? `Couldn’t read that page (${pageError}). To save it as an EPUB: in Chrome tap ⋮ → ⬇ Download, then share the downloaded page to PaperReads.`
                : 'No DOI or arXiv ID in that link. Paste the title to search, or fill in by hand.';
        } catch (err) {
          status.textContent = `Lookup failed (${err.message}). Fill in by hand.`;
        }
      };
      lookup.addEventListener('submit', (e) => {
        e.preventDefault();
        run();
      });
      const sharedPdf = inbox && inbox.file && fileKind(inbox.file) === 'PDF' ? inbox.file : null;
      const sharedPage = inbox && inbox.file && isWebFile(inbox.file) ? inbox.file : null;
      (async () => {
        if (sharedPage) {
          try {
            if (await usePage(await Epubify.readPageFile(sharedPage), 'Saved web page')) return;
            status.textContent = 'Couldn’t find a title in that page. Fill in the details by hand.';
          } catch (err) {
            status.textContent = `Couldn’t read that file (${err.message}).`;
          }
          return;
        }
        if (shared) await run();
        // A shared PDF file: if the link (if any) didn't identify it, read the PDF itself.
        if (sharedPdf && !form.doi.value && !form.arxiv.value) {
          if (!(await identifyFromPdf(sharedPdf))) status.textContent = 'Couldn’t tell which paper this PDF is. Paste its title or DOI above.';
        }
      })();
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = form;
      Object.assign(p, {
        title: f.title.value.trim(),
        authors: f.authors.value.split(/\n|;/).map((s) => s.trim()).filter(Boolean),
        year: parseInt(f.year.value, 10) || null,
        totalPages: parseInt(f.totalPages.value, 10) || null,
        venue: f.venue.value.trim(),
        doi: f.doi.value.trim() || null,
        arxiv: f.arxiv.value.trim() || null,
        url: f.url.value.trim() || null,
        abstract: f.abstract.value.trim(),
      });
      if (existing) {
        if (p.totalPages && p.currentPage > p.totalPages) p.currentPage = p.totalPages;
        await savePaper(p);
        toast('Saved');
        location.hash = `#/paper/${p.id}`;
        return;
      }
      Object.assign(p, {
        id: uid(),
        addedAt: now(),
        currentPage: 0,
        percent: 0,
        rating: 0,
        notes: '',
        tags: f.tags.value.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean),
        collections: $$('input[name=col]:checked', f).map((c) => c.value),
        status: 'none',
        pdfUrl: pdfLink || null,
        foundVia: viaPaper ? viaPaper.id : null,
      });
      await savePaper(p);
      // added from a reference in the paper it was found through: that paper cites it
      if (viaPaper && q.cites) await DB.put('links', { fromId: viaPaper.id, toId: p.id, type: 'cites', createdAt: now() });
      await setStatus(p, f.status.value);
      if (inbox) await DB.del('inbox', inbox.id);
      let pdfJob = Promise.resolve();
      if (inbox && inbox.file && !isWebFile(inbox.file)) {
        if (isEpub(inbox.file)) await attachEpub(p.id, inbox.file, { source: 'Shared file' });
        else await attachPdf(p.id, inbox.file);
      } else if (pendingPage) {
        // nothing to download: the EPUB is made from the page below
      } else if (f.getpdf && f.getpdf.checked && (pendingPdf || ((pdfLink || p.arxiv) && navigator.onLine))) {
        // Fire and forget so saving feels instant.
        const get = pendingPdf ? Promise.resolve(pendingPdf) : pdfLink ? Lookup.fetchPdf(pdfLink) : Lookup.fetchArxivPdf(p.arxiv);
        pdfJob = get
          .then((file) => attachPdf(p.id, file))
          .then(() => {
            toast('PDF saved offline');
            if (location.hash === `#/paper/${p.id}`) route();
          })
          .catch((err) => toast(pdfLink ? `Couldn’t download the PDF: ${err.message}. Download it in your browser and attach it.` : 'Could not download the PDF'));
      }
      const wantsEpub = f.getepub && f.getepub.checked;
      if (pendingPage && (wantsEpub || !f.getepub)) {
        const page = pendingPage;
        pdfJob
          .then(() => makeWebEpub(p.id, page))
          .then(() => {
            toast('EPUB ready to read');
            if (location.hash === `#/paper/${p.id}`) route();
          })
          .catch((err) => toast(`No EPUB made: ${err.message}`));
      } else if (wantsEpub && (p.arxiv || p.doi || (inbox && inbox.file)) && (navigator.onLine || (inbox && inbox.file))) {
        // After the PDF lands, so the PDF route is available as a fallback.
        pdfJob
          .then(() => makeEpubFor(p.id))
          .then(() => {
            toast('EPUB ready to read');
            if (location.hash === `#/paper/${p.id}`) route();
          })
          .catch(() => toast('No EPUB made. Try “Make EPUB” on the paper page'));
      }
      if (viaPaper && q.back === 'read') {
        toast('Added. Back to reading');
        location.hash = `#/read/${viaPaper.id}`;
        return;
      }
      toast('Added to your library');
      location.hash = `#/paper/${p.id}`;
    });
  }

  // ---------- EPUB reader ----------
  async function viewReader(id, q = {}) {
    const [p, rec] = await Promise.all([DB.get('papers', id), DB.get('epubs', id)]);
    if (!p || !rec) {
      location.hash = `#/paper/${id}`;
      return;
    }
    setTitle(p.title);
    document.body.classList.add('reading');
    main.innerHTML = `<div class="reader">
      <div class="r-bar">
        <a href="#/paper/${p.id}" class="r-btn" aria-label="Back to paper">←</a>
        <span class="r-title">${esc(p.title)}</span>
        <button class="r-btn" id="r-smaller" aria-label="Smaller text">A−</button>
        <button class="r-btn" id="r-bigger" aria-label="Larger text">A+</button>
        ${Speech.supported ? '<button class="r-btn" id="r-tts" aria-label="Read aloud">🔊</button>' : ''}
        <button class="r-btn" id="r-ask" aria-label="Ask Claude">💬</button>
        <button class="r-btn" id="r-concerns" aria-label="Concerns">⚠<span class="r-count" id="r-ccount"></span></button>
        <button class="r-btn" id="r-toc" aria-label="Contents">☰</button>
      </div>
      <div class="r-stage"><div id="r-view"></div>
        <button class="r-zone left" id="r-prev" aria-label="Previous page"></button>
        <button class="r-zone right" id="r-next" aria-label="Next page"></button>
      </div>
      <button class="r-backchip" id="r-back" hidden>↩ Back</button>
      <button class="r-backchip r-syncchip" id="r-sync" hidden></button>
      <div class="r-selbar" id="r-selbar" hidden>
        <button class="btn small primary" id="hl-add">Highlight</button>
        <button class="btn small" id="hl-note">Highlight + note</button>
        <button class="btn small" id="hl-concern">Concern</button>
        <button class="btn small" id="hl-ask">Ask</button>
        <button class="btn small" id="hl-define">Define</button>
        ${Speech.supported ? '<button class="btn small" id="hl-speak">🔊 From here</button>' : ''}
        <button class="r-btn" id="hl-cancel" aria-label="Cancel">✕</button>
      </div>
      <div class="r-ttsbar" id="r-ttsbar" hidden>
        <button class="r-btn" id="tts-play" aria-label="Pause">⏸</button>
        <button class="r-btn" id="tts-back" aria-label="Previous sentence">⏮</button>
        <button class="r-btn" id="tts-skip" aria-label="Next sentence">⏭</button>
        <select id="tts-rate" aria-label="Speed">${[0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.5].map((r) => `<option value="${r}">${r}×</option>`).join('')}</select>
        <select id="tts-voice" aria-label="Voice"></select>
        <button class="r-btn" id="tts-stop" aria-label="Stop reading aloud">✕</button>
      </div>
      <div class="r-foot"><input type="range" id="r-seek" min="0" max="1000" value="0" aria-label="Position in paper" disabled><span id="r-pct">…</span></div>
      <nav class="r-toc" id="r-toc-panel" hidden></nav>
      <section class="r-toc r-concerns" id="r-concerns-panel" hidden></section>
      <section class="r-toc r-concerns r-ask" id="r-ask-panel" hidden></section>
    </div>`;

    const ePub = await Epubify.epubjs();
    const book = ePub(await rec.blob.arrayBuffer());
    const rendition = book.renderTo('r-view', { width: '100%', height: '100%', flow: 'paginated', spread: 'none' });
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    rendition.themes.register('pr', {
      body: { background: dark ? '#121211 !important' : '#fcfcfb !important', color: dark ? '#f0efec !important' : '#0b0b0b !important' },
      a: { color: dark ? '#6aa7f0 !important' : '#2a78d6 !important' },
      'img, svg': { 'max-width': '100% !important' },
      'td, th': { 'border-color': '#8885 !important' },
    });
    rendition.themes.select('pr');
    let fontSize = await DB.setting('readerFontSize', 100);
    rendition.themes.fontSize(fontSize + '%');

    const startPct = pct(p);
    let lastPct = startPct;
    let locationsReady = false;
    let saveTimer = null;

    // Save position and progress as you read, a moment after each page turn,
    // not only when leaving: Android can freeze or close the app first.
    // Progress only moves forward on its own (flipping back to check a
    // figure shouldn't undo it); set it lower by hand on the paper page.
    // One reading-log entry per session, updated as it grows.
    let sessionLog = null;
    let lastCfi = null;
    const saveNow = async () => {
      clearTimeout(saveTimer);
      saveTimer = null;
      if (!moved) return;
      const fresh = await DB.get('papers', id);
      if (!fresh) return;
      if (lastCfi) fresh.epubCfi = lastCfi;
      const before = fresh.totalPages ? fresh.currentPage || 0 : Math.round(fresh.percent || 0);
      const reached = fresh.totalPages ? Math.min(fresh.totalPages, Math.round(lastPct * fresh.totalPages)) : Math.min(100, Math.round(lastPct * 100));
      if (reached > before) {
        if (fresh.totalPages) fresh.currentPage = reached;
        else fresh.percent = reached;
        if (!sessionLog || sessionLog.date !== today()) sessionLog = { paperId: id, date: today(), startPage: fresh.totalPages ? before : fresh.currentPage || 0 };
        Object.assign(sessionLog, { ts: now(), page: fresh.currentPage || 0, percent: fresh.percent || 0, delta: (fresh.currentPage || 0) - sessionLog.startPage });
        sessionLog.id = await DB.put('progress', sessionLog);
        if (fresh.status === 'want' || fresh.status === 'none') await setStatus(fresh, 'reading', true);
        if (pct(fresh) >= 1 && fresh.status !== 'read') offerFinish(fresh);
      }
      await savePaper(fresh);
    };
    const commit = saveNow;

    rendition.on('relocated', (loc) => {
      let v = locationsReady ? book.locations.percentageFromCfi(loc.start.cfi) : loc.start.percentage || 0;
      if (loc.atEnd) v = 1;
      lastPct = v;
      lastCfi = loc.start.cfi;
      $('#r-pct').textContent = `${Math.round(v * 100)}%`;
      if (locationsReady) $('#r-seek').value = Math.round(v * 1000);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, 700);
    });

    // --- text selection ---
    const selection = () => {
      const c = rendition.getContents()[0];
      return c ? c.window.getSelection() : null;
    };
    const hasSelection = () => {
      const sel = selection();
      return !!(sel && !sel.isCollapsed && sel.toString().trim());
    };
    const clearSelection = () => {
      const sel = selection();
      if (sel) sel.removeAllRanges();
    };

    // Keep the page put while selecting. Pages sit side by side in one wide
    // strip; dragging a selection lets the browser scroll that strip, which
    // left the view stranded between pages. Only page turns may move it.
    let navigating = false;
    let pageScroll = null;
    const strip = () => rendition.manager && rendition.manager.container;
    // Only the reader's own moves are saved: merely opening a paper must not
    // record its (possibly stale) position as new, or it would beat the
    // position synced from another device.
    let moved = false;
    const go = async (fn, opening = false) => {
      if (!opening) moved = true;
      navigating = true;
      clearSelection();
      hideBar();
      try {
        await fn();
      } finally {
        navigating = false;
        if (strip()) pageScroll = strip().scrollLeft;
      }
    };
    const onStripScroll = () => {
      const c = strip();
      if (!navigating && pageScroll !== null && hasSelection() && Math.abs(c.scrollLeft - pageScroll) > 1) c.scrollLeft = pageScroll;
    };

    const prev = () => go(() => rendition.prev());
    const next = () => go(() => rendition.next());
    // a press that moved (a drag to select) isn't a page turn
    let zoneDown = null;
    for (const [sel, fn] of [['#r-prev', prev], ['#r-next', next]]) {
      const z = $(sel);
      z.addEventListener('pointerdown', (e) => (zoneDown = { x: e.clientX, y: e.clientY }));
      z.addEventListener('click', (e) => {
        const moved = zoneDown && Math.hypot(e.clientX - zoneDown.x, e.clientY - zoneDown.y) > 6;
        zoneDown = null;
        if (!moved || e.detail === 0) fn(); // detail 0: keyboard
      });
    }
    const onKey = (e) => {
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'ArrowRight') next();
    };
    document.addEventListener('keydown', onKey);
    rendition.on('keyup', onKey);
    let touchX = null;
    let touchT = 0;
    rendition.on('touchstart', (e) => {
      touchX = e.changedTouches[0].screenX;
      touchT = Date.now();
    });
    rendition.on('touchend', (e) => {
      if (touchX === null) return;
      const dx = e.changedTouches[0].screenX - touchX;
      touchX = null;
      // a long press, or a drag while text is selected, is selecting, not swiping
      if (Date.now() - touchT > 450 || hasSelection()) return;
      if (Math.abs(dx) > 50) (dx < 0 ? next : prev)();
    });

    // --- highlights ---
    const HL_STYLE = { fill: '#f5c518', 'fill-opacity': '0.35', 'mix-blend-mode': 'multiply' };
    const selbar = $('#r-selbar');
    let pending = null;
    function hideBar() {
      selbar.hidden = true;
      pending = null;
    }
    rendition.on('selected', (cfiRange, contents) => {
      const text = contents.window.getSelection().toString().replace(/\s+/g, ' ').trim();
      if (!text) return;
      pending = { cfiRange, text };
      selbar.hidden = false;
    });
    rendition.hooks.content.register((contents) => {
      contents.document.addEventListener('selectionchange', () => {
        if (!hasSelection()) setTimeout(() => !hasSelection() && hideBar(), 300);
      });
      // In-document links: a citation shows its reference in a pop-up instead
      // of jumping away; other links (figures, sections) jump, with a Back button.
      contents.document.addEventListener(
        'click',
        (e) => {
          const a = e.target.closest && e.target.closest('a[href]');
          if (!a || hasSelection()) return;
          const href = a.getAttribute('href');
          const idx = href.indexOf('#');
          if (idx < 0 || /^[a-z]+:/i.test(href)) return;
          const target = contents.document.getElementById(decodeURIComponent(href.slice(idx + 1)));
          if (!target) return;
          e.preventDefault();
          e.stopPropagation();
          rememberSpot();
          // jump by the target's exact position (bare "#id" links don't resolve on their own)
          let cfi = null;
          try {
            cfi = contents.cfiFromNode(target);
          } catch {}
          if (target.closest('.refs, .ltx_bibliography, .ref-entry, .ltx_bibitem')) showReference(target, cfi);
          else if (cfi) {
            backBtn.hidden = false;
            go(() => rendition.display(cfi));
          }
        },
        true
      );
    });
    const backBtn = $('#r-back');
    let backTo = null;
    const rememberSpot = () => {
      const loc = rendition.currentLocation();
      if (loc && loc.start) backTo = loc.start.cfi;
    };
    backBtn.addEventListener('click', () => {
      backBtn.hidden = true;
      if (backTo) go(() => rendition.display(backTo));
      backTo = null;
    });
    function showReference(target, cfi) {
      const dlg = $('#dialog');
      const item = target.closest('li, p, .ltx_bibitem') || target;
      dlg.innerHTML = `<form method="dialog" class="dlg"><h3>Reference</h3>
        <p class="ref-pop">${esc(item.textContent.replace(/\s+/g, ' ').trim())}</p>
        <div class="row end wrap"><button value="add" class="btn">＋ Add to library</button><button value="go" class="btn">Go to reference</button><button value="ok" class="btn primary">Close</button></div></form>`;
      dlg.onclose = () => {
        // snowballing: add the cited paper, remembering it was found here
        if (dlg.returnValue === 'add') location.hash = `#/add?via=${id}&cites=1&back=read&text=${encodeURIComponent(item.textContent.replace(/\s+/g, ' ').trim().replace(/^\[?\d+[\].]?\s*/, '').replace(/(\p{Ll})- (\p{Ll})/gu, '$1$2'))}`;
        if (dlg.returnValue === 'go' && cfi) {
          backBtn.hidden = false;
          go(() => rendition.display(cfi));
        }
      };
      dlg.showModal();
    }
    const drawHighlight = (h) => {
      try {
        rendition.annotations.highlight(h.cfi, { id: h.id }, () => openHighlight(h.id), 'pr-hl', HL_STYLE);
      } catch {} // e.g. a highlight made in an earlier version of this EPUB
    };
    const pageOf = (cfi) => {
      if (!p.totalPages) return null;
      const f = locationsReady ? book.locations.percentageFromCfi(cfi) : lastPct;
      return Math.min(p.totalPages, Math.max(1, Math.round(f * p.totalPages)));
    };
    const addHighlight = async (note = '') => {
      if (!pending) return;
      const h = { paperId: id, quote: pending.text, page: pageOf(pending.cfiRange), note, cfi: pending.cfiRange, createdAt: now() };
      h.id = await DB.put('highlights', h);
      drawHighlight(h);
      clearSelection();
      hideBar();
      toast('Highlighted');
      refreshPanel();
    };
    $('#hl-add').addEventListener('click', () => addHighlight());
    $('#hl-note').addEventListener('click', async () => {
      const keep = pending;
      const note = await askNote('Note for this highlight');
      pending = keep;
      if (note !== null) await addHighlight(note);
    });
    $('#hl-cancel').addEventListener('click', () => {
      clearSelection();
      hideBar();
    });
    async function openHighlight(hid) {
      const h = await DB.get('highlights', hid);
      if (!h) return;
      const dlg = $('#dialog');
      dlg.innerHTML = `<form method="dialog" class="dlg"><blockquote class="hl-quote">${esc(h.quote)}</blockquote>
        <textarea name="note" rows="3" placeholder="Add a note">${esc(h.note || '')}</textarea>
        <div class="row between"><button value="delete" class="btn danger-ghost">Delete</button>
        <span class="row"><button value="cancel" class="btn" formnovalidate>Close</button><button value="ok" class="btn primary">Save</button></span></div></form>`;
      dlg.onclose = async () => {
        if (dlg.returnValue === 'ok') {
          h.note = $('[name=note]', dlg).value.trim();
          await DB.put('highlights', h);
          toast('Note saved');
        } else if (dlg.returnValue === 'delete') {
          await DB.del('highlights', h.id);
          rendition.annotations.remove(h.cfi, 'highlight');
          toast('Highlight deleted');
        }
        refreshPanel();
      };
      dlg.showModal();
    }
    // --- read aloud ---
    const ttsBar = $('#r-ttsbar');
    const tts = { on: false, playing: false, run: 0, blocks: [], bi: 0, sents: [], si: 0, doc: null, lock: null };
    const ttsRate = $('#tts-rate');
    const ttsVoice = $('#tts-voice');
    const ttsPlay = $('#tts-play');
    const CFI = ePub.CFI;
    const showSentence = (range) => {
      const w = range.startContainer.ownerDocument.defaultView;
      if (w.CSS && w.CSS.highlights && w.Highlight) w.CSS.highlights.set('pr-tts', new w.Highlight(range));
    };
    const clearSentence = () => {
      const c = rendition.getContents()[0];
      if (c && c.window.CSS && c.window.CSS.highlights) c.window.CSS.highlights.delete('pr-tts');
    };
    // the sentence being read stays on screen
    const follow = async (range) => {
      const c = rendition.getContents()[0];
      const loc = rendition.currentLocation();
      if (!c || !loc || !loc.start) return;
      let cfi;
      try {
        cfi = c.cfiFromRange(range);
      } catch {
        return;
      }
      const cmp = new CFI();
      if (cmp.compare(cfi, loc.end.cfi) > 0 || cmp.compare(cfi, loc.start.cfi) < 0) await go(() => rendition.display(cfi));
    };
    const loadBlocks = () => {
      const c = rendition.getContents()[0];
      if (!c) return false;
      if (c.document !== tts.doc) {
        tts.doc = c.document;
        if (!tts.doc.getElementById('pr-tts-style')) {
          const st = tts.doc.createElement('style');
          st.id = 'pr-tts-style';
          st.textContent = '::highlight(pr-tts){background-color:rgba(42,120,214,.28);}';
          tts.doc.head.appendChild(st);
        }
        tts.blocks = Speech.blocks(tts.doc);
      }
      return tts.blocks.length > 0;
    };
    // where to start: the selection, else the top of the page
    const startAt = (node, offset = 0) => {
      const bi = tts.blocks.findIndex((b) => b.contains(node) || !!(node.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
      tts.bi = Math.max(0, bi);
      tts.sents = tts.blocks.length ? Speech.sentences(tts.blocks[tts.bi]) : [];
      tts.si = 0;
      if (tts.blocks[tts.bi] && tts.blocks[tts.bi].contains(node)) {
        // the sentence the start falls in
        const probe = node.ownerDocument.createRange();
        probe.setStart(node, offset);
        const k = tts.sents.findIndex((x) => x.range().compareBoundaryPoints(Range.END_TO_START, probe) > 0 || x.range().comparePoint(node, offset) === 0);
        if (k > 0) tts.si = k;
      }
    };
    const keepAwake = async (on) => {
      try {
        if (on && !tts.lock && navigator.wakeLock) tts.lock = await navigator.wakeLock.request('screen');
        if (!on && tts.lock) {
          await tts.lock.release();
          tts.lock = null;
        }
      } catch {}
    };
    async function ttsLoop() {
      const run = ++tts.run;
      tts.playing = true;
      ttsPlay.textContent = '⏸';
      ttsPlay.setAttribute('aria-label', 'Pause');
      keepAwake(true);
      while (tts.run === run) {
        if (tts.si >= tts.sents.length) {
          tts.bi++;
          tts.si = 0;
          if (tts.bi >= tts.blocks.length) {
            stopTts('Finished reading aloud');
            return;
          }
          tts.sents = Speech.sentences(tts.blocks[tts.bi]);
          continue;
        }
        const s = tts.sents[tts.si];
        const range = s.range();
        showSentence(range);
        await follow(range);
        if (tts.run !== run) return;
        const ok = await Speech.say(s.text, { rate: +ttsRate.value, voice: ttsVoice.value });
        if (tts.run !== run) return;
        if (ok) tts.si++;
      }
    }
    const pauseTts = () => {
      tts.run++;
      tts.playing = false;
      Speech.stop();
      ttsPlay.textContent = '▶';
      ttsPlay.setAttribute('aria-label', 'Play');
      keepAwake(false);
    };
    function stopTts(msg) {
      pauseTts();
      tts.on = false;
      ttsBar.hidden = true;
      clearSentence();
      if (msg) toast(msg);
    }
    async function startTts(range) {
      if (!loadBlocks()) return toast('Nothing to read on this page');
      if (range) startAt(range.startContainer, range.startOffset);
      else {
        const c = rendition.getContents()[0];
        const loc = rendition.currentLocation();
        let r = null;
        try {
          r = loc && loc.start && c.range(loc.start.cfi);
        } catch {}
        if (r) startAt(r.startContainer, r.startOffset);
        else startAt(tts.blocks[0]);
      }
      if (!tts.on) {
        await Speech.voicesReady();
        const vs = Speech.voices();
        const want = await DB.setting('ttsVoice', '');
        ttsVoice.innerHTML = '<option value="">Default voice</option>' + vs.map((v) => `<option value="${esc(v.name)}"${v.name === want ? ' selected' : ''}>${esc(v.name.replace(/^(Google|Microsoft)\s+/, ''))} (${esc(v.lang)})</option>`).join('');
        ttsRate.value = String(await DB.setting('ttsRate', 1));
        if (!ttsRate.value) ttsRate.value = '1';
      }
      tts.on = true;
      ttsBar.hidden = false;
      Speech.stop();
      ttsLoop();
    }
    $('#r-tts')?.addEventListener('click', () => (tts.on ? stopTts() : startTts()));
    $('#hl-speak')?.addEventListener('click', () => {
      const sel = selection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      clearSelection();
      hideBar();
      startTts(range);
    });
    ttsPlay.addEventListener('click', () => (tts.playing ? pauseTts() : ttsLoop()));
    const stepTts = (d) => {
      Speech.stop();
      tts.si += d;
      while (tts.si < 0 && tts.bi > 0) {
        tts.bi--;
        tts.sents = Speech.sentences(tts.blocks[tts.bi]);
        tts.si += tts.sents.length;
      }
      tts.si = Math.max(0, tts.si);
      ttsLoop();
    };
    $('#tts-skip').addEventListener('click', () => stepTts(1));
    $('#tts-back').addEventListener('click', () => stepTts(-1));
    $('#tts-stop').addEventListener('click', () => stopTts());
    // a new speed or voice applies from the sentence being read
    const ttsSettingChanged = async () => {
      await DB.setSetting('ttsRate', +ttsRate.value);
      await DB.setSetting('ttsVoice', ttsVoice.value);
      if (tts.playing) {
        Speech.stop();
        ttsLoop();
      }
    };
    ttsRate.addEventListener('change', ttsSettingChanged);
    ttsVoice.addEventListener('change', ttsSettingChanged);

    // --- define ---
    $('#hl-define').addEventListener('click', async () => {
      // (the selection as it is now: the reader's note of it can lag a moment)
      const now = selection();
      const nowText = now && !now.isCollapsed ? now.toString().replace(/\s+/g, ' ').trim() : '';
      if (nowText && pending && nowText !== pending.text) {
        try {
          pending = { cfiRange: rendition.getContents()[0].cfiFromRange(now.getRangeAt(0)), text: nowText };
        } catch {}
      }
      const keep = pending;
      if (!keep) return;
      const word = Define.term(keep.text);
      if (!word || word.split(' ').length > 5) return toast('Select a word or a short term to define it');
      const dlg = $('#dialog');
      dlg.innerHTML = `<form method="dialog" class="dlg define"><h3>${esc(word)}</h3><p class="muted small" id="def-body">Looking up…</p>
        <div class="row end wrap" id="def-actions"><button value="ok" class="btn primary">Close</button></div></form>`;
      dlg.onclose = null;
      dlg.showModal();
      let r = null;
      try {
        r = await Define.lookup(word);
      } catch (err) {
        $('#def-body', dlg).textContent = `Couldn’t look it up: ${err.message}`;
        return;
      }
      const body = $('#def-body', dlg);
      body.classList.remove('muted', 'small');
      if (!r) body.innerHTML = '<span class="muted">No definition found.</span>';
      else if (r.kind === 'dict') {
        $('h3', dlg).innerHTML = `${esc(r.word)} ${r.phonetic ? `<small class="muted">${esc(r.phonetic)}</small>` : ''}${r.audio ? ' <button type="button" class="r-btn" id="def-say" aria-label="Pronounce">🔈</button>' : ''}`;
        body.innerHTML =
          r.meanings
            .slice(0, 4)
            .map((m) => `<p class="def-pos"><i>${esc(m.pos)}</i></p><ol class="def-list">${m.defs.slice(0, 3).map((d) => `<li>${esc(d.d)}${d.ex ? `<br><span class="muted small">“${esc(d.ex)}”</span>` : ''}</li>`).join('')}</ol>${m.synonyms.length ? `<p class="muted small">Similar: ${esc(m.synonyms.join(', '))}</p>` : ''}`)
            .join('') + `<p class="muted small">From <a href="${esc(r.source)}" target="_blank" rel="noopener">Wiktionary</a></p>`;
        $('#def-say', dlg)?.addEventListener('click', () => new Audio(r.audio).play().catch(() => {}));
      } else {
        body.innerHTML = `<p><b>${esc(r.title)}</b></p><p>${esc(r.extract)}</p><p class="muted small">From <a href="${esc(r.url)}" target="_blank" rel="noopener">Wikipedia</a></p>`;
      }
      $('#def-actions', dlg).innerHTML = `<button value="ask" class="btn">Ask Claude</button>${r ? '<button value="save" class="btn">Highlight with definition</button>' : ''}<button value="ok" class="btn primary">Close</button>`;
      dlg.onclose = async () => {
        if (dlg.returnValue === 'save' && r) {
          pending = keep;
          await addHighlight(Define.brief(r));
        } else if (dlg.returnValue === 'ask') {
          clearSelection();
          hideBar();
          tocPanel.hidden = concernsPanel.hidden = true;
          askPanel.hidden = false;
          ask.quote(keep.text);
        }
      };
    });

    const resize = async (delta) => {
      fontSize = Math.max(70, Math.min(200, fontSize + delta));
      await go(() => rendition.themes.fontSize(fontSize + '%'));
      await DB.setSetting('readerFontSize', fontSize);
    };
    $('#r-smaller').addEventListener('click', () => resize(-10));
    $('#r-bigger').addEventListener('click', () => resize(10));

    const tocPanel = $('#r-toc-panel');
    const concernsPanel = $('#r-concerns-panel');
    const askPanel = $('#r-ask-panel');
    // one side panel at a time
    const showPanel = (panel) => {
      for (const x of [tocPanel, concernsPanel, askPanel]) x.hidden = x !== panel || !x.hidden;
    };
    $('#r-toc').addEventListener('click', () => showPanel(tocPanel));
    // Concerns: same list as the paper page, in a side panel
    const CONCERN_STYLE = { fill: '#f97316', 'fill-opacity': '0.22', 'mix-blend-mode': 'multiply' };
    const drawConcern = (c) => {
      try {
        rendition.annotations.highlight(c.cfi, { id: c.id }, () => {
          tocPanel.hidden = askPanel.hidden = true;
          concernsPanel.hidden = false;
        }, 'pr-concern', CONCERN_STYLE);
      } catch {}
    };
    const setCount = (paper) => {
      const n = openConcerns(paper);
      $('#r-ccount').textContent = n ? String(n) : '';
    };
    const concerns = concernsUI(concernsPanel, id, {
      jump: (cfi) => {
        concernsPanel.hidden = true;
        go(() => rendition.display(cfi));
      },
      onChange: (paper) => {
        setCount(paper);
        // redraw underlines (a concern may have been deleted)
        for (const c of paper.concerns || []) if (c.cfi) try { rendition.annotations.remove(c.cfi, 'highlight'); } catch {}
        // (removing by range also drops a yellow highlight on the same words: redraw those)
        DB.byIndex('highlights', 'paperId', id).then((hs) => hs.filter((h) => h.cfi && (paper.concerns || []).some((c) => c.cfi === h.cfi)).forEach(drawHighlight));
        (paper.concerns || []).filter((c) => c.cfi && !c.done).forEach(drawConcern);
      },
    });
    setCount(p);
    $('#r-concerns').addEventListener('click', () => showPanel(concernsPanel));
    const ask = askUI(askPanel, id, { addConcern: (c) => concerns.add(c) });
    $('#r-ask').addEventListener('click', () => showPanel(askPanel));
    $('#hl-ask').addEventListener('click', () => {
      const keep = pending;
      if (!keep) return;
      clearSelection();
      hideBar();
      tocPanel.hidden = concernsPanel.hidden = true;
      askPanel.hidden = false;
      ask.quote(keep.text);
    });
    $('#hl-concern').addEventListener('click', async () => {
      const keep = pending;
      const text = await askNote('What’s the concern?');
      if (text === null || !keep) return;
      await concerns.add({ text, quote: keep.text, cfi: keep.cfiRange, page: pageOf(keep.cfiRange) });
      clearSelection();
      hideBar();
      toast('Concern added');
    });
    let tocHtml = '';
    async function refreshPanel() {
      const hls = (await DB.byIndex('highlights', 'paperId', id)).filter((h) => h.cfi);
      const order = (h) => (locationsReady ? book.locations.percentageFromCfi(h.cfi) : h.createdAt);
      hls.sort((a, b) => order(a) - order(b));
      tocPanel.innerHTML =
        '<h4>Contents</h4>' +
        (tocHtml || '<p class="muted small">No contents</p>') +
        `<h4>Highlights (${hls.length})</h4>` +
        (hls.map((h) => `<a href="#" data-href="${esc(h.cfi)}" class="hl-item"><q>${esc(h.quote.length > 140 ? h.quote.slice(0, 140) + '…' : h.quote)}</q>${h.note ? `<small>${esc(h.note)}</small>` : ''}</a>`).join('') ||
          '<p class="muted small">Select text to highlight it.</p>');
      $$('[data-href]', tocPanel).forEach((a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          tocPanel.hidden = true;
          go(() => rendition.display(a.dataset.href));
        })
      );
    }
    book.loaded.navigation.then((nav) => {
      const items = (list, depth) =>
        list.map((t) => `<a href="#" data-href="${esc(t.href)}" style="padding-left:${12 + depth * 14}px">${esc(t.label.trim())}</a>${t.subitems && t.subitems.length ? items(t.subitems, depth + 1) : ''}`).join('');
      tocHtml = items(nav.toc, 0);
      refreshPanel();
    });

    const seek = $('#r-seek');
    seek.addEventListener('change', () => go(() => rendition.display(book.locations.cfiFromPercentage(seek.value / 1000))));

    const onHide = () => document.visibilityState === 'hidden' && commit();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', commit);
    teardown = async () => {
      if (tts.on) stopTts();
      if (strip()) strip().removeEventListener('scroll', onStripScroll);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', commit);
      document.body.classList.remove('reading');
      readerSync = null;
      await commit();
      try {
        book.destroy();
      } catch {}
    };

    await go(() => rendition.display(q.cfi || p.epubCfi || undefined), true);
    if (strip()) strip().addEventListener('scroll', onStripScroll);
    (await DB.byIndex('highlights', 'paperId', id)).filter((h) => h.cfi).forEach(drawHighlight);
    (p.concerns || []).filter((c) => c.cfi && !c.done).forEach(drawConcern);
    // Locations give a stable percentage across the whole book; generating
    // them takes a moment, so the bar enables once they're ready.
    const located = book.ready.then(() => book.locations.generate(1200));
    located
      .then(() => {
        locationsReady = true;
        seek.disabled = false;
        const loc = rendition.currentLocation();
        if (loc && loc.start) {
          lastPct = loc.atEnd ? 1 : book.locations.percentageFromCfi(loc.start.cfi);
          $('#r-pct').textContent = `${Math.round(lastPct * 100)}%`;
          seek.value = Math.round(lastPct * 1000);
        }
        refreshPanel(); // highlights can now be listed in reading order
      })
      .catch(() => {});
    if (!q.cfi && !p.epubCfi && startPct > 0 && startPct < 1) {
      // Opened for the first time but already part-read (e.g. in the PDF):
      // jump to the same point once locations are known.
      located.then(() => go(() => rendition.display(book.locations.cfiFromPercentage(startPct)), true)).catch(() => {});
    }

    // Another device read further: offer to jump there. And if this device
    // couldn't sync on opening (Google sign-in needs a tap), offer that.
    const syncChip = $('#r-sync');
    let offered = null;
    readerSync = (result) => {
      const pos = result && result.positions && result.positions.get(id);
      if (!pos || pos.cfi === lastCfi || !locationsReady) return syncChip.hidden = true;
      const there = book.locations.percentageFromCfi(pos.cfi);
      if (!(there > lastPct + 0.005)) return (syncChip.hidden = true);
      offered = pos.cfi;
      syncChip.textContent = `↪ Your other device is at ${Math.round(there * 100)}%. Jump there`;
      syncChip.hidden = false;
    };
    syncChip.addEventListener('click', () => {
      syncChip.hidden = true;
      if (offered) return go(() => rendition.display(offered));
      Sync.run({ interactive: true }).catch((err) => toast(`Sync failed: ${err.message}`));
    });
    if (Sync.state.needsSignIn && (await DB.setting('googleClientId', ''))) {
      syncChip.textContent = '⟳ Sync to continue from your other devices';
      syncChip.hidden = false;
    }
  }
  let readerSync = null; // the open reader's hook for fresh sync results

  // ---------- backup ----------
  // All discovery trails, or one of them in full.
  async function viewTrails(q, id) {
    const all = await papers();
    const t = trailOf(all);
    if (id) {
      const p = t.byId.get(id);
      if (!p) return (location.hash = '#/trails');
      const root = t.rootOf(p);
      setTitle('Discovery trail');
      const size = t.descendants(root.id).size + 1;
      main.innerHTML = `<section class="card"><h3>${esc(root.title)}</h3><p class="muted small">${size} paper${size > 1 ? 's' : ''} found from here. Indented papers were found through the one above.</p>
        <ul class="trail big">${trailTree(root, t.kids, id)}</ul></section>
        <p class="small"><a href="#/trails">All trails →</a></p>`;
      return;
    }
    setTitle('Discovery trails');
    const roots = all.filter((p) => !t.byId.get(p.foundVia) && t.kids.has(p.id));
    const info = roots
      .map((r) => {
        const ids = [r.id, ...t.descendants(r.id)];
        const ps = ids.map((i) => t.byId.get(i));
        return { r, n: ps.length, read: ps.filter((x) => x.status === 'read').length, last: Math.max(...ps.map((x) => x.addedAt || 0)) };
      })
      .sort((a, b) => b.last - a.last);
    main.innerHTML = `<section class="card"><p class="muted small">When you add a paper you found through another one (“＋ Add a paper found here” on a paper, or “＋ Add to library” on a reference in the reader), it joins that paper’s trail.</p>
      <ul class="list compact">${info.map(({ r, n, read }) => `<li class="paper-row"><a class="paper-link" href="#/trail/${r.id}"><span class="pr-title">${esc(r.title)}</span><span class="pr-meta">${n} papers · ${read} read</span></a></li>`).join('') || '<li class="muted small">No trails yet.</li>'}</ul></section>`;
  }

  // ---------- recently deleted ----------
  async function viewTrash() {
    setTitle('Recently deleted');
    const t = await trashed();
    const items = Object.values(t).sort((a, b) => b.deletedAt - a.deletedAt);
    const syncOn = !!(await DB.setting('googleClientId', ''));
    const row = (x, i, src) => `<li class="paper-row trash-row"><div class="trash-main"><span class="pr-title">${esc(x.paper.title)}</span>
        <span class="pr-meta">${esc(authorsShort(x.paper.authors))}${x.paper.year ? ` · ${x.paper.year}` : ''} · ${STATUS[x.paper.status] || ''}${x.deletedAt ? ` · deleted ${fmtDate(x.deletedAt)}` : ''}${src === 'bin' ? (x.pdf ? ' · PDF' : '') + (x.epub ? ' · EPUB' : '') : ''}</span></div>
        <span class="row"><button class="btn small primary" data-restore="${src}:${i}">Restore</button>${src === 'bin' ? `<button class="btn small danger-ghost" data-forget="${i}" aria-label="Delete forever">✕</button>` : ''}</span></li>`;
    main.innerHTML = `
      <section class="card">
        <p class="muted small">Deleted papers stay here for ${TRASH_DAYS} days, with their files, notes and highlights.</p>
        <ul class="list compact">${items.map((x, i) => row(x, i, 'bin')).join('') || '<li class="muted small">Nothing deleted recently.</li>'}</ul>
      </section>
      ${syncOn ? `<section class="card stack">
        <h3>Find deleted papers in Google Drive</h3>
        <p class="muted small">For papers deleted before this bin existed, or on another device. Google Drive keeps earlier versions of your sync file for about 30 days; this looks through them for papers you no longer have. It brings back details, notes, stars, highlights and reading log, but not PDFs or EPUBs (re-download or remake those).</p>
        <div class="row"><button class="btn" id="tr-drive">Search Drive history</button></div>
        <p class="muted small" id="tr-status"></p>
        <ul class="list compact" id="tr-found"></ul>
      </section>` : ''}`;
    let found = [];
    const restoreFrom = async (key, btn) => {
      const [src, i] = key.split(':');
      const x = src === 'bin' ? items[+i] : found[+i];
      btn.disabled = true;
      const p = await restoreRecords(x);
      if (src === 'bin') {
        const tt = await trashed();
        delete tt[p.id];
        await DB.setSetting('trash', tt);
      }
      btn.closest('li').remove();
      toast(`Restored “${p.title.slice(0, 40)}”`, { label: 'Open', run: () => (location.hash = `#/paper/${p.id}`) });
    };
    const wire = (root) =>
      $$('[data-restore]', root).forEach((b) => b.addEventListener('click', () => restoreFrom(b.dataset.restore, b).catch((err) => toast(err.message))));
    wire(main);
    $$('[data-forget]').forEach((b) =>
      b.addEventListener('click', async () => {
        const x = items[+b.dataset.forget];
        if (!confirm(`Delete “${x.paper.title}” forever?`)) return;
        const tt = await trashed();
        delete tt[x.paper.id];
        await DB.setSetting('trash', tt);
        b.closest('li').remove();
      })
    );
    $('#tr-drive')?.addEventListener('click', async () => {
      const status = $('#tr-status');
      $('#tr-drive').disabled = true;
      status.textContent = 'Looking…';
      try {
        found = await Sync.deletedInHistory((n, of) => (status.textContent = `Looking through version ${n} of ${of}…`));
        const ul = $('#tr-found');
        ul.innerHTML = found.map((x, i) => row(x, i, 'drive')).join('');
        status.textContent = found.length ? `Found ${found.length} paper${found.length > 1 ? 's' : ''} you no longer have.` : 'No deleted papers in Drive’s history.';
        if (found.length > 1) {
          ul.insertAdjacentHTML('beforebegin', '<div class="row" id="tr-all-row"><button class="btn small" id="tr-all">Restore all</button></div>');
          $('#tr-all').addEventListener('click', async () => {
            for (const b of $$('[data-restore^="drive:"]', ul)) await restoreFrom(b.dataset.restore, b);
            $('#tr-all-row').remove();
          });
        }
        wire(ul);
      } catch (err) {
        status.textContent = `Couldn’t search: ${err.message}`;
      }
      $('#tr-drive').disabled = false;
    });
  }

  // ---------- friends ----------
  // Someone's add-me link waits here until this device is signed in.
  const PENDING_ADD = 'paperreads.friend-add';
  const ago = (t) => {
    const d = Math.round((Date.now() - t) / 864e5);
    return d < 1 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : fmtDate(t);
  };
  const feedVerb = (x) => (x.status === 'read' ? (x.rating ? `rated ${'★'.repeat(x.rating)}` : 'finished') : x.status === 'reading' ? 'is reading' : 'wants to read');

  async function viewFriends(q) {
    setTitle('Friends');
    if (q.add) {
      let saved = await Social.config();
      if (!saved && q.c) {
        const c = Social.configFromLink(q.c);
        if (c) {
          await DB.setSetting('firebaseConfig', c);
          saved = c;
        }
      }
      try {
        localStorage.setItem(PENDING_ADD, q.add);
      } catch {}
      history.replaceState(null, '', '#/friends');
    }
    if (!(await Social.config())) {
      main.innerHTML = `<section class="card stack"><p>Friends let you see each other’s shelves and what everyone is reading.</p>
        <p class="muted small">Ask a friend who already uses PaperReads friends for their add-me link, or set it up yourself in <a href="#/settings">Settings → Friends</a>.</p></section>`;
      return;
    }
    main.innerHTML = '<p class="muted">Loading…</p>';
    let pendingAdd = null;
    try {
      pendingAdd = localStorage.getItem(PENDING_ADD);
    } catch {}
    try {
      await Social.init();
    } catch (err) {
      main.innerHTML = `<p class="empty">Couldn’t start friends: ${esc(Social.friendly(err))}</p>`;
      return;
    }
    const u = Social.user;
    if (!u) {
      main.innerHTML = `<section class="card stack">
        ${pendingAdd ? '<p class="note small">You’ve been sent an add-me link. Sign in, and the friend request goes out.</p>' : ''}
        <p>Sign in with Google to add friends. Friends see the papers on your shelves and your stars; nothing else leaves this device.</p>
        <div class="row"><button class="btn primary" id="fr-in">Sign in with Google</button></div>
        <p class="muted small" id="fr-status"></p></section>`;
      $('#fr-in').addEventListener('click', async () => {
        $('#fr-status').textContent = 'Signing in…';
        try {
          await Social.signIn();
          route();
        } catch (err) {
          $('#fr-status').textContent = err.message;
        }
      });
      return;
    }
    if (pendingAdd) {
      try {
        localStorage.removeItem(PENDING_ADD);
      } catch {}
      try {
        const r = await Social.addFriend(pendingAdd);
        toast(r === 'requested' ? 'Friend request sent' : r === 'accepted' ? 'You’re now friends' : r === 'already' ? 'You’re already friends' : 'Friend request already sent');
      } catch (err) {
        toast(err.message);
      }
    }
    let fs = [];
    try {
      fs = await Social.friendships();
    } catch (err) {
      main.innerHTML = `<p class="empty">${esc(Social.friendly(err))}</p>`;
      return;
    }
    Social.publish().catch(() => {});
    const friends = fs.filter((f) => f.status === 'accepted').sort((a, b) => a.name.localeCompare(b.name));
    const incoming = fs.filter((f) => f.incoming);
    const outgoing = fs.filter((f) => f.status === 'pending' && !f.incoming);
    main.innerHTML = `
      <section class="card stack">
        <div class="row between"><span>${u.photoURL ? `<img class="avatar" src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : ''}<b>${esc(u.displayName || 'You')}</b></span><button class="btn small" id="fr-out">Sign out</button></div>
        <div class="row wrap"><button class="btn primary" id="fr-link">Invite a friend</button></div>
        <p class="muted small">Sends your add-me link. When they open it and sign in, you get a friend request to accept here.</p>
      </section>
      ${incoming.length ? `<section class="card"><h3>Friend requests</h3><ul class="list compact">${incoming.map((f) => `<li class="row between"><span>${esc(f.name)}</span><span class="row"><button class="btn small primary" data-accept="${f.id}">Accept</button><button class="btn small danger-ghost" data-drop="${f.id}">Decline</button></span></li>`).join('')}</ul></section>` : ''}
      <section class="card"><h3>Friends</h3>
        <ul class="list compact">${friends.map((f) => `<li class="paper-row"><a class="paper-link" href="#/friend/${encodeURIComponent(f.other)}"><span class="pr-title">${esc(f.name)}</span></a></li>`).join('') || '<li class="muted small">No friends yet. Invite someone above.</li>'}</ul>
        ${outgoing.length ? `<p class="muted small">Waiting for: ${outgoing.map((f) => `${esc(f.name)} <button type="button" class="r-btn" data-drop="${f.id}" aria-label="Cancel request">✕</button>`).join(', ')}</p>` : ''}
      </section>
      ${friends.length ? '<section class="card"><h3>Recent</h3><ul class="list compact" id="fr-feed"><li class="muted small">Loading…</li></ul></section>' : ''}`;

    $('#fr-out').addEventListener('click', async () => {
      await Social.signOut();
      route();
    });
    $('#fr-link').addEventListener('click', async () => {
      const url = await Social.addLink();
      const text = `Add me as a friend on PaperReads, to see what each other are reading.`;
      if (navigator.share) {
        try {
          await navigator.share({ title: 'PaperReads', text, url });
          return;
        } catch {}
      }
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied');
      } catch {
        prompt('Copy this link:', url);
      }
    });
    $$('[data-accept]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await Social.accept(b.dataset.accept);
          toast('You’re now friends');
        } catch (err) {
          toast(Social.friendly(err));
        }
        route();
      })
    );
    $$('[data-drop]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await Social.remove(b.dataset.drop);
        } catch (err) {
          toast(Social.friendly(err));
        }
        route();
      })
    );
    if (friends.length) {
      const items = await Social.feed(friends).catch(() => []);
      const el = $('#fr-feed');
      if (!el) return;
      el.innerHTML =
        items
          .slice(0, 30)
          .map((x) => `<li class="feed-item"><a href="#/friend/${encodeURIComponent(x.uid)}">${esc(x.who)}</a> ${feedVerb(x)} <b>${esc(x.title)}</b> <span class="muted small">${ago(x.updatedAt)}</span></li>`)
          .join('') || '<li class="muted small">Nothing on your friends’ shelves yet.</li>';
    }
  }

  // The link to look a friend's paper up in the Add screen.
  const friendPaperLink = (x) => `#/add?url=${encodeURIComponent(x.doi || (x.arxiv ? `arxiv.org/abs/${x.arxiv}` : x.url || ''))}&title=${encodeURIComponent(x.title || '')}`;
  const sameKey = (x) => (x.doi ? `doi:${x.doi.toLowerCase()}` : x.arxiv ? `arxiv:${x.arxiv.replace(/v\d+$/, '')}` : `t:${(x.title || '').toLowerCase().replace(/\W+/g, '')}`);

  async function viewFriend(uid) {
    setTitle('Friend');
    main.innerHTML = '<p class="muted">Loading…</p>';
    let them, list, mine;
    try {
      await Social.init();
      if (!Social.user) return (location.hash = '#/friends');
      [them, list, mine] = await Promise.all([Social.profile(uid), Social.shelf(uid), papers()]);
    } catch (err) {
      main.innerHTML = `<p class="empty">${esc(Social.friendly(err))}</p><p><a href="#/friends">← Friends</a></p>`;
      return;
    }
    const have = new Map(mine.map((p) => [sameKey(p), p]));
    const name = (them && them.name) || 'Friend';
    setTitle(name);
    const row = (x) => {
      const own = have.get(sameKey(x));
      return `<li class="paper-row friend-paper">
        <div><span class="pr-title">${esc(x.title)}</span>
        <span class="pr-meta">${esc([(x.authors || []).slice(0, 3).join(', ') + ((x.authors || []).length > 3 ? ' et al.' : ''), x.year, x.venue].filter(Boolean).join(' · '))}</span>
        ${x.rating ? `<span class="stars small" aria-label="${x.rating} stars">${'★'.repeat(x.rating)}${'☆'.repeat(5 - x.rating)}</span>` : ''}</div>
        ${own ? `<a class="btn small" href="#/paper/${own.id}">In your library</a>` : `<a class="btn small" href="${esc(friendPaperLink(x))}">＋ Add</a>`}
      </li>`;
    };
    const by = (s) => list.filter((x) => x.status === s);
    const reading = by('reading').sort((a, b) => b.updatedAt - a.updatedAt);
    const want = by('want').sort((a, b) => b.updatedAt - a.updatedAt);
    const read = by('read').sort((a, b) => (b.finishedAt || b.updatedAt) - (a.finishedAt || a.updatedAt));
    const section = (t, xs) => (xs.length ? `<section class="card"><h3>${t} <span class="muted small">${xs.length}</span></h3><ul class="list compact">${xs.map(row).join('')}</ul></section>` : '');
    main.innerHTML =
      `<p><a href="#/friends" class="link small">← Friends</a></p>` +
      (section('Reading', reading) + section('Read', read) + section('Want to read', want) || `<p class="empty">${esc(name)} hasn’t shelved any papers yet.</p>`);
  }

  // An invite link carries the sync client ID and secret in the URL fragment
  // (never sent to a server), so a friend doesn't need Google Cloud at all.
  const encodeInvite = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function decodeInvite(str) {
    try {
      const o = JSON.parse(atob(str.replace(/-/g, '+').replace(/_/g, '/')));
      return o && (/\.apps\.googleusercontent\.com$/.test(o.i) || o.f) ? o : null;
    } catch {
      return null;
    }
  }

  async function viewSettings(q = {}) {
    setTitle('Settings');
    const [key, model, clientId, syncFiles, last, clientSecret, stays, fbConfig] = await Promise.all([
      DB.setting('anthropicKey', ''),
      DB.setting('claudeModel', Ask.DEFAULT_MODEL),
      DB.setting('googleClientId', ''),
      DB.setting('syncFiles', true),
      DB.setting('syncLast', null),
      DB.setting('googleClientSecret', ''),
      Sync.staysSignedIn(),
      Social.config(),
    ]);
    const origin = location.origin;
    const invite = q.invite ? decodeInvite(q.invite) : null;
    // an invite also turns on friends, if the inviter has them
    if (invite && invite.f && !fbConfig) {
      const c = Social.parseConfig(JSON.stringify(invite.f));
      if (c) {
        await DB.setSetting('firebaseConfig', c);
        Social.start();
      }
    }
    const cidValue = invite && !clientId ? invite.i || '' : clientId;
    const secretValue = invite && !clientId ? invite.s || '' : clientSecret;
    main.innerHTML = `
      <section class="card stack">
        <h3>Ask Claude</h3>
        <p class="muted small">Ask about papers on the paper page or in the reader (💬). Uses your own key from
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>: pay-as-you-go, billed separately from a Claude subscription.
          A question costs a few cents. The key stays on this device; questions send the paper’s text to Anthropic.</p>
        <form id="ai-form" class="stack">
          <label>API key <input type="password" name="key" autocomplete="off" placeholder="sk-ant-…" value="${esc(key)}"></label>
          <label>Model <select name="model">${Object.entries(Ask.MODELS).map(([id, m]) => `<option value="${id}"${id === model ? ' selected' : ''}>${m.label} (${m.note})</option>`).join('')}</select></label>
          <div class="row"><button class="btn primary">Save</button><button type="button" class="btn" id="ai-test">Test key</button>${key ? '<button type="button" class="btn danger-ghost" id="ai-forget">Remove key</button>' : ''}</div>
          <p class="muted small" id="ai-status"></p>
        </form>
      </section>
      <section class="card stack">
        <h3>Sync with Google Drive</h3>
        <p class="muted small">Keeps this device and your others (phone, laptop) in step through a hidden app folder in your own Google Drive.
          It syncs when the app opens and shortly after changes. Free: it uses your Drive storage.</p>
        ${invite && !clientId ? '<p class="note small" id="sy-invited">You’ve been invited to sync. Everything is filled in: tap <b>Connect and sync</b> and sign in with <b>your own</b> Google account. Your library goes to your own Drive; nobody else sees it.</p>' : ''}
        <p id="sy-state" class="small"></p>
        <form id="sy-form" class="stack">
          <label>Google client ID <input name="cid" autocomplete="off" placeholder="…apps.googleusercontent.com" value="${esc(cidValue)}"></label>
          <label>Client secret <small class="muted">(lets this device stay signed in instead of asking every hour)</small><input type="password" name="secret" autocomplete="off" placeholder="GOCSPX-…" value="${esc(secretValue)}"></label>
          <label class="check"><input type="checkbox" name="files" ${syncFiles ? 'checked' : ''}> Also sync PDFs and EPUBs (uses more data)</label>
          <div class="row wrap"><button class="btn primary" id="sy-go">${clientId ? 'Sync now' : 'Connect and sync'}</button>${clientId && clientSecret ? '<button type="button" class="btn" id="sy-invite">Invite someone</button>' : ''}${clientId ? '<button type="button" class="btn danger-ghost" id="sy-off">Disconnect</button>' : ''}</div>
        </form>
        ${clientId && clientSecret ? '<p class="muted small">Invite someone: sends a link that sets up sync for them in one tap. They sign in with their own Google account and get their own private library. The link contains your client secret, so send it privately.</p>' : ''}
        <details class="small"><summary>Get a client ID (once, about 10 minutes)</summary>
          <ol class="steps">
            <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud</a> with your Google account and create a project (any name, e.g. PaperReads).</li>
            <li>Turn on the <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">Google Drive API</a> for it.</li>
            <li>Go to <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">Google Auth Platform</a> → Get started: app name PaperReads, your email, audience <b>External</b>.</li>
            <li>Under <b>Audience</b> → Test users, add your own Gmail address.</li>
            <li>Under <b>Clients</b> → Create client: type <b>Web application</b>; under Authorised JavaScript origins add <code>${esc(origin)}</code>, and under Authorised redirect URIs add <code>${esc(Sync.redirectUri())}</code>. Create, then copy the Client ID and the Client secret. (Already made a client? Open it, add the redirect URI, and copy its secret.)</li>
            <li>Under <b>Audience</b>, tap <b>Publish app</b>. Otherwise Google signs you out after 7 days.</li>
            <li>Paste both above and tap Connect. Google will warn that the app isn’t verified: that’s expected for your own app; continue.</li>
            <li>On your other devices, open this app, paste the same client ID here and connect.</li>
          </ol>
        </details>
      </section>
      <section class="card stack">
        <h3>Friends</h3>
        <p class="muted small">Add friends and see what each other are reading, like Goodreads. Shared: the papers on your shelves (title, authors, status, stars, dates). Never shared: notes, concerns, highlights, files, and papers you mark private.
          ${fbConfig ? '<a href="#/friends">Open Friends →</a>' : 'Needs a free Firebase project, set up once by one person; friends then join from an invite link.'}</p>
        <form id="fb-form" class="stack">
          <label>Firebase config <small class="muted">(paste the <code>firebaseConfig</code> snippet)</small><textarea name="cfg" rows="${fbConfig ? 3 : 4}" autocomplete="off" spellcheck="false" placeholder="const firebaseConfig = { apiKey: …, authDomain: …, projectId: … };">${fbConfig ? esc(JSON.stringify(fbConfig, null, 1)) : ''}</textarea></label>
          <div class="row wrap"><button class="btn primary">Save</button>${fbConfig ? '<button type="button" class="btn danger-ghost" id="fb-off">Turn off friends</button>' : ''}</div>
        </form>
        <details class="small"><summary>Set up Firebase (once, about 10 minutes)</summary>
          <ol class="steps">
            <li>Open the <a href="https://console.firebase.google.com/" target="_blank" rel="noopener">Firebase console</a> and <b>Create a project</b>. You can pick your existing Google Cloud project (the one used for sync). Analytics: off.</li>
            <li><b>Build → Authentication</b> → Get started → Sign-in method → <b>Google</b> → Enable → Save.</li>
            <li>Authentication → <b>Settings → Authorised domains</b> → Add <code>${esc(location.hostname)}</code>.</li>
            <li><b>Build → Firestore Database</b> → Create database → <b>Production mode</b>, any location.</li>
            <li>Firestore → <b>Rules</b>: replace everything with the rules below → Publish. They make shelves visible only to accepted friends.</li>
            <li>Project settings (⚙) → Your apps → <b>Web</b> (&lt;/&gt;) → register (any nickname, no hosting). Copy the <code>firebaseConfig</code> snippet, paste it above and Save.</li>
            <li>Invite friends from the Friends page. The link sets everything up for them.</li>
          </ol>
          <div class="row"><button type="button" class="btn small" id="fb-copy">Copy rules</button></div>
          <pre class="conv-log rules">${esc(Social.RULES)}</pre>
          <p class="muted">The Firebase config isn’t a secret: it only names your project. The rules are what protect the data. The free plan covers thousands of reads a day, far more than a group of friends uses.</p>
        </details>
      </section>
      <section class="card">
        <h3>Backup</h3>
        <p class="muted small">A .zip of everything, to keep somewhere safe. <a href="#/backup">Backup and restore →</a></p>
        <p class="muted small">Deleted something by mistake? <a href="#/trash">Recently deleted →</a></p>
      </section>
      <section class="card stack">
        <h3>App version</h3>
        <p class="muted small"><span id="app-ver">…</span>. Updates arrive in the background and apply the next time the app opens.</p>
        <div class="row"><button type="button" class="btn" id="app-update">Check for updates</button></div>
      </section>`;

    const aiStatus = $('#ai-status');
    $('#ai-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await DB.setSetting('anthropicKey', e.target.key.value.trim());
      await DB.setSetting('claudeModel', e.target.model.value);
      aiStatus.textContent = 'Saved.';
    });
    $('#ai-test').addEventListener('click', async () => {
      const f = $('#ai-form');
      await DB.setSetting('anthropicKey', f.key.value.trim());
      await DB.setSetting('claudeModel', f.model.value);
      aiStatus.textContent = 'Checking…';
      try {
        await Ask.test();
        aiStatus.textContent = '✓ The key works.';
      } catch (err) {
        aiStatus.textContent = err.message;
      }
    });
    $('#ai-forget')?.addEventListener('click', async () => {
      await DB.setSetting('anthropicKey', '');
      route();
    });

    const showState = (st) => {
      const el = $('#sy-state');
      if (!el) return;
      el.textContent = st.busy
        ? 'Syncing…'
        : st.error
          ? `Last sync failed: ${st.error}`
          : st.needsSignIn
            ? 'Tap Sync now to sign in to Google again.'
            : st.last
              ? `Last synced ${fmtDate(st.last)} at ${new Date(st.last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.${stays ? ' Stays signed in on this device.' : clientId ? ' Add the client secret to stop the hourly sign-in.' : ''}`
              : clientId
                ? 'Not synced yet.'
                : '';
    };
    showState({ ...Sync.state, last: Sync.state.last || last });
    const unsub = Sync.subscribe(showState);
    teardown = () => unsub();
    if (clientId) Sync.loadGis().catch(() => {}); // ready before the tap, so the sign-in popup isn't blocked

    if (invite && !clientId) $('#sy-invited').scrollIntoView({ block: 'center' });
    $('#sy-invite')?.addEventListener('click', async () => {
      const f = await Social.config();
      const url = `${location.origin}${location.pathname}#/settings?invite=${encodeInvite({ i: clientId, s: clientSecret, ...(f ? { f } : {}) })}`;
      const text = 'Set up PaperReads sync: install the app from this link (Chrome → ⋮ → Add to Home screen), then open the link again and tap Connect.';
      if (navigator.share) {
        try {
          await navigator.share({ title: 'PaperReads', text, url });
          return;
        } catch {}
      }
      try {
        await navigator.clipboard.writeText(url);
        toast('Invite link copied');
      } catch {
        prompt('Copy this invite link:', url);
      }
    });
    $('#sy-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (invite) history.replaceState(null, '', '#/settings'); // don't bring the invite back after Google's sign-in
      const cid = e.target.cid.value.trim();
      if (!/\.apps\.googleusercontent\.com$/.test(cid)) return toast('That doesn’t look like a Google client ID');
      await DB.setSetting('googleClientId', cid);
      const secret = e.target.secret.value.trim();
      if (secret !== clientSecret) await DB.setSetting('googleRefreshToken', ''); // a new secret means signing in again
      await DB.setSetting('googleClientSecret', secret);
      await DB.setSetting('syncFiles', e.target.files.checked);
      try {
        const r = await Sync.run({ interactive: true });
        if (r && !r.skipped) {
          toast(r.changes || r.uploaded ? `Synced: ${r.changes} change(s) here, ${r.uploaded} file(s) uploaded` : 'Synced: everything was up to date');
          Sync.start();
        } else if (r && r.skipped) toast(r.skipped === 'offline' ? 'You’re offline' : `Not synced: ${r.skipped}`);
      } catch (err) {
        toast(`Sync failed: ${err.message}`);
      }
      showSyncButton();
    });
    $('#fb-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const c = Social.parseConfig(e.target.cfg.value);
      if (!c) return toast('That doesn’t look like a Firebase config (it needs apiKey, authDomain and projectId)');
      const same = fbConfig && JSON.stringify(fbConfig) === JSON.stringify(c);
      await DB.setSetting('firebaseConfig', c);
      if (same) return toast('Saved');
      if (fbConfig) return location.reload(); // a different project: start fresh
      Social.start();
      location.hash = '#/friends';
    });
    $('#fb-off')?.addEventListener('click', async () => {
      if (!confirm('Turn off friends on this device? Your shared shelf stays until you remove it from the Friends page.')) return;
      await Social.signOut().catch(() => {});
      await DB.setSetting('firebaseConfig', null);
      location.reload();
    });
    // the version is the name of the offline cache the service worker keeps
    (async () => {
      try {
        const v = Math.max(0, ...(await caches.keys()).map((k) => +(/^paperreads-v(\d+)$/.exec(k) || [])[1] || 0));
        $('#app-ver').textContent = v ? `Version ${v}` : 'Version unknown';
      } catch {
        $('#app-ver').textContent = 'Version unknown';
      }
    })();
    $('#app-update').addEventListener('click', async () => {
      const btn = $('#app-update');
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) throw new Error('offline support isn’t set up in this browser');
        await reg.update();
        const fresh = reg.installing || reg.waiting;
        if (!fresh) {
          btn.textContent = 'Up to date';
          setTimeout(() => {
            btn.textContent = 'Check for updates';
            btn.disabled = false;
          }, 3000);
          return;
        }
        btn.textContent = 'Updating…';
        await new Promise((resolve) => {
          if (fresh.state === 'activated') return resolve();
          fresh.addEventListener('statechange', () => fresh.state === 'activated' && resolve());
          setTimeout(resolve, 15000);
        });
        location.reload();
      } catch (err) {
        btn.textContent = 'Check for updates';
        btn.disabled = false;
        toast(`Couldn’t check: ${err.message}`);
      }
    });
    $('#fb-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(Social.RULES);
        toast('Rules copied');
      } catch {
        prompt('Copy the rules:', Social.RULES);
      }
    });
    $('#sy-off')?.addEventListener('click', async () => {
      if (!confirm('Stop syncing this device? Your data here and in Drive stays as it is.')) return;
      await Sync.disconnect();
      showSyncButton();
      route();
    });
  }

  async function viewBackup() {
    setTitle('Backup');
    const [all, pdfs, epubs, lastBackup] = await Promise.all([papers(), DB.all('pdfs'), DB.all('epubs'), DB.setting('lastBackup', null)]);
    const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    const fileBytes = [...pdfs, ...epubs].reduce((s, r) => s + (r.size || 0) + (r.cover ? r.cover.size : 0), 0);
    let usage = '';
    let persisted = null;
    try {
      const est = await navigator.storage.estimate();
      usage = `${mb(est.usage || 0)} used`;
      persisted = await navigator.storage.persisted();
    } catch {}

    main.innerHTML = `
      <section class="card">
        <h3>On this phone</h3>
        <dl class="kv">
          <dt>Papers</dt><dd>${all.length}</dd>
          <dt>PDFs</dt><dd>${pdfs.length}</dd>
          <dt>EPUBs</dt><dd>${epubs.length}</dd>
          <dt>Files</dt><dd>${mb(fileBytes)}${usage ? ` (${usage} in total)` : ''}</dd>
          <dt>Last backup</dt><dd>${lastBackup ? fmtDate(lastBackup) : 'Never'}</dd>
          ${persisted === null ? '' : `<dt>Auto-clearing</dt><dd>${persisted ? 'Protected: the browser won’t clear it to free space' : 'Not protected. Chrome may clear it if storage runs low, so back up'}</dd>`}
        </dl>
      </section>
      <section class="card">
        <h3>Back up</h3>
        <p class="muted small">Saves one .zip with everything. Keep it somewhere that isn’t this phone: Google Drive, email, a computer.</p>
        <div class="stack">
          <button class="btn primary" id="bk-full">Back up everything (~${mb(fileBytes)})</button>
          <button class="btn" id="bk-data">Data only, without PDFs/EPUBs</button>
        </div>
        <p class="muted small" id="bk-status"></p>
      </section>
      <section class="card">
        <h3>Restore</h3>
        <p class="muted small">Pick a PaperReads backup .zip. You’ll see what’s in it before anything changes.</p>
        <label class="btn">Choose backup file<input type="file" accept=".zip,application/zip" id="rs-file" hidden></label>
        <div id="rs-confirm" class="stack" hidden></div>
      </section>`;

    const status = $('#bk-status');
    const runBackup = async (includeFiles, btn) => {
      $$('#bk-full, #bk-data').forEach((b) => (b.disabled = true));
      status.textContent = 'Packing…';
      try {
        const file = await Backup.exportZip({ includeFiles, onProgress: (n, t) => (status.textContent = `Packing files ${n}/${t}…`) });
        status.textContent = `Made ${file.name} (${mb(file.size)}).`;
        await shareOrSave(file, 'PaperReads backup');
      } catch (err) {
        status.textContent = 'Backup failed: ' + err.message;
      }
      $$('#bk-full, #bk-data').forEach((b) => (b.disabled = false));
    };
    $('#bk-full').addEventListener('click', (e) => runBackup(true, e.target));
    $('#bk-data').addEventListener('click', (e) => runBackup(false, e.target));

    const input = $('#rs-file');
    const box = $('#rs-confirm');
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      box.hidden = false;
      box.innerHTML = '<p class="muted small">Reading backup…</p>';
      let info;
      try {
        info = await Backup.inspect(file);
      } catch (err) {
        box.innerHTML = `<p class="small">✗ ${esc(err.message)}</p>`;
        return;
      }
      box.innerHTML = `
        <p class="small">Backup from <strong>${fmtDate(Date.parse(info.exportedAt))}</strong>: ${info.papers} papers, ${info.pdfs} PDFs, ${info.epubs} EPUBs${info.includesFiles ? '' : ' (data-only backup)'}.</p>
        <button class="btn primary" data-mode="merge">Merge into my library</button>
        <p class="muted small">Adds what’s missing. For papers in both, the more recently edited copy wins.</p>
        <button class="btn danger" data-mode="replace">Replace my library</button>
        <p class="muted small">Deletes everything here first, then restores the backup exactly.</p>
        <p class="small" id="rs-status"></p>`;
      $$('[data-mode]', box).forEach((b) =>
        b.addEventListener('click', async () => {
          const mode = b.dataset.mode;
          if (mode === 'replace' && all.length && !confirm(`Delete all ${all.length} papers here and replace them with the backup?`)) return;
          $$('[data-mode]', box).forEach((x) => (x.disabled = true));
          const st = $('#rs-status');
          st.textContent = 'Restoring…';
          try {
            const res = await Backup.restore(file, mode, (n, t) => (st.textContent = `Restoring files ${n}/${t}…`));
            toast(`Restored ${res.papers} papers, ${res.files} files`);
            location.hash = '#/library';
          } catch (err) {
            st.textContent = '✗ Restore failed: ' + err.message;
            $$('[data-mode]', box).forEach((x) => (x.disabled = false));
          }
        })
      );
    });
  }

  async function viewCollections() {
    setTitle('Collections & tags');
    const [cols, all, tagCounts] = await Promise.all([DB.all('collections'), papers(), allTags()]);
    const count = (cid) => all.filter((p) => (p.collections || []).includes(cid)).length;
    main.innerHTML = `
      <section class="card"><a class="paper-link" href="#/trails"><span class="pr-title">🌳 Discovery trails</span><span class="pr-meta">Which papers led you to which</span></a></section>
      <section class="card">
        <h3>Collections</h3>
        <ul class="list compact">${cols
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => `<li class="paper-row"><a class="paper-link" href="#/library?col=${c.id}"><span class="pr-title">📁 ${esc(c.name)}</span><span class="pr-meta">${count(c.id)} papers</span></a>
            <span class="q-actions"><button class="btn small" data-rename="${c.id}">Rename</button><button class="btn small danger-ghost" data-delc="${c.id}">Delete</button></span></li>`)
          .join('') || '<li class="muted small">No collections yet.</li>'}</ul>
        <form id="col-form" class="row"><input name="name" placeholder="New collection" required><button class="btn primary">Add</button></form>
      </section>
      <section class="card">
        <h3>Tags</h3>
        <ul class="list compact">${Object.entries(tagCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([t, n]) => `<li class="paper-row"><a class="paper-link" href="#/library?tag=${encodeURIComponent(t)}"><span class="pr-title">#${esc(t)}</span><span class="pr-meta">${n} papers</span></a>
            <span class="q-actions"><button class="btn small" data-rentag="${esc(t)}">Rename</button><button class="btn small danger-ghost" data-deltag="${esc(t)}">Delete</button></span></li>`)
          .join('') || '<li class="muted small">Add tags from a paper’s page.</li>'}</ul>
      </section>`;

    $('#col-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await DB.put('collections', { id: uid(), name: e.target.name.value.trim(), createdAt: now() });
      viewCollections();
    });
    $$('[data-rename]').forEach((b) =>
      b.addEventListener('click', async () => {
        const c = await DB.get('collections', b.dataset.rename);
        const name = prompt('Rename collection', c.name);
        if (!name || !name.trim()) return;
        c.name = name.trim();
        await DB.put('collections', c);
        viewCollections();
      })
    );
    $$('[data-delc]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Delete this collection? Papers stay in your library.')) return;
        const cid = b.dataset.delc;
        await DB.del('collections', cid);
        const changed = all.filter((p) => (p.collections || []).includes(cid));
        changed.forEach((p) => (p.collections = p.collections.filter((x) => x !== cid)));
        await DB.putMany('papers', changed);
        viewCollections();
      })
    );
    const retag = async (from, to) => {
      const changed = all.filter((p) => (p.tags || []).includes(from));
      changed.forEach((p) => (p.tags = [...new Set(p.tags.map((t) => (t === from ? to : t)).filter(Boolean))]));
      await DB.putMany('papers', changed);
      viewCollections();
    };
    $$('[data-rentag]').forEach((b) =>
      b.addEventListener('click', () => {
        const name = prompt('Rename tag (renaming to an existing tag merges them)', b.dataset.rentag);
        if (name && name.trim()) retag(b.dataset.rentag, name.trim().replace(/^#/, ''));
      })
    );
    $$('[data-deltag]').forEach((b) =>
      b.addEventListener('click', () => {
        if (confirm(`Remove #${b.dataset.deltag} from all papers?`)) retag(b.dataset.deltag, '');
      })
    );
  }

  // ---------- stats ----------
  function streaks(days) {
    const set = new Set(days);
    const dayMs = 86400000;
    const key = (t) => localDate(new Date(t));
    let current = 0;
    let t = Date.now();
    if (!set.has(key(t))) t -= dayMs; // today not logged yet doesn't break the streak
    while (set.has(key(t))) {
      current++;
      t -= dayMs;
    }
    let longest = 0;
    let run = 0;
    let prev = null;
    for (const d of [...set].sort()) {
      const [y, m, dd] = d.split('-').map(Number);
      const ts = new Date(y, m - 1, dd).getTime();
      run = prev !== null && Math.round((ts - prev) / dayMs) === 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = ts;
    }
    return { current, longest };
  }

  function monthChart(counts, year) {
    const W = 340, H = 150, padL = 24, padB = 22, padT = 10;
    const max = Math.max(1, ...counts);
    const slot = (W - padL) / 12;
    const bw = Math.min(18, slot - 6);
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);
    const ticks = [...new Set([0, Math.ceil(max / 2), max])];
    const bars = counts
      .map((c, i) => {
        const x = padL + i * slot + (slot - bw) / 2;
        const top = y(c);
        const base = H - padB;
        const r = Math.min(4, (base - top) / 2, bw / 2);
        const path = c
          ? `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z`
          : '';
        return `<g class="bar-g" data-tip="${MONTHS[i]} ${year}: ${c} paper${c === 1 ? '' : 's'}" tabindex="0">
          <rect class="hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${H - padT}" />
          ${path ? `<path class="mark" d="${path}" />` : ''}
          <text class="axis-label" x="${padL + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${MONTHS[i][0]}</text>
        </g>`;
      })
      .join('');
    const grid = ticks
      .map((t) => `<line class="grid" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" /><text class="axis-label" x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`)
      .join('');
    return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Papers finished per month in ${year}">${grid}${bars}</svg><div class="tooltip" hidden></div></div>`;
  }

  async function viewStats(q) {
    setTitle('Stats');
    const year = Number(q.year) || new Date().getFullYear();
    const [all, log] = await Promise.all([papers(), DB.all('progress')]);
    const goal = await DB.setting('goal:' + year, 0);
    const finished = all.filter((p) => p.status === 'read' && p.finishedAt && new Date(p.finishedAt).getFullYear() === year);
    const counts = Array(12).fill(0);
    finished.forEach((p) => counts[new Date(p.finishedAt).getMonth()]++);
    const yearLog = log.filter((e) => e.date.startsWith(String(year)));
    const pagesRead = yearLog.reduce((s, e) => s + Math.max(0, e.delta || 0), 0);
    const { current, longest } = streaks(log.map((e) => e.date));
    const rated = finished.filter((p) => p.rating);
    const avgRating = rated.length ? (rated.reduce((s, p) => s + p.rating, 0) / rated.length).toFixed(1) : '–';
    const isThisYear = year === new Date().getFullYear();
    const dayOfYear = Math.floor((Date.now() - new Date(year, 0, 1)) / 86400000) + 1;
    const expected = goal && isThisYear ? Math.round((goal * dayOfYear) / 365) : 0;
    const topTags = {};
    finished.forEach((p) => (p.tags || []).forEach((t) => (topTags[t] = (topTags[t] || 0) + 1)));

    main.innerHTML = `
      <div class="row between year-nav">
        <a class="btn small" href="#/stats?year=${year - 1}" aria-label="Previous year">←</a>
        <h2>${year}</h2>
        <a class="btn small${isThisYear ? ' disabled' : ''}" href="#/stats?year=${year + 1}" aria-label="Next year">→</a>
      </div>
      <section class="card">
        <h3>Reading goal</h3>
        ${goal ? `<p class="big">${finished.length} <small>of ${goal} papers</small></p>
          <div class="bar"><span style="width:${Math.min(100, (finished.length / goal) * 100).toFixed(1)}%"></span></div>
          ${isThisYear ? `<p class="muted small">${finished.length >= expected ? `On track (${finished.length - expected} ahead of pace)` : `${expected - finished.length} behind pace`}</p>` : ''}` : '<p class="muted">No goal set for this year.</p>'}
        <form id="goal" class="row"><input type="number" name="goal" min="0" inputmode="numeric" placeholder="Papers this year" value="${goal || ''}" aria-label="Goal"><button class="btn">Set goal</button></form>
      </section>
      <div class="tiles">
        <div class="tile"><span class="tile-v">${finished.length}</span><span class="tile-l">papers read</span></div>
        <div class="tile"><span class="tile-v">${pagesRead.toLocaleString()}</span><span class="tile-l">pages read</span></div>
        <div class="tile"><span class="tile-v">${current}</span><span class="tile-l">day streak</span></div>
        <div class="tile"><span class="tile-v">${longest}</span><span class="tile-l">longest streak</span></div>
        <div class="tile"><span class="tile-v">${avgRating}</span><span class="tile-l">avg rating</span></div>
        <div class="tile"><span class="tile-v">${all.filter((p) => p.status === 'want').length}</span><span class="tile-l">in queue</span></div>
      </div>
      <section class="card">
        <h3>Papers finished per month</h3>
        ${monthChart(counts, year)}
        <details><summary class="small">Show as table</summary>
          <table class="table"><thead><tr><th>Month</th><th>Papers</th></tr></thead><tbody>${counts.map((c, i) => `<tr><td>${MONTHS[i]}</td><td>${c}</td></tr>`).join('')}</tbody></table>
        </details>
      </section>
      ${Object.keys(topTags).length ? `<section class="card"><h3>Top tags this year</h3><div class="tags">${Object.entries(topTags).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, n]) => `<a class="tag" href="#/library?tag=${encodeURIComponent(t)}">#${esc(t)} · ${n}</a>`).join('')}</div></section>` : ''}
      ${finished.length ? `<section><h2 class="section-h">Read in ${year}</h2><ul class="list">${finished.sort((a, b) => b.finishedAt - a.finishedAt).map((p) => paperRow(p)).join('')}</ul></section>` : ''}
    `;

    $('#goal').addEventListener('submit', async (e) => {
      e.preventDefault();
      await DB.setSetting('goal:' + year, parseInt(e.target.goal.value, 10) || 0);
      toast('Goal saved');
      viewStats(q);
    });

    const wrap = $('.chart-wrap');
    const tip = $('.tooltip', wrap);
    const show = (g) => {
      $$('.bar-g', wrap).forEach((x) => x.classList.toggle('active', x === g));
      tip.textContent = g.dataset.tip;
      tip.hidden = false;
      const r = g.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      tip.style.left = `${Math.min(wr.width - 120, Math.max(0, r.left - wr.left + r.width / 2 - 60))}px`;
    };
    $$('.bar-g', wrap).forEach((g) => {
      g.addEventListener('pointerenter', () => show(g));
      g.addEventListener('click', () => show(g));
      g.addEventListener('focus', () => show(g));
    });
    wrap.addEventListener('pointerleave', () => {
      tip.hidden = true;
      $$('.bar-g', wrap).forEach((x) => x.classList.remove('active'));
    });
  }

  // ---------- boot ----------
  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => $('#offline').hidden = true);
  window.addEventListener('offline', () => $('#offline').hidden = false);
  $('#offline').hidden = navigator.onLine;

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
  // Ask the browser not to evict our data under storage pressure.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // Sync: a top-bar button shows its state; tapping it syncs (and signs in if needed).
  async function showSyncButton() {
    const btn = $('#sync-btn');
    btn.hidden = !(await DB.setting('googleClientId', ''));
  }
  Sync.subscribe((st) => {
    const btn = $('#sync-btn');
    btn.classList.toggle('spin', st.busy);
    btn.classList.toggle('attn', !st.busy && (st.needsSignIn || !!st.error));
    btn.title = st.busy ? 'Syncing…' : st.error ? `Sync failed: ${st.error}` : st.needsSignIn ? 'Tap to sync' : 'Sync now';
  });
  $('#sync-btn').addEventListener('click', () =>
    Sync.run({ interactive: true })
      .then((r) => r && !r.skipped && toast(r.changes ? `Synced: ${r.changes} change(s)` : 'Synced'))
      .catch((err) => toast(`Sync failed: ${err.message}`))
  );
  // Fresh data from another device: redraw list-like views (never a form or the reader).
  Sync.onSignedIn = () => {
    toast('Signed in to Google. This device stays signed in');
    if (/^#\/settings/.test(location.hash)) route();
  };
  Sync.onApplied = (result) => {
    if (/^#\/read\//.test(location.hash)) return readerSync && readerSync(result);
    if (!result.changes) return;
    if (/^(#\/?|#\/(library|queue|stats|collections))?$/.test(location.hash.split('?')[0]) || /^#\/paper\//.test(location.hash)) route();
  };

  DB.open().then(() => {
    route();
    showSyncButton();
    Sync.start();
    DB.onPapersChange = () => Social.schedule();
    Social.start();
  });
})();

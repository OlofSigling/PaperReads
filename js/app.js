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

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2600);
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
          ${(p.tags || []).slice(0, 3).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}
        </span>
      </a>${extra}
    </li>`;
  }

  // ---------- data ops ----------
  async function papers() {
    return DB.all('papers');
  }

  async function savePaper(p) {
    p.updatedAt = now();
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
    let finished = false;
    if ((p.status === 'want' || p.status === 'none') && pct(p) > 0) await setStatus(p, 'reading', true);
    if (pct(p) >= 1 && p.status !== 'read') {
      await setStatus(p, 'read', true);
      finished = true;
    }
    await savePaper(p);
    return finished;
  }

  async function setStatus(p, status, skipSave) {
    const prev = p.status;
    p.status = status;
    if (status === 'reading' && !p.startedAt) p.startedAt = now();
    if (status === 'want' && prev !== 'want') p.queueOrder = await nextQueueOrder();
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

  async function deletePaper(id) {
    await DB.del('papers', id);
    await DB.del('pdfs', id);
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
    [/^#\/add$/, (q) => viewEdit(null, q)],
    [/^#\/edit\/(.+)$/, (q, id) => viewEdit(id, q)],
    [/^#\/paper\/(.+)$/, (q, id) => viewPaper(id)],
  ];

  async function route() {
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
    const queue = all.filter((p) => p.status === 'want').sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0)).slice(0, 3);
    const recent = all.filter((p) => p.status === 'read').sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)).slice(0, 3);

    if (!all.length) {
      main.innerHTML = `<section class="empty-hero">
        <h2>Your paper shelf is empty</h2>
        <p>Add a paper by DOI, arXiv link or title, or install the app and share a link to it from your browser.</p>
        <a class="btn primary" href="#/add">Add a paper</a>
      </section>`;
      return;
    }

    main.innerHTML = `
      <section class="card goal-card">
        <div class="row between"><h2>${year} goal</h2><a href="#/stats" class="link">Stats →</a></div>
        ${goal ? `<p class="big">${done} <small>of ${goal} papers</small></p>
          <div class="bar"><span style="width:${Math.min(100, (done / goal) * 100).toFixed(1)}%"></span></div>`
          : `<p class="big">${done} <small>papers read this year</small></p><a href="#/stats" class="link">Set a reading goal</a>`}
      </section>
      <section>
        <h2 class="section-h">Currently reading</h2>
        ${reading.length ? `<ul class="list">${reading.map((p) => paperRow(p, `<button class="btn small" data-quick="${p.id}">Update</button>`)).join('')}</ul>` : '<p class="empty">Nothing in progress. Pick something from your queue.</p>'}
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
      const finished = await logProgress(p, Number(num.value), isPct);
      toast(finished ? '🎉 Finished! Marked as read' : 'Progress saved');
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
    `;
    $('#search').addEventListener('submit', (e) => {
      e.preventDefault();
      location.hash = link({ q: e.target.q.value.trim() });
    });
    $('#f-col').addEventListener('change', (e) => (location.hash = link({ col: e.target.value })));
    $('#f-tag').addEventListener('change', (e) => (location.hash = link({ tag: e.target.value })));
    $('#f-sort').addEventListener('change', (e) => (location.hash = link({ sort: e.target.value })));
  }

  async function viewQueue() {
    setTitle('Want to read');
    const list = (await papers()).filter((p) => p.status === 'want').sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0));
    if (!list.length) {
      main.innerHTML = '<p class="empty">Your queue is empty. Papers marked “Want to read” show up here in priority order.</p>';
      return;
    }
    main.innerHTML = `<p class="muted">Drag ☰ to reorder. The top paper is your “next up”.</p>
      <ul class="list queue" id="queue">${list
        .map((p, i) => `<li class="paper-row q-item" data-id="${p.id}">
          <span class="handle" aria-label="Drag to reorder">☰</span>
          <span class="q-num">${i + 1}</span>
          <a href="#/paper/${p.id}" class="paper-link"><span class="pr-title">${esc(p.title)}</span><span class="pr-meta">${esc(authorsShort(p.authors))}${p.year ? ` · ${p.year}` : ''}</span></a>
          <span class="q-actions">
            <button class="btn small icon" data-top="${p.id}" aria-label="Move to top" title="Move to top">⤒</button>
            <button class="btn small" data-start="${p.id}">Start</button>
          </span>
        </li>`)
        .join('')}</ul>`;

    const ul = $('#queue');
    const persist = async () => {
      const ids = $$('.q-item', ul).map((li) => li.dataset.id);
      const byId = Object.fromEntries(list.map((p) => [p.id, p]));
      ids.forEach((id, i) => (byId[id].queueOrder = i + 1));
      await DB.putMany('papers', Object.values(byId));
      $$('.q-num', ul).forEach((el, i) => (el.textContent = i + 1));
    };

    // Pointer-based drag so it works with touch without a library.
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
      const items = $$('.q-item', ul).filter((li) => li !== dragging);
      const after = items.find((li) => {
        const r = li.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      if (after) ul.insertBefore(dragging, after);
      else ul.appendChild(dragging);
      if (e.clientY < 80) window.scrollBy(0, -8);
      if (e.clientY > window.innerHeight - 100) window.scrollBy(0, 8);
    });
    const end = () => {
      if (!dragging) return;
      dragging.classList.remove('dragging');
      dragging = null;
      persist();
    };
    ul.addEventListener('pointerup', end);
    ul.addEventListener('pointercancel', end);

    $$('[data-top]').forEach((b) =>
      b.addEventListener('click', async () => {
        ul.prepend(b.closest('li'));
        await persist();
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

  async function viewPaper(id) {
    const p = await DB.get('papers', id);
    if (!p) {
      main.innerHTML = '<p class="empty">Paper not found.</p>';
      return;
    }
    setTitle('Paper');
    const [cols, highlights, linksFrom, linksTo, pdf, log, all, tagCounts] = await Promise.all([
      DB.all('collections'),
      DB.byIndex('highlights', 'paperId', id),
      DB.byIndex('links', 'fromId', id),
      DB.byIndex('links', 'toId', id),
      DB.get('pdfs', id),
      DB.byIndex('progress', 'paperId', id),
      papers(),
      allTags(),
    ]);
    const byId = Object.fromEntries(all.map((x) => [x.id, x]));
    const related = [
      ...linksFrom.map((l) => ({ l, other: byId[l.toId], label: LINK_TYPES[l.type] })),
      ...linksTo.map((l) => ({ l, other: byId[l.fromId], label: LINK_INVERSE[l.type] })),
    ].filter((r) => r.other);
    const isPct = !p.totalPages;

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
        </section>

        <section class="card">
          <h3>PDF</h3>
          ${pdf ? `<p class="muted small">${esc(pdf.name)} · ${(pdf.size / 1048576).toFixed(1)} MB, stored on this phone</p>
            <div class="row wrap"><button class="btn primary" id="pdf-open">Open</button><button class="btn" id="pdf-share">Open with…</button><button class="btn danger-ghost" id="pdf-del">Remove</button></div>`
          : `<div class="row wrap">
              <label class="btn">Attach PDF<input type="file" accept="application/pdf" id="pdf-file" hidden></label>
              ${p.arxiv ? '<button class="btn" id="pdf-arxiv">Download from arXiv</button>' : ''}
            </div>`}
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
            .map((h) => `<li><blockquote>${esc(h.quote)}</blockquote>${h.page ? `<span class="muted small">p. ${h.page}</span>` : ''}${h.note ? `<p class="small">${esc(h.note)}</p>` : ''}<button class="btn small danger-ghost" data-delh="${h.id}">Delete</button></li>`)
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
      const finished = await logProgress(p, Number(e.target.v.value), !p.totalPages);
      toast(finished ? '🎉 Finished! Marked as read' : 'Progress saved');
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
    if (pdf) {
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

    main.innerHTML = `
      ${existing ? '' : `<section class="card">
        <form id="lookup" class="stack">
          <label>DOI, arXiv ID, link or title
            <input name="q" placeholder="e.g. 10.1038/nature14539 or arxiv.org/abs/1706.03762" value="${esc(shared || '')}" autocomplete="off">
          </label>
          <button class="btn primary">Look up</button>
          <p class="muted small" id="lookup-status">${inbox && inbox.file ? `Shared PDF: ${esc(inbox.file.name)}. It will be attached when you save.` : 'Fills in the details automatically (needs internet).'}</p>
          <ul class="list compact" id="results"></ul>
        </form>
      </section>`}
      <form id="edit" class="stack card">
        <p class="muted small" id="dupe" hidden></p>
        <label>Title <input name="title" required value="${esc(p.title || sharedTitle)}"></label>
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
        ${!(inbox && inbox.file) ? `<label class="check"><input type="checkbox" name="getpdf" checked> Save arXiv PDF for offline reading</label>` : ''}`}
        <div class="row end"><a class="btn" href="${existing ? `#/paper/${p.id}` : '#/'}">Cancel</a><button class="btn primary">${existing ? 'Save' : 'Add paper'}</button></div>
      </form>`;

    const form = $('#edit');
    const fill = (meta) => {
      for (const k of ['title', 'year', 'venue', 'doi', 'arxiv', 'url', 'abstract', 'totalPages']) if (meta[k]) form[k].value = meta[k];
      if (meta.authors && meta.authors.length) form.authors.value = meta.authors.join('\n');
      checkDupe();
    };
    const checkDupe = async () => {
      const doi = form.doi.value.trim().toLowerCase();
      const ax = form.arxiv.value.trim().toLowerCase();
      const title = form.title.value.trim().toLowerCase();
      const dupe = (await papers()).find(
        (x) => x.id !== p.id && ((doi && (x.doi || '').toLowerCase() === doi) || (ax && (x.arxiv || '').toLowerCase() === ax) || (title && (x.title || '').toLowerCase() === title))
      );
      const el = $('#dupe');
      el.hidden = !dupe;
      if (dupe) el.innerHTML = `⚠️ Already in your library: <a href="#/paper/${dupe.id}">${esc(dupe.title)}</a>`;
    };
    form.doi.addEventListener('change', checkDupe);
    form.title.addEventListener('change', checkDupe);

    const lookup = $('#lookup');
    if (lookup) {
      const status = $('#lookup-status');
      const run = async () => {
        const input = lookup.q.value.trim();
        if (!input) return;
        $('#results').innerHTML = '';
        if (!navigator.onLine) {
          status.textContent = 'Offline: fill in the details by hand. You can edit them later.';
          const ids = Lookup.parse(input);
          fill({ doi: ids.doi, arxiv: ids.arxiv, url: ids.url || (ids.arxiv ? `https://arxiv.org/abs/${ids.arxiv}` : '') });
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
          // No identifier: search Crossref by title (use shared page title if we have it).
          const q2 = ids.url ? sharedTitle || input.replace(ids.url, '').trim() : input;
          if (!q2) {
            status.textContent = 'No DOI or arXiv ID in that link. Paste the title to search, or fill in by hand.';
            return;
          }
          const results = await Lookup.search(q2);
          status.textContent = results.length ? 'Pick the matching paper:' : 'Nothing found. Fill in by hand.';
          $('#results').innerHTML = results
            .map((r, i) => `<li class="paper-row"><button type="button" class="paper-link plain" data-i="${i}"><span class="pr-title">${esc(r.title)}</span><span class="pr-meta">${esc(authorsShort(r.authors))}${r.year ? ` · ${r.year}` : ''}${r.venue ? ` · ${esc(r.venue)}` : ''}</span></button></li>`)
            .join('');
          $$('#results [data-i]').forEach((b) =>
            b.addEventListener('click', async () => {
              const r = results[b.dataset.i];
              $('#results').innerHTML = '';
              status.textContent = 'Fetching details…';
              try {
                fill({ ...(await Lookup.byDoi(r.doi)), url: form.url.value || null });
              } catch {
                fill(r);
              }
              status.textContent = 'Check the details and save.';
            })
          );
        } catch (err) {
          status.textContent = `Lookup failed (${err.message}). Fill in by hand.`;
        }
      };
      lookup.addEventListener('submit', (e) => {
        e.preventDefault();
        run();
      });
      if (shared) run();
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
      });
      await savePaper(p);
      await setStatus(p, f.status.value);
      if (inbox) await DB.del('inbox', inbox.id);
      if (inbox && inbox.file) {
        await attachPdf(p.id, inbox.file);
      } else if (p.arxiv && f.getpdf && f.getpdf.checked && navigator.onLine) {
        // Fire and forget so saving feels instant.
        Lookup.fetchArxivPdf(p.arxiv)
          .then((file) => attachPdf(p.id, file))
          .then(() => {
            toast('arXiv PDF saved offline');
            if (location.hash === `#/paper/${p.id}`) route();
          })
          .catch(() => toast('Could not download the PDF'));
      }
      toast('Added to your library');
      location.hash = `#/paper/${p.id}`;
    });
  }

  async function viewCollections() {
    setTitle('Collections & tags');
    const [cols, all, tagCounts] = await Promise.all([DB.all('collections'), papers(), allTags()]);
    const count = (cid) => all.filter((p) => (p.collections || []).includes(cid)).length;
    main.innerHTML = `
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

  DB.open().then(route);
})();

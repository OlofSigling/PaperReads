// Supplementary material: supplementary figures, tables, data and files.
// Fetched from Europe PMC for papers in PubMed Central (its full text names
// each file, with label and caption; one download gives the files), or added
// by hand. Kept on this device, linked from mentions in the text.
const Supp = (() => {
  const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
  const MAX_ZIP = 250e6;
  const TYPES = {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', png: 'image/png', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
    csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip', mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    html: 'text/html', xml: 'application/xml', json: 'application/json', r: 'text/plain', py: 'text/plain',
  };
  const ext = (name) => (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1]?.toLowerCase() || '';
  const typeOf = (name) => TYPES[ext(name)] || 'application/octet-stream';

  // What a label refers to, as keys that mentions in the text are matched by:
  // "S3 Fig" / "Figure S3" / "Supplementary Figure 3" → fig:3,
  // "Additional file 2" → file:2, "Figure 2—figure supplement 1" → figsupp:2:1.
  const KIND = (k) => {
    k = k.toLowerCase().replace(/s$/, '');
    if (/^fig/.test(k)) return 'fig';
    if (/^table/.test(k)) return 'table';
    if (/^(data|dataset)$/.test(k)) return 'data';
    if (/^(movie|video|audio)$/.test(k)) return 'video';
    return 'file'; // file, text, material, information, note, appendix, checklist, method
  };
  const WORD = 'fig(?:ure)?s?\\.?|tables?|files?|texts?|data(?:sets?)?|movies?|videos?|audios?|appendi(?:x|ces)|materials?|notes?|methods?|checklists?|information';
  function keysOf(label) {
    const t = String(label || '').replace(/[–—]/g, '-').replace(/\s+/g, ' ');
    const keys = new Set();
    let m;
    const re = (src) => new RegExp(src, 'gi');
    for (m of t.matchAll(re(`\\b(fig(?:ure)?|table)\\.?\\s*(\\d+)\\s*-\\s*(?:figure\\s*)?supplement\\s*(\\d+)`))) keys.add(`${KIND(m[1]) === 'table' ? 'tablesupp' : 'figsupp'}:${m[2]}:${m[3]}`);
    for (m of t.matchAll(re(`\\b(fig(?:ure)?|table)\\.?\\s*(\\d+)\\s*-\\s*source\\s*data\\s*(\\d+)`))) keys.add(`srcdata:${m[2]}:${m[3]}`);
    for (m of t.matchAll(re(`\\bS(\\d+)\\s+(${WORD})\\b`))) keys.add(`${KIND(m[2])}:${m[1]}`);
    for (m of t.matchAll(re(`\\b(${WORD})\\s+S(\\d+)\\b`))) keys.add(`${KIND(m[1])}:${m[2]}`);
    for (m of t.matchAll(re(`\\badditional\\s+(?:data\\s+)?files?\\s*(\\d+)`))) keys.add(`file:${m[1]}`);
    for (m of t.matchAll(re(`\\bsupplement(?:al|ary)\\s+(${WORD})\\s*(\\d+)`))) keys.add(`${KIND(m[1])}:${m[2]}`);
    return [...keys];
  }
  // mentions in the text that point at supplementary material
  const MENTION = new RegExp(
    [
      `\\b(?:fig(?:ure)?|table)\\.?\\s*\\d+\\s*[-–—]\\s*(?:figure\\s*)?(?:supplement|source\\s*data)\\s*\\d+`,
      `\\bS\\d+\\s+(?:${WORD})\\b`,
      `\\b(?:supplement(?:al|ary)\\s+)?(?:${WORD})\\s+S\\d+\\b`,
      `\\badditional\\s+(?:data\\s+)?files?\\s*\\d+`,
      `\\bsupplement(?:al|ary)\\s+(?:${WORD})(?:\\s*\\d+)?`,
    ].join('|'),
    'gi'
  );

  async function pmcidFor(p) {
    if (p.pmcid) return p.pmcid;
    const pm = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/.exec(p.url || '');
    const q = p.doi ? `DOI:"${p.doi}"` : pm ? `EXT_ID:${pm[1]} AND SRC:MED` : null;
    if (!q) return null;
    const res = await fetch(`${EPMC}/search?query=${encodeURIComponent(q)}&format=json&resultType=lite`);
    if (!res.ok) return null;
    const r = (((await res.json()).resultList || {}).result || [])[0];
    return (r && r.pmcid) || null;
  }

  // The supplementary items the article lists (labels, captions, file names).
  async function listed(pmcid) {
    const res = await fetch(`${EPMC}/${pmcid}/fullTextXML`);
    if (!res.ok) return [];
    const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
    const XL = 'http://www.w3.org/1999/xlink';
    // (a caption's title and paragraphs, with spaces between them)
    const text = (el) => (el ? (el.children.length && [...el.children].every((c) => /^(title|p|sec|list)$/.test(c.localName)) ? [...el.children].map((c) => c.textContent).join(' ') : el.textContent).replace(/\s+/g, ' ').trim() : '');
    const href = (el) => (el ? el.getAttributeNS(XL, 'href') || el.getAttribute('xlink:href') || '' : '');
    const out = [];
    for (const sm of xml.querySelectorAll('supplementary-material')) {
      const media = sm.querySelector('media, graphic, inline-supplementary-material');
      const file = href(media) || href(sm);
      if (!file) continue;
      const cap = sm.querySelector('caption');
      out.push({ id: sm.getAttribute('id') || '', label: text(sm.querySelector('label')) || text(cap && cap.querySelector('title')) || file, caption: text(cap), href: file });
    }
    // figure supplements (eLife and others): figures marked as children
    for (const fig of xml.querySelectorAll('fig')) {
      const label = text(fig.querySelector(':scope > label'));
      if (!/supplement/i.test(label) && fig.getAttribute('specific-use') !== 'child-fig') continue;
      const file = href(fig.querySelector('graphic'));
      if (!file) continue;
      out.push({ id: fig.getAttribute('id') || '', label, caption: text(fig.querySelector(':scope > caption')), href: file });
    }
    return out;
  }

  // Download Europe PMC's bundle of the article's files, with a size cap.
  async function bundle(pmcid, signal, progress) {
    const res = await fetch(`${EPMC}/${pmcid}/supplementaryFiles`, { signal });
    if (!res.ok) throw new Error(`Europe PMC answered ${res.status}`);
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > MAX_ZIP) {
        reader.cancel();
        throw new Error('the supplementary files are too large to keep on the phone');
      }
      parts.push(value);
      progress(got);
    }
    return new Blob(parts, { type: 'application/zip' });
  }

  // A download Europe PMC cut short: the files that arrived whole are still
  // there, each behind its own header. Read them one by one.
  async function salvage(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    const files = {};
    const find = (sig, from) => {
      for (let i = from; i + 4 <= buf.length; i++) if (dv.getUint32(i, true) === sig) return i;
      return -1;
    };
    let i = 0;
    while ((i = find(0x04034b50, i)) >= 0) {
      const flags = dv.getUint16(i + 6, true);
      const method = dv.getUint16(i + 8, true);
      let size = dv.getUint32(i + 18, true);
      const nameLen = dv.getUint16(i + 26, true);
      const extraLen = dv.getUint16(i + 28, true);
      const name = new TextDecoder().decode(buf.subarray(i + 30, i + 30 + nameLen));
      const start = i + 30 + nameLen + extraLen;
      // streamed entries give their size after the data
      if (flags & 8 || !size) {
        const next = find(0x04034b50, start);
        const desc = find(0x08074b50, start);
        if (desc < 0 || (next >= 0 && desc > next)) break; // cut off inside this file
        size = dv.getUint32(desc + 8, true);
      }
      if (start + size > buf.length) break;
      const data = buf.subarray(start, start + size);
      try {
        files[name] = method === 0 ? new Blob([data]) : await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      } catch {}
      i = start + size;
    }
    return files;
  }

  /** Find a paper's supplementary material. Returns the items with their files. */
  async function find(p, { log = () => {}, signal } = {}) {
    const pmcid = await pmcidFor(p);
    if (!pmcid) return { items: [], reason: 'Not in PubMed Central, so no supplementary files can be fetched automatically.' };
    const items = await listed(pmcid);
    if (!items.length) return { items: [], pmcid, reason: 'The paper lists no supplementary files.' };
    log(`Downloading ${items.length} supplementary file${items.length > 1 ? 's' : ''} from Europe PMC (this can take a few minutes)…`);
    // Europe PMC sometimes cuts the download short: try again, then keep
    // whatever files arrived whole
    const JSZip = await Epubify.jszip();
    let files = null;
    let zipBlob = null;
    for (let attempt = 1; attempt <= 2 && !files; attempt++) {
      zipBlob = await bundle(pmcid, signal, (n) => log(`Downloading${attempt > 1 ? ' again' : ''}… ${(n / 1e6).toFixed(1)} MB`));
      try {
        const zip = await JSZip.loadAsync(zipBlob);
        files = {};
        for (const n of Object.keys(zip.files)) if (!zip.files[n].dir) files[n] = zip.file(n);
      } catch {
        log('The download was cut short; trying again…');
      }
    }
    if (!files) {
      const got = await salvage(zipBlob);
      files = Object.fromEntries(Object.entries(got).map(([n, b]) => [n, { async: async () => b }]));
    }
    const names = Object.keys(files);
    const base = (n) => n.split('/').pop();
    const out = [];
    for (const it of items) {
      const want = base(it.href);
      // figures are named without an extension: take the best image form
      const cand = names.filter((n) => base(n) === want || base(n).replace(/\.[^.]+$/, '') === want.replace(/\.[^.]+$/, ''));
      const name = cand.find((n) => base(n) === want) || cand.find((n) => /\.jpe?g$/i.test(n)) || cand.find((n) => /\.(png|gif|tiff?)$/i.test(n)) || cand[0];
      if (!name) continue;
      const data = await files[name].async('blob');
      const fileName = base(name);
      out.push({
        key: keysOf(it.label).join(' '),
        label: it.label.replace(/[.:]\s*$/, ''),
        // (the caption often repeats the label first)
        caption: (it.caption.startsWith(it.label) ? it.caption.slice(it.label.length) : it.caption).replace(/^[\s.:|—–-]+/, '').replace(/\s+([.,;:])/g, '$1').trim(),
        name: fileName,
        type: typeOf(fileName),
        size: data.size,
        blob: new Blob([data], { type: typeOf(fileName) }),
      });
    }
    return { items: out, pmcid, source: 'Europe PMC' };
  }

  // A file added by hand.
  function fromFile(f) {
    const label = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
    return { key: keysOf(label).join(' '), label, caption: '', name: f.name, type: f.type || typeOf(f.name), size: f.size, blob: f };
  }

  const icon = (it) => (/^image\//.test(it.type) ? '🖼' : /pdf/.test(it.type) ? '📄' : /csv|excel|spreadsheet|tab-separated/.test(it.type) ? '📊' : /video/.test(it.type) ? '🎞' : /word|text/.test(it.type) ? '📝' : '📎');

  // ---------- supplementary material at the end of an EPUB ----------
  // A "Supplementary material" page is added after the paper. Images and
  // tables are copied in; Word, Excel and PowerPoint become text and tables;
  // small PDFs are linked; anything else is listed by name (not carried).
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';
  const OPF_NS = 'http://www.idpf.org/2007/opf';
  const SUPP_PAGE = 'supplementary.xhtml';
  const MAX_EMBED = 15e6;
  const xesc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ROW_LIMIT = 300;
  const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };

  async function addToEpub(blob, items, { title = '' } = {}) {
    const JSZip = await Epubify.jszip();
    const zip = await JSZip.loadAsync(blob);
    const container = await zip.file('META-INF/container.xml').async('text');
    const opfPath = /full-path="([^"]+)"/.exec(container)[1];
    const dir = opfPath.replace(/[^/]*$/, '');
    const dom = new DOMParser();
    const opf = dom.parseFromString(await zip.file(opfPath).async('text'), 'application/xml');
    const manifest = opf.getElementsByTagNameNS(OPF_NS, 'manifest')[0];
    const spine = opf.getElementsByTagNameNS(OPF_NS, 'spine')[0];
    // a section added before goes first
    for (const it of [...manifest.children]) {
      const id = it.getAttribute('id') || '';
      if (id === 'supp-page' || id.startsWith('supp-f')) {
        zip.remove(dir + it.getAttribute('href'));
        it.remove();
      }
    }
    for (const ref of [...spine.children]) if (ref.getAttribute('idref') === 'supp-page') ref.remove();

    const add = (href, type, id, data) => {
      zip.file(dir + href, data);
      const e = opf.createElementNS(OPF_NS, 'item');
      e.setAttribute('id', id);
      e.setAttribute('href', href);
      e.setAttribute('media-type', type);
      manifest.appendChild(e);
    };
    const parts = [];
    let n = 0;
    for (const it of items) {
      n++;
      const id = `supp-f${n}`;
      const head = `<h2>${xesc(it.label || it.name)}</h2>${it.caption ? `<p class="small">${xesc(it.caption)}</p>` : ''}`;
      const type = it.type || '';
      try {
        if (IMAGE_TYPES[type] && it.size <= MAX_EMBED) {
          const href = `supp/f${n}.${IMAGE_TYPES[type]}`;
          add(href, type, id, await it.blob.arrayBuffer());
          parts.push(`<figure>${head}<img src="${href}" alt="${xesc(it.label || '')}"/></figure>`);
        } else if (/csv|tab-separated/.test(type) && it.size <= MAX_EMBED) {
          const text = await it.blob.text();
          const sep = /tab-separated/.test(type) || (text.split('\n')[0] || '').split('\t').length > (text.split('\n')[0] || '').split(',').length ? '\t' : ',';
          const rows = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, ROW_LIMIT).map((l) => (l.match(new RegExp(`("([^"]|"")*"|[^${sep}]*)(${sep}|$)`, 'g')) || []).filter((x, i, a) => i < a.length - 1 || x).map((c) => c.replace(new RegExp(`${sep}$`), '').replace(/^"|"$/g, '').replace(/""/g, '"')));
          const table = `<table>${rows.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${xesc(c)}</td>` : `<th>${xesc(c)}</th>`)).join('')}</tr>`).join('')}</table>`;
          parts.push(`<section>${head}${table}</section>`);
        } else if (/^text\/plain|^application\/json|^application\/xml|^text\/html/.test(type) && it.size <= MAX_EMBED) {
          parts.push(`<section>${head}<pre>${xesc((await it.blob.text()).slice(0, 20000))}</pre></section>`);
        } else if (/wordprocessingml|spreadsheetml|presentationml/.test(type) || /\.(docx|xlsx|pptx)$/i.test(it.name || '')) {
          const r = await Office.render(it.blob, type, it.name);
          if (r) {
            parts.push(`<section>${head}${r.html.replace(/<img[^>]*>/g, '').replace(/<br>/g, '<br/>')}</section>`);
            r.urls.forEach((u) => URL.revokeObjectURL(u));
          } else parts.push(`<section>${head}<p>${xesc(it.name)} isn’t in the book (it can’t be read here).</p></section>`);
        } else {
          parts.push(`<section>${head}<p>${xesc(it.name)} (${Math.round((it.size || 0) / 1024)} KB) isn’t carried in the book: it stays in PaperReads.</p></section>`);
        }
      } catch (err) {
        parts.push(`<section>${head}<p>${xesc(it.name)} couldn’t be added (${xesc(err.message)}).</p></section>`);
      }
    }

    const page = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="${XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en"><head><title>Supplementary material</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><section epub:type="appendix" id="supplementary"><h1>Supplementary material</h1>${title ? `<p class="small">${xesc(title)}</p>` : ''}${parts.join('\n')}</section></body></html>`;
    zip.file(dir + SUPP_PAGE, page);
    const pageItem = opf.createElementNS(OPF_NS, 'item');
    pageItem.setAttribute('id', 'supp-page');
    pageItem.setAttribute('href', SUPP_PAGE);
    pageItem.setAttribute('media-type', 'application/xhtml+xml');
    manifest.appendChild(pageItem);
    const ref = opf.createElementNS(OPF_NS, 'itemref');
    ref.setAttribute('idref', 'supp-page');
    spine.appendChild(ref);
    zip.file(opfPath, '<?xml version="1.0" encoding="utf-8"?>\n' + new XMLSerializer().serializeToString(opf.documentElement));

    // the contents page gets an entry for it
    const navItem = [...manifest.children].find((e) => (e.getAttribute('properties') || '').split(' ').includes('nav'));
    if (navItem) {
      const navPath = dir + navItem.getAttribute('href');
      const nav = dom.parseFromString(await zip.file(navPath).async('text'), 'application/xhtml+xml');
      const toc = [...nav.getElementsByTagNameNS(XHTML_NS, 'nav')].find((x) => x.getAttributeNS('http://www.idpf.org/2007/ops', 'type') === 'toc') || nav.getElementsByTagNameNS(XHTML_NS, 'nav')[0];
      const list = toc && toc.getElementsByTagNameNS(XHTML_NS, 'ol')[0];
      if (list) {
        for (const a of [...list.getElementsByTagNameNS(XHTML_NS, 'a')]) if (a.getAttribute('href') === SUPP_PAGE) a.closest('li').remove();
        const li = nav.createElementNS(XHTML_NS, 'li');
        const a = nav.createElementNS(XHTML_NS, 'a');
        a.setAttribute('href', SUPP_PAGE);
        a.textContent = 'Supplementary material';
        li.appendChild(a);
        list.appendChild(li);
        zip.file(navPath, '<?xml version="1.0" encoding="utf-8"?>\n' + new XMLSerializer().serializeToString(nav.documentElement));
      }
    }

    // the mimetype stays first and uncompressed, as an EPUB needs
    const out = new JSZip();
    out.file('mimetype', await zip.file('mimetype').async('uint8array'), { compression: 'STORE' });
    for (const name of Object.keys(zip.files)) if (name !== 'mimetype' && !zip.files[name].dir) out.file(name, await zip.files[name].async('uint8array'));
    return out.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
  }

  return { find, fromFile, keysOf, MENTION, icon, typeOf, salvage, addToEpub, MAX_EMBED };
})();

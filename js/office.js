// A simple viewer for Word, Excel and PowerPoint files (.docx, .xlsx, .pptx),
// so supplementary files open inside the app, offline. These files are zips
// of XML; this reads the text, tables and pictures, not the exact layout.
// The old binary formats (.doc, .xls, .ppt) aren't readable this way.
const Office = (() => {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
  const kid = (el, name) => kids(el, name)[0] || null;
  const attr = (el, name) => (el ? el.getAttribute('w:' + name) ?? el.getAttribute(name) : null);
  const xml = async (zip, path) => {
    const f = zip.file(path);
    return f ? new DOMParser().parseFromString(await f.async('text'), 'application/xml') : null;
  };
  // relationship id → target path, for one part ("word/document.xml")
  async function rels(zip, part) {
    const dir = part.replace(/[^/]+$/, '');
    const doc = await xml(zip, `${dir}_rels/${part.slice(dir.length)}.rels`);
    const out = {};
    if (doc)
      for (const r of doc.getElementsByTagName('Relationship')) {
        const t = r.getAttribute('Target');
        out[r.getAttribute('Id')] = t.startsWith('/') ? t.slice(1) : normalize(dir + t);
      }
    return out;
  }
  const normalize = (p) => {
    const out = [];
    for (const s of p.split('/')) s === '..' ? out.pop() : s && s !== '.' && out.push(s);
    return out.join('/');
  };
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' };

  // ---------------------------------------------------------------- Word
  async function docx(zip, urls) {
    const doc = await xml(zip, 'word/document.xml');
    if (!doc) return null;
    const rel = await rels(zip, 'word/document.xml');
    const image = async (id) => {
      const path = rel[id];
      const ext = (/\.(\w+)$/.exec(path || '') || [])[1]?.toLowerCase();
      if (!path || !MIME[ext] || !zip.file(path)) return '';
      const url = URL.createObjectURL(new Blob([await zip.file(path).async('uint8array')], { type: MIME[ext] }));
      urls.push(url);
      return `<img src="${url}" alt="">`;
    };
    async function runs(p) {
      let html = '';
      for (const el of p.children) {
        if (el.localName === 'hyperlink' || el.localName === 'ins' || el.localName === 'smartTag' || el.localName === 'sdt' || el.localName === 'sdtContent') {
          html += await runs(el);
          continue;
        }
        if (el.localName !== 'r') continue;
        const pr = kid(el, 'rPr');
        let text = '';
        for (const c of el.children) {
          if (c.localName === 't') text += esc(c.textContent);
          else if (c.localName === 'tab') text += ' ';
          else if (c.localName === 'br' || c.localName === 'cr') text += '<br>';
          else if (c.localName === 'sym') text += '•';
          else if (c.localName === 'drawing' || c.localName === 'pict') {
            for (const b of c.getElementsByTagName('*')) {
              const id = b.localName === 'blip' ? b.getAttribute('r:embed') : b.localName === 'imagedata' ? b.getAttribute('r:id') : null;
              if (id) text += await image(id);
            }
          }
        }
        if (!text) continue;
        const on = (n) => {
          const e = kid(pr, n);
          return e && !/^(0|false|none)$/.test(attr(e, 'val') || '');
        };
        const va = attr(kid(pr, 'vertAlign'), 'val');
        if (va === 'superscript') text = `<sup>${text}</sup>`;
        else if (va === 'subscript') text = `<sub>${text}</sub>`;
        if (on('i')) text = `<i>${text}</i>`;
        if (on('b')) text = `<b>${text}</b>`;
        html += text;
      }
      return html;
    }
    async function para(p) {
      const pr = kid(p, 'pPr');
      const style = attr(kid(pr, 'pStyle'), 'val') || '';
      const inner = await runs(p);
      if (!inner.replace(/<br>/g, '').trim()) return '';
      const h = /^title$/i.test(style) ? 1 : (/heading\s*(\d)/i.exec(style) || [])[1];
      if (h) return `<h${Math.min(6, Number(h) + 1)}>${inner}</h${Math.min(6, Number(h) + 1)}>`;
      if (kid(pr, 'numPr') || /list/i.test(style)) return `<p class="li">• ${inner}</p>`;
      return `<p>${inner}</p>`;
    }
    async function block(el) {
      if (el.localName === 'p') return para(el);
      if (el.localName === 'sdt') return (await Promise.all(kids(kid(el, 'sdtContent'), '*').map(block))).join('');
      if (el.localName === 'tbl') {
        let html = '<div class="office-tbl"><table>';
        for (const tr of kids(el, 'tr')) {
          html += '<tr>';
          for (const tc of kids(tr, 'tc')) {
            const span = attr(kid(kid(tc, 'tcPr'), 'gridSpan'), 'val');
            const merged = kid(kid(tc, 'tcPr'), 'vMerge');
            if (merged && attr(merged, 'val') !== 'restart') {
              html += '<td></td>';
              continue;
            }
            let cell = '';
            for (const c of tc.children) cell += await block(c);
            html += `<td${span > 1 ? ` colspan="${span}"` : ''}>${cell.replace(/^<p>|<\/p>$/g, '')}</td>`;
          }
          html += '</tr>';
        }
        return html + '</table></div>';
      }
      return '';
    }
    const body = doc.getElementsByTagName('w:body')[0] || doc.documentElement;
    let html = '';
    for (const el of body.children) html += await block(el);
    return html || '<p class="muted">This document has no text.</p>';
  }

  // ---------------------------------------------------------------- Excel
  const colIndex = (ref) => {
    let n = 0;
    for (const ch of /^[A-Z]+/.exec(ref || 'A')[0]) n = n * 26 + ch.charCodeAt(0) - 64;
    return n - 1;
  };
  async function xlsx(zip) {
    const wb = await xml(zip, 'xl/workbook.xml');
    if (!wb) return null;
    const rel = await rels(zip, 'xl/workbook.xml');
    const ssDoc = await xml(zip, 'xl/sharedStrings.xml');
    const shared = ssDoc ? [...ssDoc.getElementsByTagName('si')].map((si) => [...si.getElementsByTagName('t')].map((t) => t.textContent).join('')) : [];
    const sheets = [...wb.getElementsByTagName('sheet')];
    const MAX_ROWS = 300;
    const MAX_COLS = 60;
    let html = '';
    for (const sh of sheets.slice(0, 20)) {
      const doc = await xml(zip, rel[sh.getAttribute('r:id')] || '');
      if (!doc) continue;
      const rows = [];
      let total = 0;
      for (const r of doc.getElementsByTagName('row')) {
        total++;
        if (rows.length >= MAX_ROWS) continue;
        const row = [];
        for (const c of kids(r, 'c')) {
          const i = colIndex(c.getAttribute('r'));
          if (i >= MAX_COLS) continue;
          const t = c.getAttribute('t');
          const v = kid(c, 'v')?.textContent ?? '';
          let val = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? [...c.getElementsByTagName('t')].map((x) => x.textContent).join('') : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v;
          // long binary fractions ("0.30000000000000004") read as the number they are
          if (!t && /^-?\d*\.\d{7,}$/.test(val)) val = String(Number(Number(val).toPrecision(6)));
          row[i] = val;
        }
        rows.push(row);
      }
      if (!rows.some((r) => r.some((x) => x !== undefined && x !== ''))) continue;
      const width = Math.max(...rows.map((r) => r.length));
      html += sheets.length > 1 ? `<h3>${esc(sh.getAttribute('name') || '')}</h3>` : '';
      html += `<div class="office-tbl"><table>${rows.map((r, k) => `<tr>${Array.from({ length: width }, (_, i) => (k ? `<td>${esc(r[i] ?? '')}</td>` : `<th>${esc(r[i] ?? '')}</th>`)).join('')}</tr>`).join('')}</table></div>`;
      if (total > MAX_ROWS) html += `<p class="muted small">First ${MAX_ROWS} of ${total} rows.</p>`;
    }
    return html || '<p class="muted">This spreadsheet is empty.</p>';
  }

  // ---------------------------------------------------------------- PowerPoint
  async function pptx(zip, urls) {
    const names = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
    if (!names.length) return null;
    let html = '';
    for (const [k, n] of names.entries()) {
      const doc = await xml(zip, n);
      const rel = await rels(zip, n);
      html += `<h3>Slide ${k + 1}</h3>`;
      for (const p of doc.getElementsByTagName('a:p')) {
        const t = [...p.getElementsByTagName('a:t')].map((x) => esc(x.textContent)).join('');
        if (t.trim()) html += `<p>${t}</p>`;
      }
      for (const b of doc.getElementsByTagName('a:blip')) {
        const path = rel[b.getAttribute('r:embed')];
        const ext = (/\.(\w+)$/.exec(path || '') || [])[1]?.toLowerCase();
        if (!path || !MIME[ext] || !zip.file(path)) continue;
        const url = URL.createObjectURL(new Blob([await zip.file(path).async('uint8array')], { type: MIME[ext] }));
        urls.push(url);
        html += `<img src="${url}" alt="">`;
      }
    }
    return html;
  }

  const KINDS = { docx: /wordprocessingml|\.docx$/i, xlsx: /spreadsheetml|\.xlsx$/i, pptx: /presentationml|\.pptx$/i };
  const kindOf = (type, name) => Object.keys(KINDS).find((k) => KINDS[k].test(type || '') || KINDS[k].test(name || '')) || null;
  const canShow = (type, name) => !!kindOf(type, name);

  // → { html, urls } (revoke the urls when done), or null when it can't be read
  async function render(blob, type, name) {
    const kind = kindOf(type, name);
    if (!kind) return null;
    const JSZip = await Epubify.jszip();
    const zip = await JSZip.loadAsync(blob);
    const urls = [];
    const html = await { docx, xlsx, pptx }[kind](zip, urls);
    return html ? { html, urls } : null;
  }

  return { canShow, render };
})();

/* epubify, ported to run in the browser.
 *
 * A port of the epubify.py script: deterministic generated covers, the
 * PyMuPDF-based PDF → HTML layout analysis (now on PDF.js), the HTML
 * clean-up passes, and EPUB packaging (JSZip instead of pandoc).
 *
 * Sources, best first (same preference as the script: HTML beats PDF):
 *   1. arXiv's native HTML       arxiv.org/html/<id>  (CORS-open)
 *   2. Europe PMC full text      JATS XML for open-access PubMed Central papers
 *   3. The paper's stored PDF    layout analysis; two-column PDFs may scramble
 * Not ported: ar5iv, publisher pages and the headless-browser renderer. Those
 * sites don't allow cross-origin requests from a web app.
 */
const Epubify = (() => {
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';
  const base = new URL('.', document.baseURI).href;

  // ---------------------------------------------------------------- loaders
  let pdfjsPromise = null;
  function pdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(base + 'vendor/pdf.min.mjs').then((m) => {
        m.GlobalWorkerOptions.workerSrc = base + 'vendor/pdf.worker.min.mjs';
        return m;
      });
    }
    return pdfjsPromise;
  }
  const scripts = {};
  function loadScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = base + src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`could not load ${src}`));
        document.head.appendChild(s);
      });
    }
    return scripts[src];
  }
  const jszip = () => loadScript('vendor/jszip.min.js').then(() => window.JSZip);
  const epubjs = () => jszip().then(() => loadScript('vendor/epub.min.js')).then(() => window.ePub);

  // ---------------------------------------------------------------- python-isms
  // Python's round() is banker's rounding; several heuristics bucket on it.
  function pyRound(x) {
    const f = Math.floor(x);
    const d = x - f;
    if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
    return Math.round(x);
  }
  class Counter {
    constructor() {
      this.m = new Map();
    }
    add(k, n = 1) {
      this.m.set(k, (this.m.get(k) || 0) + n);
    }
    get(k) {
      return this.m.get(k) || 0;
    }
    // Ties go to the first key inserted, like collections.Counter.most_common.
    mostCommon() {
      let bk;
      let bv = -Infinity;
      for (const [k, v] of this.m) if (v > bv) [bk, bv] = [k, v];
      return bk;
    }
    entries() {
      return [...this.m.entries()];
    }
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c]));
  const ws = (s) => s.replace(/\s+/g, ' ');
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const ROMAN_OR_DIGITS = /^[\divxlcIVXLC]{1,6}$/;
  const endsWithAny = (s, chars) => chars.includes(s.slice(-1));
  const startsWithAny = (s, prefixes) => prefixes.some((p) => s.startsWith(p));

  // ================================================================ cover art
  // Deterministic from the title: same hash stream, colours and pattern
  // choice as the Python version (fonts and anti-aliasing differ slightly).
  async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  }
  async function makeRand(seed) {
    // The Python _Rand re-hashes its buffer when exhausted; crypto.subtle is
    // async, so precompute enough of that chain up front.
    let buf = await sha256(new TextEncoder().encode(seed));
    const chain = [buf];
    for (let i = 0; i < 200; i++) chain.push((buf = await sha256(buf)));
    const stream = new Uint8Array(chain.length * 32);
    chain.forEach((c, i) => stream.set(c, i * 32));
    let i = 0;
    const r = {
      byte: () => stream[i++ % stream.length],
      unit: () => (r.byte() * 256 + r.byte()) / 65535,
      between: (a, b) => a + (b - a) * r.unit(),
      pick: (seq) => seq[r.byte() % seq.length],
      tag: [...chain[0].slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase(),
    };
    return r;
  }
  function hsvToRgb(h, s, v) {
    if (s === 0) return [v, v, v];
    const i = Math.trunc(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - s * f);
    const t = v * (1 - s * (1 - f));
    return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  }
  const hsv = (h, s, v) => hsvToRgb(((h % 1) + 1) % 1, s, v).map((c) => Math.trunc(c * 255));
  const blend = (c1, c2, t) => c1.map((a, i) => Math.trunc(a + (c2[i] - a) * t));
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  function ellipse(d, x0, y0, x1, y1, { fill, outline, width }) {
    d.beginPath();
    if (outline) {
      // PIL draws outlines inside the bounding box
      const w = width || 1;
      d.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.max(0, (x1 - x0 - w) / 2), Math.max(0, (y1 - y0 - w) / 2), 0, 0, Math.PI * 2);
      d.strokeStyle = rgb(outline);
      d.lineWidth = w;
      d.stroke();
    } else {
      d.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      d.fillStyle = rgb(fill);
      d.fill();
    }
  }
  function line(d, x0, y0, x1, y1, col, w) {
    d.beginPath();
    d.moveTo(x0, y0);
    d.lineTo(x1, y1);
    d.strokeStyle = rgb(col);
    d.lineWidth = w;
    d.stroke();
  }
  const PATTERNS = [
    function arcs(d, r, acc, bg, [x0, y0, x1, y1]) {
      const cx = r.between(x0 + 0.2 * (x1 - x0), x0 + 0.8 * (x1 - x0));
      const cy = r.between(y0 + 0.2 * (y1 - y0), y0 + 0.8 * (y1 - y0));
      const n = Math.trunc(r.between(14, 26));
      const step = Math.max(x1 - x0, y1 - y0) / (n * 1.4);
      for (let i = n; i > 0; i--) {
        const rad = step * i;
        ellipse(d, cx - rad, cy - rad, cx + rad, cy + rad, { outline: blend(acc, bg, (i / n) * 0.75), width: Math.trunc(r.between(3, 13)) });
      }
    },
    function bars(d, r, acc, bg, [x0, y0, x1, y1]) {
      const n = Math.trunc(r.between(9, 20));
      const slot = (x1 - x0) / n;
      for (let i = 0; i < n; i++) {
        const h = r.between(0.15, 1.0) * (y1 - y0);
        const pad = slot * r.between(0.08, 0.24);
        d.fillStyle = rgb(blend(acc, bg, r.between(0, 0.6)));
        d.fillRect(x0 + i * slot + pad, y1 - h, slot - 2 * pad, h);
      }
    },
    function dots(d, r, acc, bg, [x0, y0, x1, y1]) {
      const cols = Math.trunc(r.between(7, 13));
      const rows = Math.max(Math.trunc((cols * (y1 - y0)) / (x1 - x0)), 1);
      const cw = (x1 - x0) / cols;
      const ch = (y1 - y0) / rows;
      for (let rr = 0; rr < rows; rr++) {
        for (let c = 0; c < cols; c++) {
          const cx = x0 + (c + 0.5) * cw;
          const cy = y0 + (rr + 0.5) * ch;
          const rad = Math.min(cw, ch) * 0.5 * r.between(0.12, 0.92);
          ellipse(d, cx - rad, cy - rad, cx + rad, cy + rad, { fill: blend(acc, bg, r.between(0, 0.55)) });
        }
      }
    },
    function weave(d, r, acc, bg, [x0, y0, x1, y1]) {
      const n = Math.trunc(r.between(18, 34));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const w = Math.trunc(r.between(2, 9));
        const col = blend(acc, bg, r.between(0, 0.6));
        if (r.unit() > 0.5) line(d, x0, y0 + t * (y1 - y0), x1, y0 + r.unit() * (y1 - y0), col, w);
        else line(d, x0 + t * (x1 - x0), y0, x0 + r.unit() * (x1 - x0), y1, col, w);
      }
    },
    function orbit(d, r, acc, bg, [x0, y0, x1, y1]) {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const R = Math.min(x1 - x0, y1 - y0) * 0.44;
      const pts = Math.trunc(r.between(120, 320));
      const a = r.between(1.5, 5.5);
      const b = r.between(1.5, 5.5);
      const ph = r.between(0, 6.28);
      for (let i = 0; i < pts; i++) {
        const t = (i / pts) * 6.28318;
        const x = cx + R * Math.sin(a * t + ph);
        const y = cy + R * Math.sin(b * t);
        const rad = r.between(4, 16);
        ellipse(d, x - rad, y - rad, x + rad, y + rad, { fill: blend(acc, bg, (i / pts) * 0.6) });
      }
    },
  ];
  const SERIF = '"DejaVu Serif", "Liberation Serif", "Noto Serif", Georgia, serif';
  const SANS = '"DejaVu Sans", "Liberation Sans", Roboto, Arial, sans-serif';

  async function makeCover(title, subtitle) {
    const W = 1600;
    const H = 2400;
    const SCALE = 0.5; // 800×1200 output keeps the EPUB small
    const r = await makeRand(title);
    const baseHue = r.unit();
    const dark = r.unit() > 0.35;
    let bg, ink, acc;
    if (dark) {
      bg = hsv(baseHue, r.between(0.45, 0.75), r.between(0.13, 0.22));
      ink = hsv(baseHue, 0.06, 0.96);
      acc = hsv(baseHue + r.between(0.08, 0.45), r.between(0.55, 0.85), r.between(0.8, 0.98));
    } else {
      bg = hsv(baseHue, r.between(0.1, 0.22), r.between(0.9, 0.97));
      ink = hsv(baseHue, 0.7, 0.16);
      acc = hsv(baseHue + r.between(0.08, 0.45), r.between(0.55, 0.85), r.between(0.45, 0.7));
    }
    const canvas = document.createElement('canvas');
    canvas.width = W * SCALE;
    canvas.height = H * SCALE;
    const d = canvas.getContext('2d');
    d.scale(SCALE, SCALE);
    d.fillStyle = rgb(bg);
    d.fillRect(0, 0, W, H);
    const m = 110;
    r.pick(PATTERNS)(d, r, acc, bg, [m, m, W - m, Math.trunc(H * 0.6)]);
    line(d, m, Math.trunc(H * 0.645), W - m, Math.trunc(H * 0.645), acc, 7);

    let size = 118;
    let lines = [];
    while (size > 40) {
      d.font = `bold ${size}px ${SERIF}`;
      lines = [];
      let cur = '';
      for (const w of title.split(/\s+/).filter(Boolean)) {
        const trial = (cur + ' ' + w).trim();
        if (d.measureText(trial).width <= W - 2 * m) cur = trial;
        else {
          if (cur) lines.push(cur);
          cur = w;
        }
      }
      if (cur) lines.push(cur);
      if (lines.length <= 5) break;
      size -= 8;
    }
    if (lines.length > 5) {
      lines = lines.slice(0, 5);
      lines[4] = lines[4].replace(/[ .,;:]+$/, '') + '…';
    }
    d.textBaseline = 'top';
    d.fillStyle = rgb(ink);
    let y = Math.trunc(H * 0.7);
    for (const ln of lines) {
      d.fillText(ln, m, y);
      y += Math.trunc(size * 1.3);
    }
    if (subtitle) {
      d.font = `52px ${SANS}`;
      d.fillStyle = rgb(blend(ink, bg, 0.35));
      d.fillText(subtitle.length < 60 ? subtitle : subtitle.slice(0, 57) + '…', m, y + 26);
    }
    d.font = `40px ${SANS}`;
    d.fillStyle = rgb(blend(ink, bg, 0.45));
    d.fillText(r.tag, m, H - m - 46);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  // ================================================================ PDF model
  // Build a PyMuPDF-like view of the document from PDF.js: pages of lines of
  // spans with top-down bboxes, font size/name/bold flag, plus image boxes.
  async function openPdf(blob, log) {
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), fontExtraProperties: true, isEvalSupported: false }).promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (n === 1 || n % 5 === 0) log(`  reading page ${n} of ${doc.numPages}`);
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const ops = await page.getOperatorList(); // also loads fonts into commonObjs
      const tc = await page.getTextContent();
      const fonts = {};
      const fontInfo = (id) => {
        if (!(id in fonts)) {
          try {
            const f = page.commonObjs.get(id);
            fonts[id] = { name: f.name || '', bold: !!f.bold, asc: f.ascent || 0.8, desc: f.descent || -0.2 };
          } catch {
            fonts[id] = { name: '', bold: false, asc: 0.8, desc: -0.2 };
          }
        }
        return fonts[id];
      };
      const lines = [];
      let cur = null;
      const close = () => {
        if (cur && cur.spans.length) lines.push(cur);
        cur = null;
      };
      for (const it of tc.items) {
        if (it.str === '') {
          if (it.hasEOL) close();
          continue;
        }
        const tx = lib.Util.transform(vp.transform, it.transform);
        const size = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]);
        const len = Math.hypot(tx[0], tx[1]) || 1;
        const dir = [tx[0] / len, tx[1] / len];
        const f = fontInfo(it.fontName);
        const x0 = tx[4];
        const yb = tx[5];
        const span = {
          text: it.str,
          bbox: [x0, yb - f.asc * size, x0 + it.width, yb - f.desc * size],
          size,
          font: f.name,
          flags: f.bold || /Bold|-Bd|Medi|Semibold|Demi|Black|Heavy|CMBX/i.test(f.name) ? 16 : 0,
        };
        if (cur && (Math.abs(cur.dir[0] - dir[0]) > 0.01 || Math.abs(cur.dir[1] - dir[1]) > 0.01)) close();
        if (!cur) cur = { dir, spans: [] };
        cur.spans.push(span);
        if (it.hasEOL) close();
      }
      close();
      for (const l of lines) {
        l.bbox = [
          Math.min(...l.spans.map((s) => s.bbox[0])),
          Math.min(...l.spans.map((s) => s.bbox[1])),
          Math.max(...l.spans.map((s) => s.bbox[2])),
          Math.max(...l.spans.map((s) => s.bbox[3])),
        ];
      }
      pages.push({ page, vp, width: vp.width, height: vp.height, lines, images: imageBoxes(lib, ops, vp) });
    }
    let meta = { title: '', author: '' };
    try {
      const md = await doc.getMetadata();
      meta = { title: md.info.Title || '', author: md.info.Author || '' };
    } catch {}
    return { doc, pages, meta };
  }

  // Walk the operator list tracking the transform matrix to find where each
  // raster image is painted (PyMuPDF reports these as image blocks).
  function imageBoxes(lib, ops, vp) {
    const O = lib.OPS;
    const PAINT = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintJpegXObject].filter((x) => x !== undefined));
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const boxes = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];
      if (fn === O.save) stack.push(ctm);
      else if (fn === O.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === O.transform) ctm = lib.Util.transform(ctm, args);
      else if (fn === O.paintFormXObjectBegin) {
        stack.push(ctm);
        if (args && Array.isArray(args[0]) && args[0].length === 6) ctm = lib.Util.transform(ctm, args[0]);
      } else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (PAINT.has(fn)) {
        const m = lib.Util.transform(vp.transform, ctm);
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
    }
    return boxes;
  }

  // Render the page once and crop each image box (PyMuPDF get_pixmap(clip=…)).
  async function cropImages(pg, boxes) {
    const scale = 2;
    const vp = pg.page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await pg.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const out = [];
    for (const [x0, y0, x1, y1] of boxes) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round((x1 - x0) * scale));
      c.height = Math.max(1, Math.round((y1 - y0) * scale));
      c.getContext('2d').drawImage(canvas, x0 * scale, y0 * scale, c.width, c.height, 0, 0, c.width, c.height);
      out.push(await new Promise((resolve) => c.toBlob(resolve, 'image/png')));
    }
    return out;
  }

  // ================================================================ PDF → HTML
  function pdfIsTwoColumn(pdf, pageW) {
    const bins = new Array(20).fill(0);
    let n = 0;
    for (const pg of pdf.pages) {
      for (const l of pg.lines) {
        for (const s of l.spans) {
          // approximate PyMuPDF "words" by splitting spans proportionally
          const cw = (s.bbox[2] - s.bbox[0]) / (s.text.length || 1);
          for (const m of s.text.matchAll(/\S+/g)) {
            const a = s.bbox[0] + m.index * cw;
            const b = a + m[0].length * cw;
            const mid = pageW ? (a + b) / 2 / pageW : 0;
            if (mid >= 0 && mid < 1) {
              bins[Math.trunc(mid * 20)]++;
              n++;
            }
          }
        }
      }
    }
    if (n < 40) return false;
    const centre = bins[9] + bins[10];
    const sides = sum(bins.slice(3, 7)) + sum(bins.slice(13, 17));
    return centre < sides * 0.15 && sides > n * 0.3;
  }

  function fixGlyphs(text, font) {
    if (font && font.includes('CMEX') && text.trim() === 'c') return '';
    let out = '';
    for (const ch of text) {
      const o = ch.codePointAt(0);
      if (o === 0x02) out += '[';
      else if (o === 0x03) out += ']';
      else if (o < 0x20 && !'\t\n\r'.includes(ch)) continue;
      else out += ch;
    }
    return out;
  }

  function resolveHat(text) {
    if (!text.includes('')) return text;
    text = text.replace(/P(r\s*\[?)\s*/g, 'P̂$1');
    text = text.replace(/[\s[\]]*Pr/g, 'P̂r');
    text = text.replace(/\s*([A-Za-z])/g, '$1̂');
    return text.replaceAll('', '');
  }

  const horizontal = (l) => Math.abs(l.dir[0] - 1) <= 0.01;

  // Join spans left-to-right. The script used " ".join, which splits
  // small caps ("A DAM : A M ETHOD") and superscripts; only insert a space
  // where there is a visible gap between the spans.
  function joinSpans(spans) {
    let out = '';
    let prev = null;
    for (const s of spans) {
      if (prev) {
        const gap = s.x0 - prev.x1;
        if (gap > 0.12 * Math.min(prev.size, s.size) || /\s$/.test(out) || /^\s/.test(s.text)) out += ' ';
      }
      out += s.text;
      prev = s;
    }
    return out;
  }

  function pdfHasSideMargin(pdf, bodyLeft) {
    let leftRows = 0;
    let both = 0;
    for (const pg of pdf.pages) {
      const rows = new Map();
      for (const l of pg.lines) {
        if (!horizontal(l)) continue;
        for (const s of l.spans) {
          if (!s.text.trim()) continue;
          const y = pyRound((s.bbox[1] + s.bbox[3]) / 8);
          if (!rows.has(y)) rows.set(y, [0, 0]);
          const r = rows.get(y);
          if (s.bbox[2] < bodyLeft - 8) r[0] = 1;
          if (s.bbox[0] >= bodyLeft - 8) r[1] = 1;
        }
      }
      for (const [lft, bd] of rows.values()) {
        if (lft) {
          leftRows++;
          both += bd;
        }
      }
    }
    return leftRows >= 20 && both >= 0.5 * leftRows;
  }

  function placeFiguresNearCitation(parts) {
    const labelRe = /^<p><strong>(?:Fig\.?|Figure)\s*(\d+)/i;
    const figs = new Map();
    let i = 0;
    while (i < parts.length - 1) {
      const m = labelRe.exec(parts[i + 1]);
      if (parts[i].startsWith('<p><img') && m) {
        if (!figs.has(m[1])) figs.set(m[1], [i, [parts[i], parts[i + 1]]]);
        i += 2;
        continue;
      }
      i++;
    }
    if (!figs.size) return parts;
    const moved = new Set();
    const out = [];
    const taken = new Set();
    for (const [idx] of figs.values()) {
      taken.add(idx);
      taken.add(idx + 1);
    }
    const byNumber = [...figs.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
    parts.forEach((p, j) => {
      if (taken.has(j)) return;
      out.push(p);
      if (!p.startsWith('<p>') || p.startsWith('<p><img') || labelRe.test(p)) return;
      const text = p.replace(/<[^>]+>/g, ' ');
      for (const [n, [idx, block]] of byNumber) {
        if (moved.has(n) || idx < j) continue;
        if (new RegExp(`\\b(?:Fig\\.?|Figure)\\s*${n}(?:[A-Za-z]\\b|\\b)`).test(text)) {
          out.push(...block);
          moved.add(n);
        }
      }
    });
    for (const [n, [, block]] of [...figs.entries()].sort((a, b) => a[1][0] - b[1][0])) if (!moved.has(n)) out.push(...block);
    return out;
  }

  async function pdfSimpleFlow(pdf, bodySize, images, log) {
    const ph = pdf.pages[0].height;
    const npages = pdf.pages.length;
    const norm = (t) => ws(t).trim().toLowerCase().replace(/\d+/g, '#');

    // running headers / footers
    const edge = new Counter();
    for (const pg of pdf.pages) {
      const seen = new Set();
      for (const l of pg.lines) {
        if (!horizontal(l)) continue;
        const y = l.bbox[1];
        if (y < ph * 0.12 || y > ph * 0.85) {
          const t = norm(l.spans.map((s) => s.text).join(''));
          if (t) seen.add(t);
        }
      }
      seen.forEach((t) => edge.add(t));
    }
    const boiler = new Set(edge.entries().filter(([, c]) => c >= Math.max(3, Math.floor(npages / 3))).map(([t]) => t));
    const isBold = (sp) => /Bold|-Bd/.test(sp.font) || !!(sp.flags & 16);

    // ---- collect rows and images per page
    const pages = [];
    for (let pno = 0; pno < pdf.pages.length; pno++) {
      const pg = pdf.pages[pno];
      const spans = [];
      for (const l of pg.lines) {
        if (!horizontal(l)) continue;
        if (boiler.has(norm(l.spans.map((s) => s.text).join('')))) continue;
        if (pno === 0 && l.bbox[3] < ph * 0.075) continue; // masthead on the first page
        for (const s of l.spans) {
          const t = fixGlyphs(s.text, s.font);
          if (t.trim()) {
            spans.push({ text: t, x0: s.bbox[0], x1: s.bbox[2], y0: s.bbox[1], y1: s.bbox[3], yc: (s.bbox[1] + s.bbox[3]) / 2, size: s.size, bold: isBold(s) });
          }
        }
      }
      spans.sort((a, b) => a.yc - b.yc || a.x0 - b.x0);
      const rows = [];
      for (const s of spans) {
        if (rows.length && Math.abs(s.yc - rows[rows.length - 1].at(-1).yc) <= 4) rows[rows.length - 1].push(s);
        else rows.push([s]);
      }
      const items = [];
      for (const r of rows) {
        r.sort((a, b) => a.x0 - b.x0);
        const txt = resolveHat(ws(joinSpans(r)).trim());
        if (!txt || ROMAN_OR_DIGITS.test(txt)) continue;
        const weight = new Counter();
        r.forEach((z) => weight.add(pyRound(z.size), z.text.length));
        const visible = r.filter((z) => z.text.trim());
        items.push({
          kind: 'text',
          text: txt,
          x0: r[0].x0,
          y0: Math.min(...r.map((z) => z.y0)),
          y1: Math.max(...r.map((z) => z.y1)),
          size: weight.mostCommon(),
          bold: visible.every((z) => z.bold),
          boldish: sum(r.filter((z) => z.bold).map((z) => z.text.length)) >= 0.6 * sum(r.map((z) => z.text.length)),
        });
      }
      const keep = pg.images.filter(([x0, y0, x1, y1]) => x1 - x0 >= 4 && y1 - y0 >= 4 && !(y1 < ph * 0.1 || y0 > ph * 0.92));
      if (keep.length) {
        const blobs = await cropImages(pg, keep).catch(() => []);
        blobs.forEach((blob, k) => {
          if (!blob) return;
          images.push(blob);
          items.push({ kind: 'img', y0: keep[k][1], y1: keep[k][3], src: `pdfimg:${images.length - 1}` });
        });
      }
      items.sort((a, b) => a.y0 - b.y0);
      pages.push(items);
    }
    log(`  laid out ${npages} pages, ${images.length} image(s)`);

    // ---- title (and author) from page 1
    let title = null;
    let author = null;
    const first = (pages[0] || []).filter((it) => it.kind === 'text');
    if (first.length) {
      const big = Math.max(...first.map((it) => it.size));
      if (big >= bodySize + 2) {
        const tl = first.filter((it) => it.size === big);
        const run = [tl[0]];
        for (const it of tl.slice(1)) {
          if (it.y0 - run.at(-1).y1 < big * 1.2) run.push(it);
          else break;
        }
        title = run.map((it) => it.text).join(' ');
        run.forEach((it) => (it.kind = 'title'));
        const after = first.filter((it) => it.y0 > run.at(-1).y1);
        if (after.length && after[0].boldish && after[0].size < big && after[0].y0 - run.at(-1).y1 < 40) {
          author = after[0].text;
          after[0].kind = 'skip';
        }
      }
    }

    // ---- emit
    let parts = [];
    const notes = [];
    const buf = [];
    const state = { last: null, list: false, label: null, titleDone: false };
    const TERMINAL = '.!?:;”"\')]';
    const LABEL = /^(Fig\.?|Figure|Table|Box)\s*\d+[A-Za-z]?\.?$/i;
    const NUMITEM = /^\d{1,3}\.\s+\S/;

    const joinLines = (lines) => {
      let out = '';
      for (const ln of lines) {
        if (out.endsWith('-') && out.length > 1 && /\p{L}/u.test(out.at(-2)) && /^\p{Ll}/u.test(ln)) out = out.slice(0, -1) + ln;
        else out = out ? out + ' ' + ln : ln;
      }
      return ws(out).trim();
    };
    const flush = () => {
      if (buf.length) {
        const txt = joinLines(buf);
        if (state.label) {
          parts.push(`<p><strong>${esc(state.label)}</strong> ${esc(txt)}</p>`);
          state.label = null;
        } else parts.push(`<p>${esc(txt)}</p>`);
        buf.length = 0;
      }
      state.last = null;
      state.list = false;
    };

    let fnCur = [];
    for (const items of pages) {
      let pageStart = true;
      for (const it of items) {
        if (it.kind === 'skip') continue;
        if (it.kind === 'title') {
          flush();
          if (!state.titleDone) {
            parts.push(`<h1>${esc(title)}</h1>`);
            state.titleDone = true;
          }
          continue;
        }
        if (it.kind === 'img') {
          flush();
          parts.push(`<p><img src="${it.src}" alt=""/></p>`);
          pageStart = false;
          continue;
        }
        const txt = it.text;
        const sz = it.size;
        // footnotes: small type near the page bottom
        if (sz <= bodySize - 2 && it.y0 > ph * 0.78) {
          if (fnCur.length && !/^([a-z*†‡§]|\d{1,2})[A-Z]/.test(txt) && !txt.startsWith('Correspondence')) fnCur.push(txt);
          else {
            if (fnCur.length) notes.push(joinLines(fnCur));
            fnCur = [txt];
          }
          continue;
        }
        if (fnCur.length) {
          notes.push(joinLines(fnCur));
          fnCur = [];
        }
        // headings
        if ((sz >= bodySize + 2 && it.bold) || sz >= bodySize + 3) {
          flush();
          parts.push(`<h2>${esc(txt)}</h2>`);
          pageStart = false;
          continue;
        }
        if (it.bold && LABEL.test(txt)) {
          flush();
          state.label = txt;
          pageStart = false;
          continue;
        }
        if (it.bold && txt.length <= 40 && sz >= bodySize - 1) {
          flush();
          parts.push(`<h3>${esc(txt)}</h3>`);
          pageStart = false;
          continue;
        }
        const last = state.last;
        let newPara = false;
        if (last === null) newPara = true;
        else if (pageStart) {
          // carry a paragraph across the page break only if unfinished
          if (endsWithAny(last.text.trimEnd(), TERMINAL) || Math.abs(sz - last.size) >= 1) newPara = true;
        } else {
          const gap = it.y0 - last.y1;
          if (gap > Math.max(4.0, 0.5 * bodySize)) newPara = true;
          else if (Math.abs(sz - last.size) >= 1) newPara = true;
          else if (it.x0 > last.x0 + 3 && !state.list && endsWithAny(last.text.trimEnd(), TERMINAL)) newPara = true; // first-line indent
        }
        if (NUMITEM.test(txt) || startsWithAny(txt.trimStart(), ['•', '– ', '- '])) newPara = true;
        if (newPara && buf.length) flush();
        if (!buf.length) state.list = NUMITEM.test(txt);
        buf.push(txt);
        state.last = it;
        pageStart = false;
      }
    }
    if (fnCur.length) notes.push(joinLines(fnCur));
    flush();
    parts = placeFiguresNearCitation(parts);
    if (notes.length) {
      parts.push('<h2>Notes</h2>');
      for (let n of notes) {
        n = n.replace(/^([a-z]|\d{1,2}|[*†‡§])(?=[A-Z])/, '$1. ');
        parts.push(`<p><small>${esc(n)}</small></p>`);
      }
    }
    return { parts, title, author };
  }

  async function pdfToHtml(blob, filename, log) {
    const pdf = await openPdf(blob, log);
    if (!pdf.pages.length) throw new Error('PDF has no pages');
    const pageW = pdf.pages[0].width;
    const images = [];

    // dominant body font size across the document
    const sizes = new Counter();
    const globX0 = new Counter();
    for (const pg of pdf.pages) {
      for (const l of pg.lines) {
        for (const s of l.spans) {
          if (!s.text.trim()) continue;
          sizes.add(pyRound(s.size));
          globX0.add(pyRound(s.bbox[0] / 5) * 5);
        }
      }
    }
    const bodySize = sizes.mostCommon() ?? 11;
    // global body-text left edge (per-page voting fails on box-dominated pages)
    const globalBodyLeft = globX0.mostCommon() ?? 0;
    const twoCol = pdfIsTwoColumn(pdf, pageW);
    const stem = (filename || 'paper').replace(/\.[^.]+$/, '');

    if (!twoCol && !pdfHasSideMargin(pdf, globalBodyLeft)) {
      log('  single-column layout');
      const { parts, title, author } = await pdfSimpleFlow(pdf, bodySize, images, log);
      pdf.doc.destroy();
      return { parts, images, title: title || pdf.meta.title.trim() || stem, author: author || pdf.meta.author.trim(), twoCol: false };
    }
    log(twoCol ? '  two-column layout' : '  layout with a side-margin column');

    // repeated running headers/footers
    const ph = pdf.pages[0].height;
    const edgeLines = new Counter();
    for (const pg of pdf.pages) {
      for (const l of pg.lines) {
        const y = l.bbox[1];
        if (y < ph * 0.08 || y > ph * 0.92) {
          const t = l.spans.map((s) => s.text).join('').trim();
          if (t) edgeLines.add(t);
        }
      }
    }
    const repeated = new Set(edgeLines.entries().filter(([, c]) => c >= Math.max(3, Math.floor(pdf.pages.length / 2))).map(([t]) => t));
    const parts = [];
    let title = null;

    const rowText = (row) => {
      row.sort((a, b) => a.x0 - b.x0);
      const main = [row[0]];
      const asides = [];
      for (const s of row.slice(1)) {
        if (s.x0 - main.at(-1).x1 > pageW * 0.18) asides.push(s);
        else main.push(s);
      }
      const txt = resolveHat(ws(joinSpans(main)).trim());
      const asideTxt = resolveHat(ws(joinSpans(asides)).trim());
      const c = new Counter();
      main.forEach((m) => c.add(pyRound(m.size)));
      return [txt, asideTxt, c.mostCommon()];
    };
    const joinSorted = (sps) => resolveHat(ws(joinSpans([...sps].sort((a, b) => a.x0 - b.x0))).trim());

    for (const pg of pdf.pages) {
      const spans = [];
      for (const l of pg.lines) {
        if (!horizontal(l)) continue;
        for (const s of l.spans) {
          const t = fixGlyphs(s.text, s.font);
          if (t.trim()) spans.push({ text: t, x0: s.bbox[0], x1: s.bbox[2], y: (s.bbox[1] + s.bbox[3]) / 2, size: s.size, font: s.font });
        }
      }
      if (!spans.length) continue;
      const bodyLeft = globalBodyLeft;

      // margin note, boxed insert, or data table left of the body column?
      const leftSpans = spans.filter((sp) => sp.x1 < bodyLeft - 8);
      const leftChars = sum(leftSpans.map((sp) => sp.text.length));
      const bodyChars = sum(spans.filter((sp) => sp.x0 >= bodyLeft - 8).map((sp) => sp.text.length));
      const leftRowsCt = new Set(leftSpans.map((sp) => pyRound(sp.y))).size;
      const leftIsBox = leftRowsCt > 6 || leftChars > 400 || (bodyChars && leftChars > bodyChars * 0.4);
      const lrows = new Map();
      for (const sp of leftSpans) {
        const k = pyRound(sp.y);
        if (!lrows.has(k)) lrows.set(k, []);
        lrows.get(k).push(sp);
      }
      let tablike = 0;
      for (const sps of lrows.values()) if (/^[A-Z][A-Za-z]+(\s+[01](\s|$)){2,}/.test(joinSorted(sps))) tablike++;
      const leftIsTable = tablike >= 4;

      // group spans into visual rows (re-joins super/subscripts)
      spans.sort((a, b) => a.y - b.y || a.x0 - b.x0);
      const rows = [];
      let cur = [spans[0]];
      for (const s of spans.slice(1)) {
        if (Math.abs(s.y - cur.at(-1).y) <= 5) cur.push(s);
        else {
          rows.push(cur);
          cur = [s];
        }
      }
      rows.push(cur);

      let ordered = [];
      const pageAsides = [];
      const leftBlockRows = [];
      for (let row of rows) {
        const leftPart = row.filter((sp) => sp.x1 < bodyLeft - 8);
        const bodyPart = row.filter((sp) => sp.x1 >= bodyLeft - 8);
        let txt, aside, sz;
        if (leftIsTable) {
          if (leftPart.length) {
            const ltxt = joinSorted(leftPart);
            if (ltxt) leftBlockRows.push([ltxt, null]);
          }
          if (!bodyPart.length) continue;
          row = bodyPart;
          [txt, aside, sz] = rowText(row);
          if (!txt) continue;
        } else if (leftIsBox) {
          // boxed prose insert: defer it so the main narrative stays contiguous
          const boxPart = row.filter((sp) => sp.x0 < bodyLeft - 8);
          const mainPart = row.filter((sp) => sp.x0 >= bodyLeft - 8);
          if (boxPart.length) {
            const bx0 = Math.min(...boxPart.map((sp) => sp.x0));
            const ltxt = joinSorted(boxPart);
            if (ltxt) leftBlockRows.push([ltxt, bx0]);
          }
          if (!mainPart.length) continue;
          row = mainPart;
          [txt, aside, sz] = rowText(row);
          if (!txt) continue;
        } else {
          if (leftPart.length) {
            const mtxt = joinSorted(leftPart);
            if (mtxt.length > 3 && !repeated.has(mtxt) && !ROMAN_OR_DIGITS.test(mtxt)) pageAsides.push([mtxt, bodySize]);
          }
          if (!bodyPart.length) continue;
          row = bodyPart;
          [txt, aside, sz] = rowText(row);
          if (!txt) continue;
        }
        if (repeated.has(txt) || ROMAN_OR_DIGITS.test(txt)) continue;
        const col = twoCol ? (row[0].x0 < pageW * 0.5 ? 0 : 1) : 0;
        ordered.push([col, row[0].y, txt, sz, row[0].x0]);
        if (aside && aside.length > 3 && !repeated.has(aside)) pageAsides.push([aside, sz]);
      }
      if (twoCol) ordered = ordered.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

      // join body lines into paragraphs; a first-line indent starts a new one
      let bodyX0 = null;
      const bodyLines = ordered.filter((t) => t[3] < bodySize + 3);
      if (bodyLines.length) {
        const c = new Counter();
        bodyLines.forEach((t) => c.add(pyRound(t[4])));
        bodyX0 = c.mostCommon();
      }
      const paraBuf = [];
      const flushPara = () => {
        if (paraBuf.length) {
          const joined = ws(paraBuf.join(' ').trim());
          if (joined) parts.push(`<p>${esc(joined)}</p>`);
          paraBuf.length = 0;
        }
      };
      for (const [, , txt, sz, x0] of ordered) {
        if (sz >= bodySize + 3) {
          flushPara();
          if (title === null && sz >= bodySize + 6) {
            title = txt;
            parts.push(`<h1>${esc(txt)}</h1>`);
          } else parts.push(`<h2>${esc(txt)}</h2>`);
          continue;
        }
        let startsPara = bodyX0 !== null && x0 > bodyX0 + 3;
        if (startsWithAny(txt.trimStart(), ['•', '–', '-', '*'])) startsPara = true;
        if (startsPara) flushPara();
        paraBuf.push(txt);
      }
      flushPara();

      // deferred table rows / boxed prose
      if (leftBlockRows.length) {
        const boxX0s = leftBlockRows.map(([, x]) => x).filter((x) => x !== null);
        const boxBase = boxX0s.length ? Math.min(...boxX0s) : 0;
        const bbuf = [];
        let tableLines = [];
        const flushBox = () => {
          if (bbuf.length) {
            const j = ws(bbuf.join(' ')).trim();
            if (j) parts.push(`<p>${esc(j)}</p>`);
            bbuf.length = 0;
          }
        };
        for (const [ltxt, lx0] of leftBlockRows) {
          if (lx0 === null) {
            flushBox();
            tableLines.push(ltxt);
            continue;
          }
          if (tableLines.length) {
            parts.push('<p>' + tableLines.map(esc).join('<br/>') + '</p>');
            tableLines = [];
          }
          if (lx0 > boxBase + 3 || startsWithAny(ltxt.trimStart(), ['•', '–', '-', '*'])) flushBox();
          bbuf.push(ltxt);
        }
        flushBox();
        if (tableLines.length) parts.push('<p>' + tableLines.map(esc).join('<br/>') + '</p>');
      }
      for (const [aside] of pageAsides) parts.push(`<p><small>${esc(aside)}</small></p>`);
    }
    pdf.doc.destroy();
    return { parts, images, title: title || pdf.meta.title.trim() || stem, author: pdf.meta.author.trim(), twoCol };
  }

  // ================================================================ HTML clean-up
  const STRIP =
    'script,style,noscript,nav,footer,header,aside,form,iframe,button,' +
    '.advertisement,.ad,.cookie,.newsletter,.related,.sidebar,' +
    '[role=navigation],[role=banner],[aria-hidden=true]';

  function denoise(root) {
    root.querySelectorAll('svg,symbol,path,use,defs,script,style,noscript,meta,link,iframe,form,button').forEach((el) => el.remove());
  }

  function metaContent(doc, ...names) {
    for (const n of names) {
      const el = doc.querySelector(`meta[name="${n}"], meta[property="${n}"]`);
      if (el && el.getAttribute('content')) return el.getAttribute('content').trim();
    }
    return '';
  }
  function getTitle(doc, fallback) {
    let t = metaContent(doc, 'citation_title', 'og:title', 'dc.title', 'twitter:title');
    if (!t) {
      const h1 = doc.querySelector('h1');
      if (h1) t = h1.textContent;
    }
    if (!t && doc.title) t = doc.title;
    t = ws(t || '').trim();
    if (t.length > 45) t = t.replace(/\s*[|\-–—]\s*[^|\-–—]{1,40}$/, '');
    return t || fallback;
  }
  function getAuthors(doc) {
    const a = [...doc.querySelectorAll('meta[name="citation_author"]')].map((m) => (m.getAttribute('content') || '').trim()).filter(Boolean);
    if (a.length) return a.slice(0, 12);
    const one = metaContent(doc, 'author', 'article:author', 'dc.creator');
    return one ? [one] : [];
  }

  function bestSrc(img) {
    const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (ss) {
      let best = null;
      let bestW = -1;
      for (const part of ss.split(',')) {
        const bits = part.trim().split(/\s+/);
        if (!bits[0]) continue;
        const w = bits[1] && bits[1].endsWith('w') ? parseInt(bits[1], 10) || 0 : 0;
        if (w >= bestW) [best, bestW] = [bits[0], w];
      }
      if (best) return best;
    }
    for (const a of ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-full-src']) if (img.getAttribute(a)) return img.getAttribute(a);
    return null;
  }

  const IMG_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/webp': '.webp' };
  const EXT_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

  // Download images (≥1 KB; smaller ones are spacers/pixels) and point the
  // <img> at the packaged copy. pdfimg:N sources come from the PDF route.
  async function localizeImages(root, baseUrl, pdfImages, log, maxImages = 200) {
    const media = [];
    // arXiv embeds some figures as <object type="image/svg+xml">; the Python
    // version only looked at <img>, so these were silently dropped.
    root.querySelectorAll('object[data]').forEach((o) => {
      const data = o.getAttribute('data');
      if (/^image\//.test(o.getAttribute('type') || '') || /\.(svg|png|jpe?g|gif|webp)([?#]|$)/i.test(data)) {
        const img = root.ownerDocument.createElement('img');
        img.setAttribute('src', data);
        img.setAttribute('alt', o.getAttribute('aria-label') || '');
        if (o.className) img.className = o.className;
        o.replaceWith(img);
      }
    });
    const imgs = [...root.querySelectorAll('img')];
    imgs.slice(maxImages).forEach((i) => i.remove());
    const jobs = [];
    imgs.slice(0, maxImages).forEach((img, i) => {
      const src = bestSrc(img);
      if (!src) return img.remove();
      if (src.startsWith('pdfimg:')) {
        jobs.push([img, i, async () => pdfImages[Number(src.slice(7))]]);
        return;
      }
      jobs.push([
        img,
        i,
        async () => {
          const res = await fetch(new URL(src, baseUrl).href);
          if (!res.ok) return null;
          return res.blob();
        },
      ]);
    });
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const [img, i, get] = jobs[next++];
        let blob = null;
        try {
          blob = await get();
        } catch {}
        if (!blob || blob.size < 1024) {
          img.remove();
          continue;
        }
        let type = (blob.type || '').split(';')[0];
        if (!IMG_TYPES[type]) {
          const ext = ((bestSrc(img) || '').split(/[?#]/)[0].match(/\.[a-z]+$/i) || [''])[0].toLowerCase();
          type = EXT_TYPES[ext] || 'image/jpeg';
        }
        const name = `images/img${String(i).padStart(3, '0')}${IMG_TYPES[type]}`;
        media.push({ name, blob, type });
        img.setAttribute('src', name);
        for (const a of ['srcset', 'data-srcset', 'data-src', 'loading', 'decoding', 'sizes', 'width', 'height', 'style']) img.removeAttribute(a);
        if (!img.hasAttribute('alt')) img.setAttribute('alt', '');
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    log(`→ embedded ${media.length} image(s)`);
    return media;
  }

  function absolutizeLinks(root, baseUrl) {
    root.querySelectorAll('a[href]').forEach((a) => {
      const h = a.getAttribute('href');
      if (!/^(http|#|mailto:)/.test(h)) {
        try {
          a.setAttribute('href', new URL(h, baseUrl).href);
        } catch {
          a.removeAttribute('href');
        }
      }
    });
  }

  function dropDuplicateHeading(root, title) {
    const norm = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const want = norm(title);
    for (const h of [...root.querySelectorAll('h1, h2')].slice(0, 3)) {
      const got = norm(h.textContent);
      if (!got) continue;
      if (got === want || want.startsWith(got) || got.startsWith(want) || (got.length > 12 && (want.includes(got) || got.includes(want)))) {
        h.remove();
        return true;
      }
    }
    return false;
  }

  const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
  function sanitizeIds(root) {
    const seen = new Set();
    const remap = {};
    root.querySelectorAll('[id]').forEach((el) => {
      const raw = (el.getAttribute('id') || '').trim();
      if (!raw) return el.removeAttribute('id');
      let id = raw;
      if (!NCNAME.test(id)) id = 'x' + id.replace(/[^A-Za-z0-9_.-]/g, '-');
      if (seen.has(id)) return el.removeAttribute('id'); // first one wins
      if (id !== raw) remap[raw] = id;
      el.setAttribute('id', id);
      seen.add(id);
    });
    root.querySelectorAll('a[href^="#"]').forEach((a) => {
      const h = a.getAttribute('href').slice(1);
      if (remap[h]) a.setAttribute('href', '#' + remap[h]);
    });
  }

  const unwrap = (el) => el.replaceWith(...el.childNodes);

  function fixDanglingFragments(root) {
    const BLOCK = new Set(['div', 'section', 'article', 'figure', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'ol', 'ul', 'dl', 'img', 'figcaption', 'aside', 'blockquote', 'pre']);
    const valid = new Set();
    root.querySelectorAll('[id]').forEach((el) => {
      if (el.textContent.trim() || BLOCK.has(el.localName)) valid.add(el.getAttribute('id'));
    });
    root.querySelectorAll('[name]').forEach((el) => {
      if (el.textContent.trim()) valid.add(el.getAttribute('name'));
    });
    let fixed = 0;
    root.querySelectorAll('a[href^="#"]').forEach((a) => {
      if (!valid.has(a.getAttribute('href').slice(1))) {
        unwrap(a);
        fixed++;
      }
    });
    return fixed;
  }

  function namespaceIds(root, prefix = 'epubify-') {
    const refs = new Set([...root.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href').slice(1)).filter(Boolean));
    root.querySelectorAll('a[name], map[name]').forEach((el) => {
      const nm = (el.getAttribute('name') || '').trim();
      if (nm && refs.has(nm) && !el.getAttribute('id')) el.setAttribute('id', nm);
      el.removeAttribute('name');
    });
    root.querySelectorAll('[id]').forEach((el) => {
      const i = el.getAttribute('id');
      if (refs.has(i)) el.setAttribute('id', prefix + i);
      else el.removeAttribute('id');
    });
    root.querySelectorAll('a[href^="#"]').forEach((a) => {
      const h = a.getAttribute('href').slice(1);
      if (refs.has(h)) a.setAttribute('href', '#' + prefix + h);
    });
  }

  function fixAriaReferences(root) {
    const ids = new Set([...root.querySelectorAll('[id]')].map((e) => e.getAttribute('id')));
    for (const attr of ['aria-describedby', 'aria-labelledby', 'aria-details', 'aria-owns']) {
      root.querySelectorAll(`[${attr}]`).forEach((el) => {
        const keep = (el.getAttribute(attr) || '').split(/\s+/).filter((t) => ids.has(t));
        if (keep.length) el.setAttribute(attr, keep.join(' '));
        else el.removeAttribute(attr);
      });
    }
  }

  // EPUB-invalid attributes: bad target values, event handlers, and (new
  // here, since we serialize to XML ourselves) names that aren't valid XML.
  function stripBadAttributes(root) {
    const VALID_TARGET = new Set(['_blank', '_self', '_parent', '_top']);
    const OK_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
    root.querySelectorAll('*').forEach((el) => {
      for (const a of [...el.attributes]) {
        const n = a.name;
        if (n === 'target' && !VALID_TARGET.has(a.value)) el.removeAttribute(n);
        else if (n.startsWith('on')) el.removeAttribute(n);
        else if (!OK_NAME.test(n) && !/^(xml:lang|xlink:href|xmlns(:\w+)?)$/.test(n)) el.removeAttribute(n);
        // MathML Core's intent/arg aren't in the EPUB schema; rendering ignores them
        else if ((n === 'intent' || n === 'arg') && el.namespaceURI === 'http://www.w3.org/1998/Math/MathML') el.removeAttribute(n);
      }
    });
    root.querySelectorAll('a[href]').forEach((a) => {
      const h = a.getAttribute('href').trim().replace(/\s/g, '%20');
      let ok = h.startsWith('#') ? h.length > 1 : !/^mailto:$/i.test(h);
      if (ok && !h.startsWith('#')) {
        try {
          new URL(h);
        } catch {
          ok = false;
        }
      }
      if (ok) a.setAttribute('href', h);
      else a.removeAttribute('href');
    });
  }

  function cleanFragment(root, title) {
    dropDuplicateHeading(root, title);
    sanitizeIds(root);
    fixDanglingFragments(root);
    namespaceIds(root);
    fixAriaReferences(root);
    stripBadAttributes(root);
    fixDanglingFragments(root);
  }

  // ================================================================ sources
  async function fromArxivHtml(arxivId, log) {
    log(`→ fetching arXiv HTML for ${arxivId}`);
    let res;
    try {
      res = await fetch(`https://arxiv.org/html/${arxivId}`);
    } catch {
      throw new Error('could not reach arXiv');
    }
    if (!res.ok) {
      log(`  ! no HTML version on arXiv (older papers are PDF-only)`);
      return null;
    }
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const node = doc.querySelector('.ltx_document, article');
    if (!node || html.length < 3000) {
      log('  ! arXiv returned a page without a paper body');
      return null;
    }
    log('  using arXiv native HTML5');
    denoise(node);
    node.querySelectorAll(STRIP).forEach((el) => el.remove());
    return { doc, root: node, baseUrl: res.url, title: getTitle(doc, arxivId), authors: getAuthors(doc), sourceUrl: res.url, label: 'arXiv HTML' };
  }

  // Europe PMC serves open-access PubMed Central full text as JATS XML with
  // permissive CORS. Figure images are behind a bot wall, so figures keep
  // their captions only.
  async function fromEuropePmc(doi, log) {
    log('→ looking up open-access full text on Europe PMC');
    const q = encodeURIComponent(`DOI:"${doi}"`);
    const s = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${q}&format=json&resultType=lite`).then((r) => r.json());
    const hit = (s.resultList && s.resultList.result || []).find((r) => r.pmcid && r.isOpenAccess === 'Y') || (s.resultList && s.resultList.result || []).find((r) => r.pmcid);
    if (!hit) {
      log('  ! not in PubMed Central');
      return null;
    }
    const res = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/${hit.pmcid}/fullTextXML`);
    if (!res.ok) {
      log(`  ! ${hit.pmcid} has no open full text`);
      return null;
    }
    const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
    if (xml.querySelector('parsererror') || !xml.querySelector('body')) {
      log('  ! full text has no body');
      return null;
    }
    log(`  using Europe PMC full text (${hit.pmcid}); figure images not available`);
    const doc = document.implementation.createHTMLDocument('');
    const root = doc.createElement('div');
    jatsToHtml(xml, doc, root);
    const title = ws(xml.querySelector('article-meta title-group article-title')?.textContent || '').trim();
    const authors = [...xml.querySelectorAll('article-meta contrib[contrib-type="author"] name')].map((n) =>
      [n.querySelector('given-names')?.textContent, n.querySelector('surname')?.textContent].filter(Boolean).join(' ')
    );
    const url = `https://europepmc.org/article/PMC/${hit.pmcid}`;
    return { doc, root, baseUrl: url, title, authors, sourceUrl: url, label: 'Europe PMC' };
  }

  function jatsToHtml(xml, doc, root) {
    const el = (tag, ...kids) => {
      const e = doc.createElement(tag);
      kids.forEach((k) => k && e.append(k));
      return e;
    };
    const INLINE = { italic: 'i', bold: 'b', sup: 'sup', sub: 'sub', monospace: 'code', underline: 'u', sc: 'span' };
    const inline = (node, into) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) {
          into.append(c.textContent);
          continue;
        }
        if (c.nodeType !== 1) continue;
        const n = c.localName;
        if (INLINE[n]) inline(c, into.appendChild(doc.createElement(INLINE[n])));
        else if (n === 'ext-link' || n === 'uri') {
          const a = into.appendChild(doc.createElement('a'));
          const href = c.getAttribute('xlink:href') || c.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || c.textContent;
          if (/^https?:/.test(href)) a.setAttribute('href', href);
          inline(c, a);
        } else if (n === 'math') into.append(doc.importNode(c, true));
        else if (n === 'inline-formula') {
          const m = c.getElementsByTagNameNS('http://www.w3.org/1998/Math/MathML', 'math')[0];
          if (m) into.append(doc.importNode(m, true));
          else inline(c, into);
        } else if (n === 'break') into.append(doc.createElement('br'));
        else inline(c, into);
      }
      return into;
    };
    const block = (node, depth, into) => {
      for (const c of node.children) {
        const n = c.localName;
        if (n === 'title') into.append(inline(c, doc.createElement(`h${Math.min(6, depth + 1)}`)));
        else if (n === 'sec' || n === 'ack' || n === 'app' || n === 'boxed-text') block(c, depth + 1, into);
        else if (n === 'p') into.append(inline(c, doc.createElement('p')));
        else if (n === 'list') {
          const ol = doc.createElement(c.getAttribute('list-type') === 'order' ? 'ol' : 'ul');
          for (const li of c.querySelectorAll(':scope > list-item')) block(li, depth, ol.appendChild(doc.createElement('li')));
          into.append(ol);
        } else if (n === 'fig') {
          const cap = el('figcaption', inline(c.querySelector('label') || doc.createElement('x'), el('strong')), ' ');
          const capNode = c.querySelector('caption');
          if (capNode) [...capNode.children].forEach((k) => cap.append(inline(k, el('span')), ' '));
          into.append(el('figure', cap));
        } else if (n === 'table-wrap') {
          const fig = el('figure');
          const cap = el('figcaption', inline(c.querySelector('label') || doc.createElement('x'), el('strong')), ' ');
          const capNode = c.querySelector('caption');
          if (capNode) [...capNode.children].forEach((k) => cap.append(inline(k, el('span')), ' '));
          fig.append(cap);
          const t = c.querySelector('table');
          if (t) fig.append(copyTable(t));
          into.append(fig);
        } else if (n === 'disp-formula') {
          const m = c.getElementsByTagNameNS('http://www.w3.org/1998/Math/MathML', 'math')[0];
          const p = el('p');
          p.className = 'equation';
          if (m) {
            const mm = doc.importNode(m, true);
            mm.setAttribute('display', 'block');
            p.append(mm);
          } else inline(c, p);
          into.append(p);
        } else if (n === 'disp-quote') into.append(block(c, depth, el('blockquote')));
        else if (n === 'def-list') block(c, depth, into);
        else block(c, depth, into);
      }
      return into;
    };
    const copyTable = (t) => {
      const out = doc.createElement('table');
      const walk = (src, dst) => {
        for (const c of src.childNodes) {
          if (c.nodeType === 3) dst.append(c.textContent);
          else if (c.nodeType === 1) {
            const n = c.localName;
            if (['thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'col', 'colgroup'].includes(n)) {
              const e = dst.appendChild(doc.createElement(n));
              for (const a of ['colspan', 'rowspan']) if (c.getAttribute(a)) e.setAttribute(a, c.getAttribute(a));
              walk(c, e);
            } else if (INLINE[n]) walk(c, dst.appendChild(doc.createElement(INLINE[n])));
            else walk(c, dst);
          }
        }
      };
      walk(t, out);
      return out;
    };
    const abs = xml.querySelector('article-meta abstract:not([abstract-type])') || xml.querySelector('article-meta abstract');
    if (abs) {
      if (!abs.querySelector(':scope > title')) root.append(el('h2', 'Abstract'));
      block(abs, 1, root);
    }
    // depth 0 → top-level <sec> titles become <h2>, nested ones <h3>…
    block(xml.querySelector('body'), 0, root);
    const back = xml.querySelector('back');
    if (back) {
      for (const sec of back.querySelectorAll(':scope > ack, :scope > sec, :scope > app-group > app')) {
        // an <ack> without a <title> still deserves a heading
        if (sec.localName === 'ack' && !sec.querySelector(':scope > title')) {
          const t = xml.createElementNS(null, 'title');
          t.textContent = 'Acknowledgements';
          sec.insertBefore(t, sec.firstChild);
        }
        const holder = xml.createElementNS(null, 'holder');
        holder.append(sec.cloneNode(true));
        block(holder, 0, root);
      }
      const refs = back.querySelectorAll('ref-list ref');
      if (refs.length) {
        root.append(el('h2', 'References'));
        const ol = root.appendChild(el('ol'));
        refs.forEach((r) => ol.append(el('li', ws((r.querySelector('mixed-citation, element-citation, citation') || r).textContent).trim())));
      }
    }
    root.querySelectorAll('h1').forEach((h) => {
      const h2 = doc.createElement('h2');
      h2.append(...h.childNodes);
      h.replaceWith(h2);
    });
  }

  async function fromPdf(blob, filename, log) {
    log('→ reading PDF');
    const res = await pdfToHtml(blob, filename, log);
    const doc = document.implementation.createHTMLDocument('');
    const root = doc.createElement('div');
    root.innerHTML = res.parts.join('');
    return { doc, root, pdfImages: res.images, baseUrl: base, title: res.title, authors: res.author ? res.author.split(/;\s*/) : [], sourceUrl: null, label: 'PDF', twoCol: res.twoCol };
  }

  // ================================================================ EPUB build
  const xmlEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const BAD_XML = /[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g;

  function toXhtml(title, bodyNodes, extraHead = '') {
    const xdoc = document.implementation.createDocument(XHTML_NS, 'html', null);
    const html = xdoc.documentElement;
    html.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:epub', 'http://www.idpf.org/2007/ops');
    html.setAttribute('lang', 'en');
    html.setAttribute('xml:lang', 'en');
    const head = html.appendChild(xdoc.createElementNS(XHTML_NS, 'head'));
    head.appendChild(xdoc.createElementNS(XHTML_NS, 'title')).textContent = title;
    const link = head.appendChild(xdoc.createElementNS(XHTML_NS, 'link'));
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('type', 'text/css');
    link.setAttribute('href', 'style.css');
    const body = html.appendChild(xdoc.createElementNS(XHTML_NS, 'body'));
    for (const n of bodyNodes) body.appendChild(xdoc.importNode(n, true));
    // strip characters XML 1.0 forbids (garbled math glyphs etc.)
    const walker = xdoc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) if (BAD_XML.test(walker.currentNode.data)) walker.currentNode.data = walker.currentNode.data.replace(BAD_XML, '');
    return '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' + new XMLSerializer().serializeToString(xdoc).replace('</head>', extraHead + '</head>');
  }

  const CSS = `body{font-family:serif;line-height:1.5;margin:0 4%;}
h1,h2,h3,h4{font-family:sans-serif;line-height:1.25;}
h1.title{font-size:1.6em;margin-top:1em;}
p.byline{font-style:italic;}
img{max-width:100%;height:auto;}
figure{margin:1em 0;text-align:center;}
figcaption{font-size:.9em;text-align:left;}
table{border-collapse:collapse;font-size:.85em;display:block;overflow-x:auto;}
td,th{border:1px solid #9995;padding:.2em .4em;}
.equation,.ltx_equation{display:block;overflow-x:auto;}
.ltx_tag_equation{float:right;}
.ltx_bibitem{font-size:.9em;}
small{font-size:.85em;}
p.source{font-size:.8em;word-break:break-all;}
div.cover{text-align:center;}div.cover img{max-height:95vh;}`;

  async function buildEpub({ title, authors, sourceUrl, root, media, cover, id }) {
    const JSZip = await jszip();
    const doc = root.ownerDocument;

    // title block (pandoc made a title page; we put it at the top)
    const head = doc.createElement('header');
    const h1 = head.appendChild(doc.createElement('h1'));
    h1.className = 'title';
    h1.textContent = title;
    if (authors.length) {
      const by = head.appendChild(doc.createElement('p'));
      by.className = 'byline';
      by.textContent = authors.join(', ');
    }
    root.prepend(head);
    if (sourceUrl) {
      root.append(doc.createElement('hr'));
      const p = root.appendChild(doc.createElement('p'));
      p.className = 'source';
      p.append('Source: ');
      const a = p.appendChild(doc.createElement('a'));
      a.setAttribute('href', sourceUrl);
      a.textContent = sourceUrl;
    }

    // table of contents from headings (depth 3, like --toc-depth=3)
    const toc = [];
    root.querySelectorAll('h1, h2, h3').forEach((h, i) => {
      if (h === h1) return;
      const text = ws(h.textContent).trim();
      if (!text) return;
      const hid = h.getAttribute('id') || `toc-${i}`;
      h.setAttribute('id', hid);
      toc.push({ level: Number(h.localName[1]), text, id: hid });
    });
    const hasMath = !!root.getElementsByTagNameNS('http://www.w3.org/1998/Math/MathML', 'math').length;

    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file(
      'META-INF/container.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    );
    zip.file('OEBPS/style.css', CSS);
    zip.file('OEBPS/text.xhtml', toXhtml(title, [...root.childNodes]));
    // built in an inert document so the browser doesn't try to fetch cover.png
    const coverDiv = doc.createElement('div');
    coverDiv.className = 'cover';
    const cimg = coverDiv.appendChild(doc.createElement('img'));
    cimg.setAttribute('src', 'cover.png');
    cimg.setAttribute('alt', 'Cover');
    zip.file('OEBPS/cover.xhtml', toXhtml(title, [coverDiv]));
    zip.file('OEBPS/cover.png', cover);

    // nav document
    const navDoc = document.implementation.createHTMLDocument('');
    const nav = navDoc.createElement('nav');
    nav.setAttribute('epub:type', 'toc');
    nav.setAttribute('id', 'toc');
    nav.appendChild(navDoc.createElement('h1')).textContent = 'Contents';
    const top = nav.appendChild(navDoc.createElement('ol'));
    const stack = [{ level: 0, ol: top }];
    const tocItems = toc.length ? toc : [{ level: 1, text: title, id: '' }];
    for (const t of tocItems) {
      while (stack.length > 1 && stack.at(-1).level >= t.level) stack.pop();
      let parent = stack.at(-1).ol;
      const li = parent.appendChild(navDoc.createElement('li'));
      const a = li.appendChild(navDoc.createElement('a'));
      a.setAttribute('href', 'text.xhtml' + (t.id ? '#' + t.id : ''));
      a.textContent = t.text;
      const ol = navDoc.createElement('ol');
      stack.push({ level: t.level, ol, li });
      li.appendChild(ol);
    }
    nav.querySelectorAll('ol:empty').forEach((o) => o.remove());
    zip.file('OEBPS/nav.xhtml', toXhtml('Contents', [nav]).replace(/ epub-type=/g, ' epub:type='));

    for (const m of media) zip.file('OEBPS/' + m.name, m.blob);

    const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const manifest = [
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '<item id="css" href="style.css" media-type="text/css"/>',
      '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>',
      `<item id="text" href="text.xhtml" media-type="application/xhtml+xml"${hasMath ? ' properties="mathml"' : ''}/>`,
      '<item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>',
      ...media.map((m, i) => `<item id="img${i}" href="${xmlEsc(m.name)}" media-type="${m.type}"/>`),
    ];
    zip.file(
      'OEBPS/content.opf',
      `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">${xmlEsc(id)}</dc:identifier>
<dc:title>${xmlEsc(title)}</dc:title>
<dc:language>en</dc:language>
${authors.map((a) => `<dc:creator>${xmlEsc(a)}</dc:creator>`).join('\n')}
${sourceUrl ? `<dc:source>${xmlEsc(sourceUrl)}</dc:source>` : ''}
<meta property="dcterms:modified">${modified}</meta>
<meta name="cover" content="cover-image"/>
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine>
<itemref idref="cover"/>
<itemref idref="text"/>
</spine>
</package>`
    );
    return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
  }

  const safeName = (s) =>
    (s || 'article').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-').replace(/-{2,}/g, '-').replace(/^[ .-]+|[ .-]+$/g, '').slice(0, 110) || 'article';

  // ================================================================ public API
  /**
   * Make an EPUB for a paper. source: 'auto' | 'arxiv' | 'pmc' | 'pdf'.
   * Returns { file, cover, source, warnings }.
   */
  async function make(paper, { source = 'auto', pdf = null, log = () => {} } = {}) {
    const warnings = [];
    let src = null;
    const tryArxiv = (source === 'auto' || source === 'arxiv') && paper.arxiv;
    const tryPmc = (source === 'auto' || source === 'pmc') && paper.doi && !/^10\.48550\//i.test(paper.doi);
    if (tryArxiv) src = await fromArxivHtml(paper.arxiv, log).catch((e) => (log('  ! ' + e.message), null));
    if (!src && tryPmc) src = await fromEuropePmc(paper.doi, log).catch((e) => (log('  ! ' + e.message), null));
    if (!src && (source === 'auto' || source === 'pdf') && pdf) {
      src = await fromPdf(pdf.blob, pdf.name, log);
      if (src.twoCol) {
        const w = 'Two-column PDF: reading order may be scrambled and equations or tables lost. Reading the PDF directly is often better.';
        warnings.push(w);
        log('  ! ' + w);
      }
    }
    if (!src) throw new Error(pdf || source !== 'auto' ? 'No usable source found for this paper.' : 'No HTML version found. Attach the PDF first, then convert from it.');

    const title = paper.title || src.title;
    const authors = paper.authors && paper.authors.length ? paper.authors : src.authors;
    log(`→ title: ${title}`);
    const words = ws(src.root.textContent).trim().split(' ').length;
    log(`→ extracted ~${words} words`);
    if (words < 120) warnings.push('Very little text was extracted.');

    const media = await localizeImages(src.root, src.baseUrl, src.pdfImages || [], log);
    absolutizeLinks(src.root, src.baseUrl);
    cleanFragment(src.root, title);
    log('→ generating cover');
    const cover = await makeCover(title, authors[0] || '');
    log('→ packaging EPUB');
    const blob = await buildEpub({ title, authors, sourceUrl: src.sourceUrl, root: src.root, media, cover, id: paper.doi ? `doi:${paper.doi}` : `urn:paperreads:${paper.id}` });
    const file = new File([blob], safeName(title) + '.epub', { type: 'application/epub+zip' });
    log(`✓ ${file.name} (${Math.round(file.size / 1024)} KB)`);
    return { file, cover, source: src.label, warnings };
  }

  // Which sources could work for this paper, for the UI.
  function sources(paper, hasPdf) {
    const out = [];
    if (paper.arxiv) out.push(['arxiv', 'arXiv HTML']);
    if (paper.doi && !/^10\.48550\//i.test(paper.doi)) out.push(['pmc', 'Europe PMC (open-access papers)']);
    if (hasPdf) out.push(['pdf', 'Stored PDF']);
    return out;
  }

  return { make, sources, makeCover, epubjs, pdfToHtml };
})();

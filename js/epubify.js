/* epubify, ported to run in the browser.
 *
 * A port of the epubify.py script: deterministic generated covers, the
 * PyMuPDF-based PDF → HTML layout analysis (now on PDF.js), the HTML
 * clean-up passes, and EPUB packaging (JSZip instead of pandoc).
 *
 * Sources, best first (same preference as the script: HTML beats PDF):
 *   1. arXiv's native HTML       arxiv.org/html/<id>  (CORS-open)
 *   2. Europe PMC full text      JATS XML for open-access PubMed Central papers
 *   3. The paper's stored PDF    layout analysis: the columns are found page by page
 *                                (two, three, or a mix) and read in order
 * Not ported: ar5iv, publisher pages and the headless-browser renderer. Those
 * sites don't allow cross-origin requests from a web app.
 */
const Epubify = (() => {
  // Every request gets a time limit: a server that stalls (Europe PMC can sit
  // on a request for minutes) mustn't hold up everything after it.
  const fetchT = (url, opts = {}, ms = 20000) => {
    if (typeof AbortSignal === 'undefined' || !AbortSignal.timeout) return fetch(url, opts);
    const t = AbortSignal.timeout(ms);
    return fetch(url, { ...opts, signal: opts.signal ? (AbortSignal.any ? AbortSignal.any([opts.signal, t]) : opts.signal) : t });
  };

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
  // Superscript/subscript runs are carried through the text pipeline as
  // private-use markers and become <sup>/<sub> only when escaped to HTML,
  // so string checks keep working ("trials.³" still ends a sentence).
  const SUP = ['\uE010', '\uE011'];
  const SUB = ['\uE012', '\uE013'];
  const MARKS = /[\uE010-\uE013]/g;
  const stripMarks = (t) => String(t ?? '').replace(MARKS, '');
  const dropScripts = (t) => String(t ?? '').replace(/\uE010[^\uE011]*\uE011|\uE012[^\uE013]*\uE013/g, '').replace(MARKS, '');
  const ROMAN_OR_DIGITS = { test: (t) => /^[\divxlcIVXLC]{1,6}$/.test(stripMarks(t).trim()) };
  const endsWithAny = (s, chars) => chars.includes(dropScripts(s).trimEnd().slice(-1));
  // HTML-escape, then turn markers into balanced <sup>/<sub> tags
  function escRich(t) {
    let out = '';
    let open = null;
    for (const ch of esc(t)) {
      if (ch === SUP[0] || ch === SUB[0]) {
        if (open) out += `</${open}>`;
        open = ch === SUP[0] ? 'sup' : 'sub';
        out += `<${open}>`;
      } else if (ch === SUP[1] || ch === SUB[1]) {
        if (open) out += `</${open}>`;
        open = null;
      } else out += ch;
    }
    if (open) out += `</${open}>`;
    return mathLetters(out.replace(/<(sup|sub)>\s*<\/\1>/g, ''));
  }
  // Maths letters (𝑄, 𝜋, 𝐱) as plain letters in italic or bold: e-reader fonts
  // often lack the maths alphabets, and an accent on one ("𝑄̂") comes out as a box
  const MATH_RUN = /(?:[\u{1D400}-\u{1D7FF}][\u0300-\u036F]*)+/gu;
  function mathLetters(html) {
    return html.replace(MATH_RUN, (run) => {
      let out = '';
      let style = null;
      let buf = '';
      const flush = () => {
        if (buf) out += style ? `<${style}>${buf}</${style}>` : buf;
        buf = '';
      };
      for (const m of run.matchAll(/([\u{1D400}-\u{1D7FF}])([\u0300-\u036F]*)/gu)) {
        const cp = m[1].codePointAt(0);
        const italic = (cp >= 0x1d434 && cp <= 0x1d49b) || (cp >= 0x1d6e2 && cp <= 0x1d755);
        const bold = (cp >= 0x1d400 && cp <= 0x1d433) || (cp >= 0x1d6a8 && cp <= 0x1d6e1) || (cp >= 0x1d7ce && cp <= 0x1d7d7);
        const plain = italic || bold || m[2] || cp >= 0x1d7ce;
        const st = italic ? 'i' : bold ? 'b' : null;
        if (st !== style) flush();
        style = st;
        buf += (plain ? m[1].normalize('NFKC') : m[1]) + m[2];
      }
      flush();
      return out;
    });
  }
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
    // (wasmUrl: decoders for JPEG 2000 figures and ICC colours; without them those images render blank)
    const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), fontExtraProperties: true, isEvalSupported: false, wasmUrl: base + 'vendor/wasm/' }).promise;
    const pages = [];
    let piOneKeys = false; // the symbol font is used by its keys (see PI_ONE_KEYS)
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
            const remap = piGlyphs(f.differences);
            fonts[id] = { name: f.name || '', bold: !!f.bold, asc: f.ascent || 0.8, desc: f.descent || -0.2, remap, piKeys: !remap && /Mathematical\s?Pi-?\s?(One|1)\b/i.test(f.name || '') };
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
      // (only once a page shows the font used that way: nothing but those
      // keys, a digit or comma or full stop among them. A copy of the font
      // that comes with its own Unicode map gives the symbols themselves.)
      if (!piOneKeys) {
        const used = tc.items.filter((it) => it.str && fontInfo(it.fontName).piKeys).flatMap((it) => [...it.str]).filter((ch) => ch.trim());
        if (used.length && used.every((ch) => ch in PI_ONE_KEYS) && used.some((ch) => /[\d,.]/.test(ch))) piOneKeys = true;
      }
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
        // corners along the baseline direction and the "up" direction, so
        // sideways text (rotated tables) gets a true bounding box as well
        const ulen = Math.hypot(tx[2], tx[3]) || 1;
        const up = [tx[2] / ulen, tx[3] / ulen];
        const corners = [0, it.width].flatMap((a) => [f.asc, f.desc].map((h) => [x0 + dir[0] * a + up[0] * h * size, yb + dir[1] * a + up[1] * h * size]));
        const span = {
          text: f.remap ? [...it.str].map((ch) => f.remap[ch.codePointAt(0)] ?? ch).join('') : f.piKeys && piOneKeys ? [...it.str].map((ch) => PI_ONE_KEYS[ch] ?? ch).join('') : it.str,
          bbox: [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))],
          size,
          font: f.name,
          flags: f.bold || BOLD_FONT.test(f.name) ? 16 : 0,
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
      let raster = imageBoxes(lib, ops, vp);
      // A scan's recognised text often comes word by word or in pieces, each
      // its own "line". Put the pieces of a line back together (never across
      // a gap as wide as a column's), so lines can be told from table cells.
      if (raster.some((b) => (b[2] - b[0]) * (b[3] - b[1]) > vp.width * vp.height * 0.7)) joinWordLines(lines);
      const regions = vectorRegions(lib, ops, vp, lines);
      // A scanned page with recognised text over it: the scan isn't a figure.
      // Keep the text, and cut the figures and tables out of the scan.
      const pageScan = raster.find((b) => (b[2] - b[0]) * (b[3] - b[1]) > vp.width * vp.height * 0.7);
      let scan = null;
      if (pageScan && lines.filter((l) => l.spans.some((sp) => sp.text.trim())).length >= 5) {
        raster = raster.filter((b) => b !== pageScan);
        scan = { ink: await inkMeter(page, vp) }; // (cut up below, once the columns are known)
      }
      dropTextInside(lines, regions);
      const images = [...raster.filter((b) => !regions.some((r) => b[0] >= r[0] - 2 && b[1] >= r[1] - 2 && b[2] <= r[2] + 2 && b[3] <= r[3] + 2)), ...regions];
      pages.push({ page, vp, width: vp.width, height: vp.height, lines, images, scan, shades: shadeBoxes(lib, ops, vp) });
    }
    // Scanned pages: the figures and tables are cut out of the scan, each
    // within its own column (a table in the right column ends where that
    // column's text goes on, whatever stands beside it).
    if (pages.some((pg) => pg.scan)) {
      const sizes = new Counter();
      for (const pg of pages) for (const l of pg.lines) for (const s of l.spans) if (s.text.trim()) sizes.add(pyRound(s.size), s.text.trim().length);
      const layouts = docLayout(pages, sizes.mostCommon() ?? 11);
      pages.forEach((pg, i) => {
        if (!pg.scan) return;
        const leaves = layouts[i].leaves.filter((f) => f.items.length >= 3);
        const regions = [];
        if (leaves.length <= 1) regions.push(...scanRegions(pg.lines, pg.width, pg.height, pg.scan.ink));
        else
          for (const f of leaves) {
            const own = pg.lines.filter((l) => (l.bbox[0] + l.bbox[2]) / 2 >= f.x0 - 2 && (l.bbox[0] + l.bbox[2]) / 2 <= f.x1 + 2 && (l.bbox[1] + l.bbox[3]) / 2 >= f.y0 - 2 && (l.bbox[1] + l.bbox[3]) / 2 <= f.y1 + 2);
            regions.push(...scanRegions(own, pg.width, pg.height, pg.scan.ink, [f.x0, f.y0, f.x1, f.y1]));
          }
        dropTextInside(pg.lines, regions);
        pg.images.push(...regions);
      });
    }
    if (pages.length > 1) {
      const cover = pages[0].lines.map((l) => l.spans.map((sp) => sp.text).join('')).join(' ');
      if (/Disclaimer\s*\/\s*Complaints regulations/i.test(cover) && /Download date/i.test(cover)) pages.shift();
    }
    let meta = { title: '', author: '' };
    try {
      const md = await doc.getMetadata();
      meta = { title: md.info.Title || '', author: md.info.Author || '' };
    } catch {}
    return { doc, pages, meta };
  }

  // Text drawn inside a figure region is part of the picture: keep it out
  // of the running text (labels of a flow diagram, table cells)
  function dropTextInside(lines, regions) {
    if (!regions.length) return;
    const inside = (b) => regions.some((r) => (b[0] + b[2]) / 2 > r[0] && (b[0] + b[2]) / 2 < r[2] && (b[1] + b[3]) / 2 > r[1] && (b[1] + b[3]) / 2 < r[3]);
    for (const l of lines) l.spans = l.spans.filter((sp) => !inside(sp.bbox));
    for (let i = lines.length - 1; i >= 0; i--) if (!lines[i].spans.length) lines.splice(i, 1);
    for (const l of lines) {
      l.bbox = [
        Math.min(...l.spans.map((s) => s.bbox[0])),
        Math.min(...l.spans.map((s) => s.bbox[1])),
        Math.max(...l.spans.map((s) => s.bbox[2])),
        Math.max(...l.spans.map((s) => s.bbox[3])),
      ];
    }
  }

  // The straight lines of a drawn path, as [x0, y0, x1, y1] in the path's own
  // coordinates (PDF.js keeps a path as a run of numbers: 0 x y = move to,
  // 1 x y = line to, 2 … = curve, 3 … = curve, 4 = close)
  function pathLines(data) {
    const out = [];
    if (!data || typeof data.length !== 'number') return out;
    let cur = null;
    let start = null;
    for (let i = 0; i < data.length; ) {
      const op = data[i++];
      if (op === 0) {
        cur = start = [data[i], data[i + 1]];
        i += 2;
      } else if (op === 1) {
        const to = [data[i], data[i + 1]];
        i += 2;
        if (cur) out.push([cur[0], cur[1], to[0], to[1]]);
        cur = to;
      } else if (op === 2) {
        cur = [data[i + 4], data[i + 5]];
        i += 6;
        out.push(null); // (a curve: not a table's rules)
      } else if (op === 3) {
        cur = [data[i + 2], data[i + 3]];
        i += 4;
        out.push(null);
      } else if (op === 4) {
        if (cur && start && (cur[0] !== start[0] || cur[1] !== start[1])) out.push([cur[0], cur[1], start[0], start[1]]);
        cur = start;
      } else break;
    }
    return out.includes(null) ? [] : out;
  }

  // Figures drawn as vector graphics (charts, flow diagrams, ruled tables)
  // and sideways tables have no image to extract. Find them as clusters of
  // drawing operations and/or rotated text, to be rendered as pictures.
  function vectorRegions(lib, ops, vp, lines) {
    const O = lib.OPS;
    const W = vp.width;
    const H = vp.height;
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const boxes = [];
    const rules = []; // thin horizontal lines: the rules of a ruled table
    const frames = []; // big rectangles: a figure's or a table's frame
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
      else if (fn === O.constructPath && args) {
        const mm = args[args.length - 1];
        if (!mm || mm.length !== 4 || !isFinite(mm[0])) continue;
        const m = lib.Util.transform(vp.transform, ctm);
        const pts = [[mm[0], mm[1]], [mm[2], mm[1]], [mm[0], mm[3]], [mm[2], mm[3]]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
        const b = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
        const area = (b[2] - b[0]) * (b[3] - b[1]);
        if (b[2] - b[0] > W * 0.25 && b[3] - b[1] > H * 0.08 && !(b[2] - b[0] > W * 0.97 && b[3] - b[1] > H * 0.97)) frames.push(b);
        if (b[3] - b[1] >= 3 && !(b[3] < H * 0.07 || b[1] > H * 0.93)) {
          // all the rules of a table drawn as one path (its box is the whole
          // table, which can fill the page): each straight line across is a rule
          const segs = pathLines(args[1] && args[1][0]).map(([x0, y0, x1, y1]) => [[x0, y0], [x1, y1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]));
          const flat = segs.filter(([p, q]) => Math.abs(p[1] - q[1]) < 1 && Math.abs(p[0] - q[0]) > 40);
          // (a chart's grid lines are drawn the same way, so the path still counts as drawing)
          if (flat.length >= 2 && flat.length === segs.length) for (const [p, q] of flat) rules.push([Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])]);
        }
        if (area > W * H * 0.5) continue; // page background
        if (b[3] < H * 0.07 || b[1] > H * 0.93) continue; // header/footer bars, logos
        if (b[3] - b[1] < 3 && b[2] - b[0] > 40) rules.push(b);
        if (b[2] - b[0] > W * 0.85 && b[3] - b[1] < 3) continue; // full-width rules
        // a frame (or clipping box) around a figure together with its caption
        // holds lines of running text: it isn't part of the drawing, or the
        // caption would end up inside the picture, too small to read
        if (area > W * H * 0.05) {
          const wordy = lines.filter((l) => Math.abs(l.dir[0] - 1) <= 0.01 && (l.bbox[0] + l.bbox[2]) / 2 > b[0] && (l.bbox[0] + l.bbox[2]) / 2 < b[2] && (l.bbox[1] + l.bbox[3]) / 2 > b[1] && (l.bbox[1] + l.bbox[3]) / 2 < b[3] && l.bbox[2] - l.bbox[0] >= 150 && l.spans.map((s) => s.text).join('').trim().split(/\s+/).length >= 8);
          if (wordy.length >= 3) continue; // (long lines of words: a chart's legend and labels are short)
        }
        boxes.push({ b, w: 1, rot: 0 });
      }
    }
    for (const l of lines) {
      if (Math.abs(l.dir[0] - 1) <= 0.01) continue;
      // sideways text in the outer margin is page furniture ("first published as …")
      if ((l.bbox[0] + l.bbox[2]) / 2 > W * 0.94 || (l.bbox[0] + l.bbox[2]) / 2 < W * 0.06) continue;
      for (const sp of l.spans) if (sp.text.trim()) boxes.push({ b: sp.bbox, w: 2, rot: l.dir[1] < 0 ? 90 : -90, text: l.spans.map((x) => x.text).join(''), line: l });
    }
    const ruled = ruledTables(rules, lines, W, H);
    if (!boxes.length) return ruled;
    // cluster boxes that touch or nearly touch
    const parent = boxes.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    const near = (a, c, g = 8) => a[0] - g < c[2] && c[0] - g < a[2] && a[1] - g < c[3] && c[1] - g < a[3];
    boxes.sort((a, c) => a.b[0] - c.b[0]); // sweep by x: stop once a box starts past this one's right edge
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length && boxes[j].b[0] - 8 < boxes[i].b[2]; j++) if (near(boxes[i].b, boxes[j].b)) parent[find(i)] = find(j);
    }
    const groups = new Map();
    boxes.forEach((bx, i) => {
      const k = find(i);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(bx);
    });
    const out = [];
    const small = []; // (pieces too small to be a drawing: maybe a chart's axis title)
    for (const g of groups.values()) {
      const r = [Infinity, Infinity, -Infinity, -Infinity];
      for (const { b } of g) r.splice(0, 4, Math.min(r[0], b[0]), Math.min(r[1], b[1]), Math.max(r[2], b[2]), Math.max(r[3], b[3]));
      const weight = sum(g.map((x) => x.w));
      const rotated = g.filter((x) => x.rot);
      const w = r[2] - r[0];
      const h = r[3] - r[1];
      const drawn = weight >= 15 && w >= 80 && h >= 50;
      const sideways = rotated.length >= 6 && w >= 60 && h >= 60;
      if (!drawn && !sideways) {
        if (!g.some((x) => x.text)) small.push(r);
        continue;
      }
      const box = [Math.max(0, r[0] - 3), Math.max(0, r[1] - 3), Math.min(W, r[2] + 3), Math.min(H, r[3] + 3)];
      if (sideways && rotated.length * 2 > weight * 0.4) {
        const rot = new Counter();
        rotated.forEach((x) => rot.add(x.rot));
        box.rotate = rot.mostCommon();
        // a sideways caption ("Table 1 | …") is inside the region: lift it out
        const cap = rotated.map((x) => x.text).find((t) => CAPTION.test(t));
        if (cap) box.caption = ws(cap).trim();
      }
      box.vector = true;
      out.push(box);
    }
    // A chart drawn in outlines: its axis title (letters drawn as shapes,
    // turned on their side) sits further from the tick numbers than the
    // clustering bridges. Small pieces right beside a drawing, within its
    // height, belong to it.
    const fit = (r, box) => {
      const w = r[2] - r[0];
      const h = r[3] - r[1];
      // (a y-axis title: tall and narrow, beside the chart, best on its left)
      if (h >= 15 && h >= w * 2) {
        const overlapY = Math.min(r[3], box[3]) - Math.max(r[1], box[1]);
        const left = box[0] - r[2];
        const right = r[0] - box[2];
        if (overlapY >= h * 0.6 && left >= -2 && left <= 24) return Math.max(0, left);
        if (overlapY >= h * 0.6 && right >= -2 && right <= 24) return Math.max(0, right) + 20;
      }
      // (an x-axis title: wide and short, just under the chart)
      if (w >= h * 2 && h <= 20) {
        const overlapX = Math.min(r[2], box[2]) - Math.max(r[0], box[0]);
        const below = r[1] - box[3];
        if (overlapX >= w * 0.8 && below >= -2 && below <= 16) return Math.max(0, below);
      }
      return Infinity;
    };
    // (one pass, against the drawings as found: no chaining from piece to piece)
    const grow = [];
    for (const r of small) {
      let best = null;
      let bestD = Infinity;
      for (const box of out) {
        if (box.rotate) continue;
        const d = fit(r, box);
        if (d < bestD) (best = box), (bestD = d);
      }
      if (best) grow.push([best, r]);
    }
    for (const [best, r] of grow) best.splice(0, 4, Math.max(0, Math.min(best[0], r[0] - 3)), Math.max(0, Math.min(best[1], r[1] - 3)), Math.min(W, Math.max(best[2], r[2] + 3)), Math.min(H, Math.max(best[3], r[3] + 3)));
    // A chart's tick numbers and axis titles set as text just outside its
    // lines ("0.2 0.4 0.6", "Predicted risk"): short label-like lines at its
    // edges, lined up with it, are part of it (two passes: the numbers, then
    // the title beyond them)
    {
      const flatL = lines.filter((l) => Math.abs(l.dir[0] - 1) <= 0.01);
      const lineText = (l) => ws(l.spans.map((x) => x.text).join('')).trim();
      const labelish = (t) => t && t.length <= 40 && t.split(/\s+/).length <= 6 && !CAPTION.test(t) && !/[.!?]\s+\p{Lu}/u.test(t);
      const orig = out.map((b) => [...b]);
      const dist = (r, l) => Math.max(r[0] - l[2], l[0] - r[2], 0) + Math.max(r[1] - l[3], l[1] - r[3], 0);
      for (const [bi, box] of out.entries()) {
        if (box.rotate || (box[2] - box[0]) < 60 || (box[3] - box[1]) < 50) continue;
        // (never more than 36 pt past the drawing's own edge: labels, not the next panel)
        const o = orig[bi];
        const lim = [o[0] - 36, o[1] - 20, o[2] + 36, o[3] + 36];
        for (let pass = 0; pass < 2; pass++) {
          let grew = false;
          for (const l of flatL) {
            const [x0, y0, x1, y1] = l.bbox;
            if (x0 >= box[0] && x1 <= box[2] && y0 >= box[1] && y1 <= box[3]) continue; // (inside already)
            const t = lineText(l);
            if (!labelish(t)) continue;
            const h = y1 - y0;
            const overlapY = Math.min(y1, box[3]) - Math.max(y0, box[1]);
            const overlapX = Math.min(x1, box[2]) - Math.max(x0, box[0]);
            const left = box[0] - x1;
            const right = x0 - box[2];
            const below = y0 - box[3];
            const above = box[1] - y1;
            const beside = overlapY >= h * 0.6 && ((left >= -2 && left <= 30) || (right >= -2 && right <= 30));
            const under = overlapX >= (x1 - x0) * 0.8 && below >= -2 && below <= 22;
            const over = overlapX >= (x1 - x0) * 0.8 && above >= -2 && above <= 14 && h < 14;
            if (!beside && !under && !over) continue;
            if (x0 < lim[0] || y0 < lim[1] || x1 > lim[2] || y1 > lim[3]) continue;
            // (a label nearer another drawing is that one's)
            if (orig.some((r, j) => j !== bi && dist(r, l.bbox) < dist(o, l.bbox))) continue;
            box.splice(0, 4, Math.max(0, Math.min(box[0], x0 - 2)), Math.max(0, Math.min(box[1], y0 - 2)), Math.min(W, Math.max(box[2], x1 + 2)), Math.min(H, Math.max(box[3], y1 + 2)));
            grew = true;
          }
          if (!grew) break;
        }
      }
    }
    // A figure is everything between the text above it and its caption: the
    // drawings just over a "Fig N" caption, with the labels, numbers and
    // panel statistics around them (drawn as shapes or set as text), become
    // one picture as wide as what lies in that zone
    {
      const flatZ = lines.filter((l) => Math.abs(l.dir[0] - 1) <= 0.01);
      const tx = (l) => ws(l.spans.map((x) => x.text).join('')).trim();
      // (a boundary: running text, or another caption)
      const proseLine = (l) => {
        const t = tx(l);
        return CAPTION.test(t) || (t.split(/\s+/).length >= 6 && (t.match(/\p{Ll}/gu) || []).length > t.length * 0.5);
      };
      for (const cap of flatZ.filter((l) => /^\s*(fig(ure)?\.?)\s*\d/i.test(tx(l)))) {
        const [c0, ctop, c1] = cap.bbox;
        const above = out.filter((r) => !r.rotate && r[3] <= ctop + 4 && ctop - r[3] < 40 && r[0] < c1 && r[2] > c0);
        // (or a frame right over the caption: a panel of text and equations, Fig 1 as a box)
        const fr = frames.filter((f) => f[3] <= ctop + 4 && ctop - f[3] < 30 && f[0] >= c0 - 8 && f[2] <= c1 + 8 && f[2] - f[0] > (c1 - c0) * 0.4 && !(f[2] - f[0] > W * 0.97 && f[3] - f[1] > H * 0.97));
        const frameOnly = !above.length && fr.length;
        if (!above.length && !fr.length) continue;
        if (frameOnly) above.push(Object.assign([...fr.sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]))[0]], { vector: true }));
        const rTop = Math.min(...above.map((r) => r[1]));
        // (up to the last line of running text above the drawings, across the caption's width)
        const prose = flatZ.filter((l) => l !== cap && proseLine(l) && l.bbox[3] <= rTop + 2 && l.bbox[0] < c1 && l.bbox[2] > c0 && !above.some((r) => l.bbox[1] >= r[1] && l.bbox[3] <= r[3]));
        // (not the page's header band; and only near the drawings, not all of the
        // caption's width: a table can sit beside a figure)
        // (nor into another picture above: a figure's upper row of panels)
        const upper = out.filter((r) => !above.includes(r) && r[3] <= rTop + 2 && r[0] < c1 && r[2] > c0).map((r) => r[3] + 1);
        const top = Math.max(rTop - 60, H * 0.065, ...upper, ...prose.map((l) => l.bbox[3] + 2));
        const zx0 = Math.max(c0 - 8, Math.min(...above.map((r) => r[0])) - 40);
        const zx1 = Math.min(c1 + 8, Math.max(...above.map((r) => r[2])) + 40);
        const inZone = (b) => b[1] >= top - 1 && b[3] <= ctop + 1 && b[0] >= zx0 && b[2] <= zx1;
        // (labels in any direction: "Density" up the side; short ones)
        const parts = frameOnly ? [...above] : [...above, ...small.filter(inZone), ...lines.filter((l) => l !== cap && !proseLine(l) && tx(l).split(/\s+/).length <= 8 && inZone(l.bbox)).map((l) => l.bbox)];
        const box = [Math.max(0, Math.min(...parts.map((b) => b[0])) - 2), Math.max(0, Math.min(...parts.map((b) => b[1])) - 2), Math.min(W, Math.max(...parts.map((b) => b[2])) + 2), Math.min(H, Math.max(...parts.map((b) => b[3])) + 2)];
        if (box[3] > ctop) box[3] = ctop - 1;
        Object.assign(box, { vector: true });
        for (const r of above) if (out.includes(r)) out.splice(out.indexOf(r), 1);
        // (a picture that another one already holds, most of it, isn't a second one)
        const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
        const inter = (a, c) => area([Math.max(a[0], c[0]), Math.max(a[1], c[1]), Math.min(a[2], c[2]), Math.min(a[3], c[3])]);
        const holder = out.find((r) => inter(r, box) >= area(box) * 0.85);
        if (holder) holder.splice(0, 4, Math.min(holder[0], box[0]), Math.min(holder[1], box[1]), Math.max(holder[2], box[2]), Math.max(holder[3], box[3]));
        else out.push(box);
      }
    }
    // A page with a lot of sideways text (a table printed sideways): all of
    // it is the table, its caption and headers too. Its columns of numbers
    // sit further apart than the clustering bridges, so the pieces alone
    // left most of it out.
    for (const rot of [90, -90]) {
      const all = boxes.filter((x) => x.rot === rot);
      if (all.length < 40) continue;
      const box = [Math.max(0, Math.min(...all.map((x) => x.b[0])) - 3), Math.max(0, Math.min(...all.map((x) => x.b[1])) - 3), Math.min(W, Math.max(...all.map((x) => x.b[2])) + 3), Math.min(H, Math.max(...all.map((x) => x.b[3])) + 3)];
      // (unless a drawing already holds it: a chart with sideways labels)
      const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
      const inter = (a, c) => area([Math.max(a[0], c[0]), Math.max(a[1], c[1]), Math.min(a[2], c[2]), Math.min(a[3], c[3])]);
      if (out.some((r) => !r.rotate && inter(r, box) >= area(box) * 0.7)) continue;
      const cap = all.map((x) => x.text).find((t) => CAPTION.test(t));
      Object.assign(box, { rotate: rot, vector: true, caption: cap ? ws(cap).trim() : undefined });
      out.push(box);
    }
    // sideways pieces turned the same way are one sideways table (its rows
    // can sit further apart than the clustering bridges)
    for (const rot of [90, -90]) {
      const parts = out.filter((r) => r.rotate === rot);
      if (parts.length < 2) continue;
      const box = [Math.min(...parts.map((r) => r[0])), Math.min(...parts.map((r) => r[1])), Math.max(...parts.map((r) => r[2])), Math.max(...parts.map((r) => r[3]))];
      Object.assign(box, { rotate: rot, vector: true, caption: parts.map((r) => r.caption).find(Boolean) });
      out.splice(0, out.length, ...out.filter((r) => r.rotate !== rot), box);
    }
    out.push(...ruled);
    const framed = captionFrames(frames, lines, W, H);
    if (framed.length) {
      // a region centred in a frame gives way to it, unless it is the bigger
      // and holds only a figure's labels outside it (it may hold more of the figure)
      const prose = (r, f) => lines.some((l) => {
        const cx = (l.bbox[0] + l.bbox[2]) / 2;
        const cy = (l.bbox[1] + l.bbox[3]) / 2;
        const inR = cx > r[0] && cx < r[2] && cy > r[1] && cy < r[3];
        const inF = cx > f[0] && cx < f[2] && cy > f[1] && cy < f[3];
        // (the caption under the frame doesn't count)
        return inR && !inF && cy < f[3] + 4 && l.spans.map((sp) => sp.text).join(' ').trim().split(/\s+/).length >= 6;
      });
      const within = (r) => framed.some((f) => (r[0] + r[2]) / 2 > f[0] && (r[0] + r[2]) / 2 < f[2] && (r[1] + r[3]) / 2 > f[1] && (r[1] + r[3]) / 2 < f[3] && (r[2] - r[0] <= (f[2] - f[0]) * 1.1 || prose(r, f)));
      // A region much taller than the frame (several figures stacked over one
      // caption) stays, without the caption at its foot; the frame goes
      for (let i = framed.length - 1; i >= 0; i--) {
        const f = framed[i];
        const tall = out.find((r) => (r[0] + r[2]) / 2 > f[0] && (r[0] + r[2]) / 2 < f[2] && r[3] - r[1] > (f[3] - f[1]) * 1.3 && r[1] < f[1] - 10 && r[3] > f[1] && !prose(r, f));
        if (!tall) continue;
        if (f.frame && tall[3] > f[3]) tall[3] = Math.max(tall[1] + 20, f[3]);
        framed.splice(i, 1);
      }
      // (and a frame inside a bigger figure region that holds no running text is only part of it)
      for (let i = framed.length - 1; i >= 0; i--) {
        const f = framed[i];
        if (out.some((r) => r[0] <= f[0] + 2 && r[1] <= f[1] + 2 && r[2] >= f[2] - 2 && r[3] >= f[3] - 2 && (r[2] - r[0]) > (f[2] - f[0]) * 1.1 && !prose(r, f))) framed.splice(i, 1);
      }
      out.splice(0, out.length, ...framed, ...out.filter((r) => !within(r)));
    }
    // a region inside another is part of it
    return out.filter((r, i) => !out.some((o, j) => j !== i && o[0] <= r[0] && o[1] <= r[1] && o[2] >= r[2] && o[3] >= r[3] && (o[2] - o[0]) * (o[3] - o[1]) > (r[2] - r[0]) * (r[3] - r[1])));
  }

  function captionFrames(frames, lines, W, H) {
    const flat = lines.filter((l) => Math.abs(l.dir[0] - 1) <= 0.01);
    const text = (l) => ws(l.spans.map((x) => x.text).join('')).trim();
    const caps = flat.filter((l) => CAPTION.test(text(l)));
    const out = [];
    // the biggest frames first (frames nested over one caption: the outer one
    // holds all of the figure, its labels too)
    for (const f of [...frames].sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]))) {
      if (out.some((o) => Math.abs(o.frame[0] - f[0]) < 3 && Math.abs(o.frame[2] - f[2]) < 3 && Math.abs(o.frame[1] - f[1]) < 3)) continue;
      if (f[0] < -2 || f[2] > W + 2 || f[1] < -2 || f[3] > H + 2) continue; // (a fill running off the page is a chart's, not a frame)
      // (the caption starts at the frame's left edge, and is no wider than it)
      const across = (l) => Math.abs(l.bbox[0] - f[0]) < 12 && l.bbox[2] < f[2] + 10;
      // (under the frame, a caption can also start left of it and run wider:
      // an indented figure over a caption the column's width, as BMJ sets them)
      // (not much wider than the frame, though: a caption under two charts side by side belongs to both)
      const under = (l) => across(l) || (l.bbox[0] >= f[0] - 60 && l.bbox[0] <= f[0] + 12 && l.bbox[2] >= f[0] + (f[2] - f[0]) * 0.6 && l.bbox[2] - l.bbox[0] <= (f[2] - f[0]) * 1.8);
      const foot = caps.find((l) => under(l) && l.bbox[1] > f[1] + (f[3] - f[1]) * 0.5 && l.bbox[1] < f[3] + 14);
      const head = !foot && caps.find((l) => across(l) && l.bbox[1] >= f[1] - 2 && l.bbox[3] < f[1] + (f[3] - f[1]) * 0.25);
      if (!foot && !head) continue;
      // (a caption at the head can run on over a few lines)
      let headEnd = head ? head.bbox[3] : 0;
      if (head)
        for (const l of [...flat].sort((a, b) => a.bbox[1] - b.bbox[1])) {
          if (l.bbox[1] <= head.bbox[1] || Math.abs(l.bbox[0] - head.bbox[0]) > 3 || l.bbox[1] - headEnd > (head.bbox[3] - head.bbox[1]) * 0.8) continue;
          if (Math.abs((l.spans[0] || {}).size - (head.spans[0] || {}).size) > 0.6) break;
          headEnd = l.bbox[3];
        }
      const box = foot ? [f[0], f[1], f[2], Math.min(f[3], foot.bbox[1] - 2)] : [f[0], headEnd + 2, f[2], f[3]];
      if (box[3] - box[1] < 40) continue;
      // (a frame holding a caption and running text beside the figure is a page panel, not the figure)
      if (out.some((o) => box[0] < o[2] && o[0] < box[2] && box[1] < o[3] && o[1] < box[3])) continue;
      const r = Object.assign([Math.max(0, box[0]), Math.max(0, box[1]), Math.min(W, box[2]), Math.min(H, box[3])], { vector: true, frame: f });
      out.push(r);
    }
    return out;
  }

  // A table set as text between horizontal rules (APA, booktabs) has too
  // few drawn lines to look like a figure. Find it from its caption: a
  // "Table N" line with rules of the same width below it; the table runs
  // from the first rule to the last before the next caption.
  function ruledTables(rules, lines, W, H) {
    if (rules.length < 2) return [];
    // pieces of one rule (drawn per column) become one
    const rs = [];
    for (const b of [...rules].sort((a, c) => a[1] - c[1] || a[0] - c[0])) {
      const last = rs.find((r) => Math.abs(r[1] - b[1]) < 1.5 && b[0] <= r[2] + 6 && b[2] >= r[0] - 6);
      if (last) last.splice(0, 4, Math.min(last[0], b[0]), Math.min(last[1], b[1]), Math.max(last[2], b[2]), Math.max(last[3], b[3]));
      else rs.push([...b]);
    }
    const flat = lines.filter((l) => Math.abs(l.dir[0] - 1) <= 0.01);
    const text = (l) => ws(l.spans.map((x) => x.text).join('')).trim();
    const caps = flat.filter((l) => CAPTION.test(text(l)) && /^\s*t/i.test(text(l)));
    const out = [];
    for (const cap of caps) {
      const [cx0, , cx1, cy1] = cap.bbox;
      // the top rule: just below the caption (and its title), under it
      // (the caption starts at the table's left edge, or is centred over it)
      const centred = (r) => Math.abs((cx0 + cx1) / 2 - (r[0] + r[2]) / 2) < Math.max(12, (r[2] - r[0]) * 0.08);
      const top = rs.find((r) => r[1] > cy1 - 1 && r[1] - cy1 < 70 && r[0] < cx1 && r[2] > cx0 - 10 && (r[0] > cx0 - 40 || centred(r)));
      if (!top) continue;
      const nextCap = Math.min(H, ...caps.filter((c) => c !== cap && c.bbox[1] > top[1] && c.bbox[0] < top[2] && c.bbox[2] > top[0]).map((c) => c.bbox[1]));
      const same = rs.filter((r) => r !== top && r[1] > top[1] + 4 && r[1] < nextCap && Math.abs(r[0] - top[0]) < 8 && Math.abs(r[2] - top[2]) < 8);
      if (!same.length) continue;
      // (rules further down, past lines of running text, are the page's, not
      // the table's: the rule over the references under the article's last columns)
      // (a column of it: many lines of words, few figures, starting at one edge, narrower than the table)
      const wordy = (l, r) => text(l).split(/\s+/).length >= 6 && (text(l).match(/\d/g) || []).length < text(l).length * 0.1 && l.bbox[2] - l.bbox[0] < (r[2] - r[0]) * 0.6;
      const column = (ls) => {
        const at = new Counter();
        ls.forEach((l) => at.add(Math.round(l.bbox[0] / 3)));
        return ls.length && at.get(at.mostCommon()) >= 6;
      };
      let bottom = top;
      for (const r of same) {
        if (column(flat.filter((l) => (l.bbox[1] + l.bbox[3]) / 2 > bottom[1] && (l.bbox[1] + l.bbox[3]) / 2 < r[1] && l.bbox[0] < r[2] && l.bbox[2] > r[0] && wordy(l, r)))) break;
        bottom = r;
      }
      if (bottom === top) continue;
      // header rows can sit above the first rule (BMJ, BMC): the table starts
      // where the caption (and its title, aligned with it) ends
      let start = top[1] - 2;
      const capSize = cap.spans[0].size;
      let capEnd = cy1;
      const between = flat.filter((l) => l !== cap && l.bbox[1] >= cap.bbox[1] && (l.bbox[1] + l.bbox[3]) / 2 > cy1 && (l.bbox[1] + l.bbox[3]) / 2 < top[1] && l.bbox[0] < top[2] && l.bbox[2] > top[0]).sort((a, c) => a.bbox[1] - c.bbox[1]);
      let i = 0;
      const sameAxis = (l) => centred(top) && Math.abs((l.bbox[0] + l.bbox[2]) / 2 - (cx0 + cx1) / 2) < 12 && l.bbox[0] > top[0] + 12;
      while (i < between.length && (Math.abs(between[i].bbox[0] - cx0) < 3 || sameAxis(between[i])) && Math.abs(between[i].spans[0].size - capSize) < 0.8 && between[i].bbox[1] - capEnd < capSize * 0.8) capEnd = between[i++].bbox[3];
      if (i < between.length) start = Math.max(capEnd + 0.5, Math.min(...between.slice(i).map((l) => l.bbox[1])) - 2);
      const box = [top[0], start, top[2], bottom[3] + 2];
      // cells can stick out past the rules a little
      for (const l of flat) {
        const cy = (l.bbox[1] + l.bbox[3]) / 2;
        if (cy > box[1] && cy < box[3] && l.bbox[0] < box[2] && l.bbox[2] > box[0]) box.splice(0, 4, Math.min(box[0], l.bbox[0]), box[1], Math.max(box[2], l.bbox[2]), box[3]);
      }
      if (box[3] - box[1] < 20) continue;
      const r = [Math.max(0, box[0] - 3), Math.max(0, box[1] - 1, cy1 + 1.5), Math.min(W, box[2] + 3), Math.min(H, box[3] + 1)];
      r.vector = true;
      out.push(r);
    }
    return out;
  }

  function joinWordLines(lines) {
    const flat = lines.filter((l) => Math.abs(l.dir[0] - 1) <= 0.01 && l.spans.some((s) => s.text.trim()));
    if (flat.length < 5) return;
    flat.sort((a, b) => (a.bbox[1] + a.bbox[3]) / 2 - (b.bbox[1] + b.bbox[3]) / 2 || a.bbox[0] - b.bbox[0]);
    const rows = [];
    for (const l of flat) {
      const h = l.bbox[3] - l.bbox[1];
      // (the same line when they overlap in height by half the smaller: italics and capitals stand a little off)
      const r = rows.find((o) => Math.min(o.y1, l.bbox[3]) - Math.max(o.y0, l.bbox[1]) >= Math.min(h, o.y1 - o.y0) * 0.5);
      if (r) r.items.push(l);
      else rows.push({ y0: l.bbox[1], y1: l.bbox[3], items: [l] });
    }
    const out = [];
    for (const r of rows) {
      r.items.sort((a, b) => a.bbox[0] - b.bbox[0]);
      let cur = null;
      for (const l of r.items) {
        const size = l.spans[0].size;
        if (cur && l.bbox[0] - cur.bbox[2] <= Math.max(4, size * 0.6)) {
          if (!/\s$/.test(cur.spans.at(-1).text) && !/^\s/.test(l.spans[0].text)) cur.spans.push({ ...l.spans[0], text: ' ', bbox: [cur.bbox[2], l.bbox[1], l.bbox[0], l.bbox[3]] });
          cur.spans.push(...l.spans);
          cur.bbox = [cur.bbox[0], Math.min(cur.bbox[1], l.bbox[1]), l.bbox[2], Math.max(cur.bbox[3], l.bbox[3])];
        } else {
          cur = { dir: l.dir, spans: [...l.spans], bbox: [...l.bbox] };
          out.push(cur);
        }
      }
    }
    const rest = lines.filter((l) => !flat.includes(l));
    lines.splice(0, lines.length, ...out, ...rest);
  }

  // Figures and tables inside a page scan. The text layer marks them out: a
  // figure fills the gap between its caption and the full line of text
  // above it; a table runs from under its caption (and capitalised title)
  // to the next full line of text below.
  // How much of a box is ink that isn't recognised text (drawing, rules),
  // from a quick low-resolution render of the scanned page.
  async function inkMeter(page, vp) {
    try {
      const scale = 0.5;
      const v = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(v.width);
      canvas.height = Math.ceil(v.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: ctx, viewport: v }).promise;
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      return (box, textBoxes) => {
        let ink = 0;
        let n = 0;
        for (let y = Math.max(0, Math.floor(box[1] * scale)); y < Math.min(canvas.height, box[3] * scale); y++) {
          for (let x = Math.max(0, Math.floor(box[0] * scale)); x < Math.min(canvas.width, box[2] * scale); x++) {
            n++;
            const i = (y * canvas.width + x) * 4;
            if (px[i] + px[i + 1] + px[i + 2] > 600) continue; // (faint strokes of thin type count)
            const X = x / scale;
            const Y = y / scale;
            if (!textBoxes.some((b) => X >= b[0] - 2 && X <= b[2] + 2 && Y >= b[1] - 2 && Y <= b[3] + 2)) ink++;
          }
        }
        return n ? ink / n : 0;
      };
    } catch {
      return null;
    }
  }

  function scanRegions(lines, W, H, ink, zone = null) {
    const flat = lines.filter((l) => Math.abs(l.dir[0] - 1) <= 0.01 && l.spans.some((sp) => sp.text.trim())).sort((a, c) => a.bbox[1] - c.bbox[1]);
    if (!flat.length) return [];
    const text = (l) => ws(l.spans.map((x) => x.text).join(' ')).trim();
    const left = Math.min(...flat.map((l) => l.bbox[0]));
    const right = Math.max(...flat.map((l) => l.bbox[2]));
    const bodyW = right - left;
    // running text: wide and wordy (figure labels and table rows aren't)
    const upper = (t) => {
      const letters = t.replace(/[^\p{L}]/gu, '');
      return letters.length >= 4 && letters.replace(/\p{Lu}/gu, '').length <= letters.length * 0.15;
    };
    // (a table's header row spreads its words out: wide gaps between pieces)
    const spread = (l) => {
      const sp = l.spans.filter((x) => x.text.trim()).sort((a, c) => a.bbox[0] - c.bbox[0]);
      return sp.some((x, k) => k && x.bbox[0] - sp[k - 1].bbox[2] > (l.bbox[3] - l.bbox[1]) * 2.5);
    };
    // (a narrow column's lines hold fewer words)
    const prose = (l) => l.bbox[2] - l.bbox[0] > bodyW * 0.6 && text(l).split(/\s+/).length >= (bodyW < 200 ? 5 : 7) && !upper(text(l)) && !spread(l);
    const header = flat[0].bbox[1] < H * 0.1 && !prose(flat[0]) ? flat[0] : null;
    const size = (l) => l.bbox[3] - l.bbox[1];
    const out = [];
    for (const [i, cap] of flat.entries()) {
      const m = CAPTION.exec(text(cap));
      if (!m) continue;
      const box = [left, 0, right, 0];
      if (/^t/i.test(m[1])) {
        // caption, then its title lines (APA: in capitals), then the table
        let j = i + 1;
        let last = cap;
        // (or a title run on under the caption on the same axis, centred or
        // flush left: "Table 2—Comparison of … / Gas Values and … / Extubated*")
        const axis = (l) => Math.abs((l.bbox[0] + l.bbox[2]) / 2 - (cap.bbox[0] + cap.bbox[2]) / 2) < 15 || Math.abs(l.bbox[0] - cap.bbox[0]) < 3;
        const runsOn = (l) => text(l).split(/\s+/).length >= 2 && !spread(l) && axis(l) && !/[.*]\s*$/.test(text(last)) && /\p{L}{3}/u.test(text(l)) && !/\d\s*$/.test(text(l));
        while (j < flat.length && (upper(text(flat[j])) || runsOn(flat[j])) && flat[j].bbox[1] - last.bbox[3] < size(last) * 2) last = flat[j++];
        // (it ends at running text: two such lines one under the other; a wordy row of the table stands alone)
        const end = flat.slice(j).findIndex((l, k, rest) => {
          if (!prose(l)) return false;
          const next = rest.slice(k + 1).find((o) => o.bbox[1] > l.bbox[1] + 2);
          return !next || (prose(next) && next.bbox[1] - l.bbox[3] < size(l) * 1.8);
        });
        const rows = end < 0 ? flat.slice(j) : flat.slice(j, j + end);
        if (!rows.length) continue;
        box[1] = last.bbox[3] + 4;
        box[3] = Math.min(end < 0 ? H * 0.95 : flat[j + end].bbox[1] - 2, Math.max(...rows.map((l) => l.bbox[3])) + 10);
      } else {
        // the figure is above its caption, below the running text before it
        const above = flat.slice(0, i).reverse().find((l) => prose(l) || l === header);
        box[1] = above ? above.bbox[3] + 3 : zone ? zone[1] : H * 0.06;
        box[3] = cap.bbox[1] - 2;
      }
      if (box[3] - box[1] < 30) continue;
      const r = [Math.max(0, box[0] - 6), box[1], Math.min(W, box[2] + 6), box[3]];
      r.vector = true;
      out.push(r);
    }
    // the recognised text can stray off the page: take the sides from the ink
    const sides = (r) => {
      if (!ink) return r;
      let [x0, , x1] = zone ? [Math.max(0, zone[0] - 10), 0, Math.min(W, zone[2] + 10)] : [W * 0.03, 0, W * 0.97];
      while (x1 - x0 > 40 && ink([x0, r[1], x0 + 4, r[3]], []) < 0.001) x0 += 4;
      while (x1 - x0 > 40 && ink([x1 - 4, r[1], x1, r[3]], []) < 0.001) x1 -= 4;
      return Object.assign([Math.max(0, x0 - 8), r[1], Math.min(W, x1 + 8), r[3]], { vector: true });
    };
    // Figures whose caption the recognition missed: a tall stretch without
    // running text where the scan has drawing beyond the recognised words.
    if (ink) {
      const top = zone ? zone[1] : header ? header.bbox[3] + 3 : H * 0.05;
      const marks = [top, ...flat.filter(prose).flatMap((l) => [l.bbox[1], l.bbox[3]]), zone ? zone[3] : H * 0.95].sort((a, c) => a - c);
      const textBoxes = flat.map((l) => l.bbox);
      for (let i = 0; i + 1 < marks.length; i++) {
        const box = [zone ? zone[0] - 6 : W * 0.03, marks[i] + 3, zone ? zone[2] + 6 : W * 0.97, marks[i + 1] - 3];
        if (box[3] - box[1] < 60) continue;
        if (out.some((o) => Math.min(o[3], box[3]) - Math.max(o[1], box[1]) > (box[3] - box[1]) * 0.3)) continue;
        // (ink the recognition didn't cover is content the reader would lose)
        if (ink(box, textBoxes) < 0.005) continue;
        // trim to where the ink and text are
        const inside = flat.filter((l) => (l.bbox[1] + l.bbox[3]) / 2 > box[1] && (l.bbox[1] + l.bbox[3]) / 2 < box[3]);
        let y0 = box[1];
        let y1 = box[3];
        while (y1 - y0 > 20 && ink([box[0], y1 - 8, box[2], y1], []) < 0.002 && !inside.some((l) => l.bbox[3] > y1 - 8)) y1 -= 8;
        while (y1 - y0 > 20 && ink([box[0], y0, box[2], y0 + 8], []) < 0.002 && !inside.some((l) => l.bbox[1] < y0 + 8)) y0 += 8;
        out.push([box[0], y0, box[2], y1]);
      }
    }
    return out.map(sides);
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

  // Filled rectangles drawn across much of the page (a shaded box, a panel):
  // their boxes in page coordinates. A page's background is not one.
  function shadeBoxes(lib, ops, vp) {
    const O = lib.OPS;
    const W = vp.width;
    const H = vp.height;
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const out = [];
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
      else if (fn === O.constructPath && args) {
        const mm = args[args.length - 1];
        if (!mm || mm.length !== 4 || !isFinite(mm[0])) continue;
        const m = lib.Util.transform(vp.transform, ctm);
        const pts = [[mm[0], mm[1]], [mm[2], mm[3]]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
        const b = [Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]), Math.max(pts[0][0], pts[1][0]), Math.max(pts[0][1], pts[1][1])];
        const w = b[2] - b[0];
        const h = b[3] - b[1];
        if (w > W * 0.4 && h > H * 0.03 && w * h < W * H * 0.5) out.push(b);
      }
    }
    return out;
  }

  // Which "Figure N" caption on this page belongs to an image? The nearest
  // one, preferring captions below the image (the usual layout).
  // (case-insensitive: small-caps captions extract as "fig 1 |", "table 2 |")
  // "Figure 2." / "fig 1 |" / "Figure 2 (A) …" / "Figure 4 Estimated …", but not "Figure 2 shows" or "Figure 2A shows"
  // ("Table 3—Hospital Outcome…": a dash after the number; a scan can read the 1 of "Table 1—" as "!", "l" or "I")
  const CAPTION = /^\s*([Ff][Ii][Gg](?:[Uu][Rr][Ee])?\.?|[Tt][Aa][Bb][Ll][Ee])\s*([A-Z]?\d+|[!lI](?=\s?[—–-]\s?\p{Lu}))\s*(?:[.:|]|[—–-](?=\s?\p{Lu})|$|(?<=\s)(?=\(|\p{Lu}\p{Ll}|\p{Lu}{3,}\s))/u;
  const captionKey = (m) => `${/^t/i.test(m[1]) ? 'table' : 'figure'}-${m[2]}`;
  function captionNumber(box, rows) {
    if (box.caption) {
      const m = CAPTION.exec(box.caption);
      if (m) return captionKey(m);
    }
    let best = null;
    let bestD = Infinity;
    for (const r of rows) {
      const m = CAPTION.exec(stripMarks(r.text));
      if (!m) continue;
      const below = r.y0 - box[3];
      const above = box[1] - r.y1;
      const d = below >= -6 ? below : above >= -6 ? above + 40 : Infinity;
      if (d < bestD) [best, bestD] = [captionKey(m), d];
    }
    return bestD < 250 ? best : null;
  }
  // a sideways caption lifted out of a region comes right after its picture
  const imgTag = (n, fig, box) =>
    `<p><img src="pdfimg:${n}" alt=""${fig ? ` data-fig="${fig}"` : ''}/></p>` + (box && box.caption ? `<p>${escRich(box.caption)}</p>` : '');

  // Spans (sorted by height on the page, each with .y its middle) into lines.
  function lineRows(group, bodySize, c = 0) {
    // Lines from the full-size type; then each small piece (a sub- or
    // superscript, an accent) joins the line it sits on. Chained
    // together, the pieces of maths between two lines would glue the
    // lines into one ("When 𝑄̂ FQE has / been learned").
    // (a stretched bracket on its own sits off the middle of its line too)
    const DELIM = /^[\s[\](){}|⟨⟩‖]+$/;
    const reach = (s) => (DELIM.test(s.text) ? 10 : 6);
    const small = (s) => (s.size < bodySize * 0.85 || DELIM.test(s.text)) && group.some((o) => o !== s && o.size >= bodySize * 0.85 && !DELIM.test(o.text) && Math.abs(o.y - s.y) <= reach(s));
    const own = [];
    let cur = null;
    for (const s of group) {
      if (small(s)) continue;
      if (cur && Math.abs(s.y - cur.at(-1).y) <= 5 && Math.abs(s.y - cur.base) <= 5) cur.push(s);
      else {
        if (cur) own.push(cur);
        cur = [s];
        cur.col = c;
        cur.base = s.y;
      }
    }
    if (cur) own.push(cur);
    for (const s of group) {
      if (!small(s)) continue;
      let best = null;
      for (const r of own) if (Math.abs(r.base - s.y) <= reach(s) && (!best || Math.abs(r.base - s.y) < Math.abs(best.base - s.y))) best = r;
      if (best) best.push(s);
      else {
        const r = [s];
        r.col = c;
        r.base = s.y;
        own.push(r);
      }
    }
    own.sort((a, b) => a.base - b.base);
    return own;
  }

  // Display equations: lines mostly of maths, set off from the text
  // (indented, or numbered "(8)" at the right), become pictures of
  // themselves: as text their pieces come out jumbled or dropped.
  // rows: arrays of spans { text, x0, x1, y (middle), size, font }, each
  // with .col and .base (the line's middle). → crop boxes, each with .reg
  // (its rows) and .alt.
  // (LaTeX sets maths in ordinary letters, in its own maths fonts)
  const EQ_FONT = /CMMI|CMSY|CMEX|CMBSY|MSBM|MSAM|EUSM|EUFM|RSFS|TXMI|TXSY|NewTXMI|LMMath|STIXMath|Cambria.?Math|XITSMath|MathematicalPi|MTMI|MTSY|Symbol/i;
  function findEquations(rows, bodySize) {
    const MATH = /[\u{1D400}-\u{1D7FF}\u0370-\u03FF∑∏∫∮∈∉⊂⊆∪∩≤≥≠≈≡∝∞∀∃∂∇√±∓×÷·⋅∗∣‖′″∧∨¬⇒⇔→↦⊧⊢…\u0302\u0303\u0304\u0307=<>+−^_|∶]/u;
    const MATH_WORD = /^(?:max|min|arg|argmax|argmin|sup|inf|lim|log|exp|sin|cos|tan|det|var|cov|mod|tr|diag|sgn|softmax)$/;
    const STRONG = /[\u{1D400}-\u{1D7FF}∑∏∫∮∈∉⊂⊆∪∩≡∝∞∀∃∂∇√∧∨¬⇒⇔→↦⊧⊢∣‖\u0302\u0303\u0304\u0307]/u;
    const NUMBER = /^\(\d{1,3}[a-z]?\)$/;
    const textOf = (r) => [...r].sort((a, b) => a.x0 - b.x0).map((z) => z.text).join(' ');
    // characters of maths, of signs only maths uses, and plain words, in some spans
    const tally = (spans) => {
      let n = 0;
      let m = 0;
      let strong = 0;
      let words = 0;
      for (const z of spans) {
        const mf = EQ_FONT.test(z.font || '');
        const cps = [...z.text.replace(/[\s\d.,;:()[\]{}]/g, '')]; // (numbers and brackets count for neither)
        n += cps.length;
        for (const ch of cps) {
          if (mf || MATH.test(ch)) m++;
          if ((mf && /\p{L}|[^\x00-\x7f]/u.test(ch)) || STRONG.test(ch)) strong++;
        }
        if (!mf) words += (z.text.match(/(?<![\p{L}\d])[a-z]{3,}(?![\p{L}\d])/gu) || []).filter((w) => !MATH_WORD.test(w)).length; // plain words, not maths letters
      }
      return { n, m, strong, words };
    };
    const mathy = (r) => {
      const { n, m, strong, words } = tally(r);
      // (at least one sign only maths uses: a table row of "12.1 ± 3.4 < 0.05" isn't maths)
      return n >= 2 && strong >= 1 && m >= 2 && m >= n * 0.3 && words <= 3;
    };
    // an equation number: "(8)", the last thing on its line, well clear of the maths
    // (not the "(1)" of a superscript like v⁽¹⁾)
    const numberSpan = (r) => {
      const sp = [...r].sort((a, b) => a.x0 - b.x0);
      const last = sp.at(-1);
      if (!last || !NUMBER.test(last.text.trim())) return null;
      const before = sp.at(-2);
      return !before || last.x0 - before.x1 > bodySize * 1.5 ? last : null;
    };
    const numbered = (r) => !!numberSpan(r);
    const rights = new Counter();
    rows.filter((r) => r.length && textOf(r).length > 40).forEach((r) => rights.add(`${r.col}:${pyRound(Math.max(...r.map((z) => z.x1)))}`));
    const rightOf = (c) => {
      let best = null;
      for (const [k, n] of rights.entries()) if (k.startsWith(c + ':') && (!best || n > best[1])) best = [Number(k.split(':')[1]), n];
      return best ? best[0] : null;
    };
    const lefts = new Counter();
    rows.filter((r) => r.length && textOf(r).length > 40).forEach((r) => lefts.add(`${r.col}:${pyRound(Math.min(...r.map((z) => z.x0)))}`));
    const leftOf = (c) => {
      let best = null;
      for (const [k, n] of lefts.entries()) if (k.startsWith(c + ':') && (!best || n > best[1])) best = [Number(k.split(':')[1]), n];
      return best ? best[0] : null;
    };
    const indented = (r) => {
      const left = leftOf(r.col);
      return left !== null && Math.min(...r.map((z) => z.x0)) - left > 12;
    };
    const prose = (r) => textOf(r).length > 40 && !indented(r);
    const cand = rows.filter((r) => r.col >= -1 && r.length && mathy(r));
    const used = new Set();
    const regions = [];
    for (const r of cand.sort((a, b) => a.base - b.base)) {
      if (used.has(r)) continue;
      const reg = [r];
      used.add(r);
      // the lines of one equation, and the bits of maths between them
      for (let grew = true; grew; ) {
        grew = false;
        const lo = Math.min(...reg.map((x) => x.base));
        const hi = Math.max(...reg.map((x) => x.base));
        for (const o of rows) {
          if (used.has(o) || o.col !== r.col || !o.length) continue;
          const near = o.base > lo - bodySize * 1.9 && o.base < hi + bodySize * 1.9;
          if (near && (mathy(o) || (o.base > lo && o.base < hi) || textOf(o).trim().length <= 3 || numbered(o) || (indented(o) && !prose(o) && o.base > lo - bodySize * 1.6 && o.base < hi + bodySize * 1.6))) {
            reg.push(o);
            used.add(o);
            grew = true;
          }
        }
      }
      regions.push(reg);
    }
    const boxes = [];
    for (const reg of regions) {
      const all = reg.flat();
      const x0 = Math.min(...all.map((z) => z.x0));
      // (one equation number goes beside the picture as text: cropped with it,
      // the gap to the margin would shrink the maths on a phone)
      const nums = reg.map(numberSpan).filter(Boolean);
      const inner = nums.length === 1 ? all.filter((z) => z !== nums[0]) : all;
      const x1 = Math.max(...inner.map((z) => z.x1));
      const left = leftOf(reg[0].col);
      const lo = Math.min(...reg.map((x) => x.base));
      const hi = Math.max(...reg.map((x) => x.base));
      // (an unnumbered bit of maths with running text right beside it is inline: a tall fraction in a sentence)
      const inline = !reg.some(numbered) && rows.some((o) => o.col === reg[0].col && !reg.includes(o) && prose(o) && o.base > lo - bodySize * 1.1 && o.base < hi + bodySize * 1.1);
      const setOff = !inline && (reg.some(numbered) || reg.length >= 2 || (left !== null && x0 - left > 12));
      const txt = textOf(all);
      // (a block full of words, or of numbers, is a table or a list, not an equation)
      const wordy = (txt.match(/(?<![\p{L}\d])[A-Za-z]{3,}(?![\p{L}\d])/gu) || []).length > reg.length * 2 + 4 ||
        tally(all).strong < reg.length * 1.5; // (a table of numbers with a symbol here and there)
      // (numbered lines of an algorithm, "6: Define a* = …", are a listing)
      const listing = reg.some((r) => /^\d{1,3}:$/.test([...r].sort((p, q) => p.x0 - q.x0)[0].text.trim()));
      // (a sentence with maths in it, a full line of the text: "where F(s) = … and …")
      const right = rightOf(reg[0].col);
      const sentence = tally(all).words >= 3 && reg.some((r) => !indented(r) && right !== null && Math.max(...r.filter((z) => z !== numberSpan(r)).map((z) => z.x1)) > right - 10);
      if (!setOff || wordy || listing || sentence || txt.replace(/\s/g, '').length < 4) continue;
      let y0 = Math.min(...all.map((z) => z.y - z.size * 0.8));
      let y1 = Math.max(...all.map((z) => z.y + z.size * 0.7));
      // (not into the lines above and below)
      for (const o of rows) {
        if (reg.includes(o) || !o.length || o.col !== reg[0].col && o.col !== -1) continue;
        const ox0 = Math.min(...o.map((z) => z.x0));
        const ox1 = Math.max(...o.map((z) => z.x1));
        if (ox1 < x0 || ox0 > x1) continue;
        if (o.base < y0 + 1 && o.base + o[0].size * 0.45 > y0) y0 = o.base + o[0].size * 0.45;
        if (o.base > y1 - 1 && o.base - o[0].size * 0.45 < y1) y1 = o.base - o[0].size * 0.45;
      }
      const box = [Math.max(0, x0 - 3), Math.max(0, y0), x1 + 3, y1];
      box.reg = reg;
      const num = nums[0];
      box.alt = num ? `Equation ${num.text.trim()}` : 'Equation';
      box.no = nums.length === 1 ? num.text.trim() : '';
      box.em = (box[2] - box[0]) / bodySize; // (as wide as in the PDF, measured in its text size)
      boxes.push(box);
    }
    return boxes;
  }

  const eqTag = (n, alt, no, em) => `<p class="equation${no ? ' numbered' : ''}"><img src="pdfimg:${n}" alt="${esc(alt)}"${em ? ` style="width:${Number(em).toFixed(2)}em"` : ''}/>${no ? `<span class="eqno">${esc(no)}</span>` : ''}</p>`;

  // Render the page once and crop each image box (PyMuPDF get_pixmap(clip=…)).
  async function cropImages(pg, boxes, scale = 2) {
    const vp = pg.page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await pg.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const out = [];
    for (const box of boxes) {
      const [x0, y0, x1, y1] = box;
      const w = Math.max(1, Math.round((x1 - x0) * scale));
      const h = Math.max(1, Math.round((y1 - y0) * scale));
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      if (box.rotate) {
        // sideways content: turn it upright
        c.width = h;
        c.height = w;
        ctx.translate(h / 2, w / 2);
        ctx.rotate((box.rotate * Math.PI) / 180);
        ctx.drawImage(canvas, x0 * scale, y0 * scale, w, h, -w / 2, -h / 2, w, h);
      } else {
        c.width = w;
        c.height = h;
        ctx.drawImage(canvas, x0 * scale, y0 * scale, w, h, 0, 0, w, h);
      }
      out.push(await new Promise((resolve) => c.toBlob(resolve, 'image/png')));
    }
    return out;
  }

  // Small regions (equations), each drawn on its own: a whole page at high
  // resolution can be too much for a phone's memory, and a failed drawing
  // lost every equation on the page. A box that won't draw is tried smaller.
  async function cropRegions(pg, boxes, scale = 3) {
    const out = [];
    for (const box of boxes) {
      let blob = null;
      for (const s of [scale, 2, 1.5]) {
        try {
          const [x0, y0, x1, y1] = box;
          const vp = pg.page.getViewport({ scale: s, offsetX: -x0 * s, offsetY: -y0 * s });
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round((x1 - x0) * s));
          c.height = Math.max(1, Math.round((y1 - y0) * s));
          await pg.page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
          blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
          c.width = c.height = 0; // (let the memory go now)
        } catch {
          blob = null;
        }
        if (blob) break;
      }
      out.push(blob);
    }
    return out;
  }

  // ================================================================ page layout
  // Where a page's columns are, found from its white space: a column gap is a
  // tall band nothing crosses, with running text on both sides. The page is
  // then cut along those bands (and across, where a title, a wide table or a
  // figure interrupts them) into blocks, in the order they are read. Works
  // page by page, so a paper can change from two columns to three and back.
  const LAYOUT = {
    win: 5, // a gap is at least this wide (points)
    minRun: 2.2, // …and this tall (body sizes) to be looked at
    strictRun: 6, // a gap found on its own is at least this tall (body sizes), with
    strictRows: 5, // …this many lines of running text on each side
    minCol: 0.13, // a column is at least this wide (share of the page)
  };

  function layoutBoxes(pg) {
    const boxes = [];
    for (const l of pg.lines) {
      if (Math.abs(l.dir[0] - 1) > 0.01) continue;
      for (const s of l.spans) {
        if (!s.text.trim()) continue;
        const [x0, y0, x1, y1] = s.bbox;
        if (x1 - x0 < 0.5 || y1 - y0 < 0.5) continue;
        boxes.push({ x0, y0, x1, y1, yc: (y0 + y1) / 2, size: s.size, text: s.text, span: s });
      }
    }
    return boxes;
  }

  // Tall white bands: for every x, the stretches of the page that no text or
  // picture touches in a window LAYOUT.win points wide. Neighbouring x with
  // much the same stretch make one band.
  function whiteBands(boxes, pics, W, H, minRun) {
    const w = Math.ceil(W);
    const h = Math.ceil(H);
    const occ = new Uint8Array(w * h);
    const fill = (x0, y0, x1, y1) => {
      const xa = Math.max(0, Math.floor(x0));
      const xb = Math.min(w, Math.ceil(x1));
      const ya = Math.max(0, Math.floor(y0));
      const yb = Math.min(h, Math.ceil(y1));
      for (let y = ya; y < yb; y++) if (xb > xa) occ.fill(1, y * w + xa, y * w + xb);
    };
    for (const b of boxes) fill(b.x0 + 0.75, b.y0, b.x1 - 0.75, b.y1);
    for (const p of pics) fill(p[0] + 1, p[1], p[2] - 1, p[3]);
    const win = LAYOUT.win;
    const top = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.y0), ...pics.map((p) => p[1]))));
    const bottom = Math.min(h, Math.ceil(Math.max(...boxes.map((b) => b.y1), ...pics.map((p) => p[3]))));
    const left = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.x0), ...pics.map((p) => p[0]))));
    const right = Math.min(w, Math.ceil(Math.max(...boxes.map((b) => b.x1), ...pics.map((p) => p[2]))));
    // clear[y*w+x]: nothing in the window that starts at x, on row y
    const clear = new Uint8Array(w * h);
    for (let y = top; y < bottom; y++) {
      let n = 0;
      for (let x = 0; x < win && x < w; x++) n += occ[y * w + x];
      for (let x = 0; x + win <= w; x++) {
        clear[y * w + x] = n === 0 ? 1 : 0;
        n -= occ[y * w + x];
        if (x + win < w) n += occ[y * w + x + win];
      }
    }
    const strips = [];
    let open = [];
    for (let x = left; x + win <= right; x++) {
      const next = [];
      let start = -1;
      for (let y = top; y <= bottom; y++) {
        const c = y < bottom && clear[y * w + x];
        if (c && start < 0) start = y;
        else if (!c && start >= 0) {
          if (y - start >= minRun) {
            const [ya, yb] = [start, y];
            const s = open.find((o) => !o.used && Math.min(o.y1, yb) - Math.max(o.y0, ya) >= 0.8 * Math.max(o.y1 - o.y0, yb - ya));
            if (s) {
              s.used = true;
              s.x1 = x + win;
              s.y0 = Math.max(s.y0, ya);
              s.y1 = Math.min(s.y1, yb);
              next.push(s);
            } else {
              const n = { x0: x, x1: x + win, y0: ya, y1: yb, used: true };
              strips.push(n);
              next.push(n);
            }
          }
          start = -1;
        }
      }
      next.forEach((s) => (s.used = false));
      open = next;
    }
    // can a band run on past its end? Only what reaches its middle stops it
    // (a word sticking out of its column into the gap doesn't)
    const blocked = (x, y) => {
      const xi = Math.round(x);
      for (let k = -1; k <= 1; k++) if (occ[y * w + Math.min(w - 1, Math.max(0, xi + k))]) return true;
      return false;
    };
    return { strips, top, bottom, blocked };
  }

  // The text on one side of a band, row by row: for each row the run of text
  // nearest the band (pieces chained across word gaps)
  function flankRows(boxes, band, side, bodySize) {
    const near = boxes.filter((b) => b.yc > band.y0 && b.yc < band.y1 && (side < 0 ? b.x1 <= band.x0 + 2 : b.x0 >= band.x1 - 2));
    near.sort((a, b) => a.yc - b.yc);
    const rows = [];
    for (const b of near) {
      const r = rows.length && Math.abs(rows.at(-1).yc - b.yc) <= Math.max(2, b.size * 0.35) ? rows.at(-1) : null;
      if (r) r.items.push(b);
      else rows.push({ yc: b.yc, items: [b] });
    }
    const out = [];
    for (const r of rows) {
      const its = r.items.sort((a, b) => (side < 0 ? b.x1 - a.x1 : a.x0 - b.x0)); // nearest the band first
      const chain = [its[0]];
      for (const b of its.slice(1)) {
        const last = chain.at(-1);
        const gap = side < 0 ? last.x0 - b.x1 : b.x0 - last.x1;
        if (gap > Math.max(bodySize, b.size) * 1.25) break;
        chain.push(b);
      }
      const x0 = Math.min(...chain.map((b) => b.x0));
      const x1 = Math.max(...chain.map((b) => b.x1));
      out.push({ yc: r.yc, y0: Math.min(...chain.map((b) => b.y0)), y1: Math.max(...chain.map((b) => b.y1)), x0, x1, text: chain.map((b) => b.text).join(' '), size: chain[0].size });
    }
    return out;
  }

  const layoutMedian = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);

  // What stands on each side of a band. Running text: rows wide enough to be
  // lines of a column (a table's cells and a figure's labels aren't), mostly
  // words, the left side's lines ending at the band and the right side's
  // starting at it. A wide table can stand on one side for part of the way,
  // so only the rows that touch the band are judged.
  function judgeBand(boxes, band, W, bodySize) {
    const minCol = W * LAYOUT.minCol;
    const side = (dir) => {
      const rows = flankRows(boxes, band, dir, bodySize);
      if (!rows.length) return { n: 0, wide: [], abut: [] };
      const edge = dir < 0 ? Math.max(...rows.map((r) => r.x1)) : Math.min(...rows.map((r) => r.x0));
      const dist = (r) => (dir < 0 ? edge - r.x1 : r.x0 - edge);
      // (a row far from the band, further than it is long, belongs to no column beside it)
      const touching = rows.filter((r) => dist(r) < Math.max(r.x1 - r.x0, bodySize * 3));
      let wide = touching.filter((r) => r.x1 - r.x0 >= minCol);
      // (the lines must reach the band themselves: lines that stop short of it,
      // with only labels or numbers between, are another gap's column)
      if (wide.length && Math.abs((dir < 0 ? Math.max(...wide.map((r) => r.x1)) : Math.min(...wide.map((r) => r.x0))) - edge) > Math.max(8, bodySize)) wide = [];
      const abut = rows.filter((r) => dist(r) <= Math.max(bodySize * 1.5, (r.x1 - r.x0) * 0.3));
      const t = wide.map((r) => r.text).join('').replace(/\s/g, '');
      const letters = t.length ? (t.match(/\p{L}/gu) || []).length / t.length : 0;
      const w = layoutMedian(wide.map((r) => r.x1 - r.x0));
      let aligned = 0;
      if (wide.length && dir < 0) aligned = wide.filter((r) => r.x1 >= edge - Math.max(12, w * 0.22)).length / wide.length;
      else if (wide.length) {
        // lines of a column start at its edge, or at one indent from it
        // (a paragraph's first line; the hanging lines of a reference)
        const bins = new Map();
        for (const r of wide) bins.set(Math.round(r.x0 / 3), (bins.get(Math.round(r.x0 / 3)) || 0) + 1);
        const top2 = [...bins.entries()].filter(([k]) => k * 3 <= edge + bodySize * 3.5).sort((a, b) => b[1] - a[1]).slice(0, 2);
        const near = new Set(top2.flatMap(([k]) => [k - 1, k, k + 1]));
        aligned = wide.filter((r) => near.has(Math.round(r.x0 / 3))).length / wide.length;
      }
      // lines of text follow each other closely (a table's row labels stand apart)
      // (a long line has a neighbour close above or below, whatever the short
      // lines between them: a ragged side column's long lines are apart)
      const close = (r, o) => o !== r && Math.abs(o.yc - r.yc) <= Math.max(r.size, o.size) * 2;
      const dense = wide.filter((r) => rows.some((o) => close(r, o))).length >= wide.length * 0.6;
      return { n: touching.length, wide, abut, letters, w, aligned, edge, dense };
    };
    const L = side(-1);
    const R = side(1);
    const info = { nL: L.n, nR: R.n, wideL: L.wide.length, wideR: R.wide.length, wL: Math.round(L.w || 0), wR: Math.round(R.w || 0), fullL: +(L.aligned || 0).toFixed(2), startR: +(R.aligned || 0).toFixed(2) };
    const flaw = (s, need) => (s.wide.length < 2 ? (s.n < 2 ? 'few rows' : 'narrow') : s.wide.length < s.n * 0.2 ? 'mostly cells' : s.letters < 0.55 ? 'numbers' : !s.dense ? 'sparse' : s.aligned < need ? 'ragged' : '');
    const [whyL, whyR] = [flaw(L, 0.45), flaw(R, 0.6)];
    const why = whyL || whyR;
    // where text stands against the band, on either side
    // (from the first such row that has another close below it)
    const abut = [...L.abut, ...R.abut].sort((a, b) => a.y0 - b.y0);
    const led = abut.find((r, i) => abut.slice(i + 1).some((o) => o.y0 - r.y1 < Math.max(r.size, o.size) * 2.5 && o.y0 > r.y0 + 1));
    const a0 = led ? led.y0 : abut.length ? abut[0].y0 : band.y0;
    const a1 = abut.length ? Math.max(...abut.map((r) => r.y1)) : band.y1;
    return { ok: !why, why, ...info, rows: Math.min(L.wide.length, R.wide.length), oneSide: Math.max(whyL ? 0 : L.wide.length, whyR ? 0 : R.wide.length), a0, a1 };
  }

  // Every page's candidate bands, judged
  function pageBands(pg, bodySize) {
    const boxes = layoutBoxes(pg);
    const pics = (pg.images || []).map((b) => [b[0], b[1], b[2], b[3]]).filter((b) => b[2] - b[0] >= 24 && b[3] - b[1] >= 24);
    if (!boxes.length) return { boxes, pics, bands: [] };
    const { strips, top, bottom, blocked } = whiteBands(boxes, pics, pg.width, pg.height, bodySize * LAYOUT.minRun);
    const bands = strips.map((s) => ({ ...s, x: (s.x0 + s.x1) / 2, ...judgeBand(boxes, s, pg.width, bodySize) }));
    return { boxes, pics, bands, top, bottom, blocked };
  }

  // The layout of every page of a document. A gap found on its own has to be
  // tall; one standing where the paper's columns are parted on other pages
  // (or elsewhere on this one) can be a few lines short: a caption or a
  // table's notes set in the page's columns.
  // A shaded box above (or below) all the page's other text, with columns of
  // its own: its text is laid out apart, and set before (or after) the page.
  function splitShades(pg, bodySize) {
    if (!pg.shades || !pg.shades.length || pg.lines.length < 5) return { page: pg, sub: null };
    for (const s of pg.shades) {
      const inside = pg.lines.filter((l) => {
        const cx = (l.bbox[0] + l.bbox[2]) / 2;
        const cy = (l.bbox[1] + l.bbox[3]) / 2;
        return cx > s[0] && cx < s[2] && cy > s[1] && cy < s[3];
      });
      if (inside.length < 4) continue;
      // a figure's caption lies within the figure's frame: that is not a box
      if (inside.some((l) => /^\s*(fig(ure)?s?\.?|table)\s*[A-Z]?\d+/i.test(l.spans.map((sp) => sp.text).join('')))) continue;
      // running text, not a chart's labels: most of its lines are sentences
      const words = inside.map((l) => l.spans.map((sp) => sp.text).join(' ').trim().split(/\s+/).length);
      if (words.filter((n) => n >= 6).length < 8 || words.reduce((x, y) => x + y, 0) / words.length < 5) continue;
      const rest = pg.lines.filter((l) => !inside.includes(l));
      if (!rest.length) continue;
      // a column of text beside the box (not the box's own width): the box is a sidebar, not a band
      // (runs of words on one line, as wide as a column's lines are)
      const beside = rest.flatMap((l) => l.spans.map((sp) => sp.bbox)).filter((b) => (b[2] <= s[0] || b[0] >= s[2]) && b[3] > s[1] && b[1] < s[3]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      const runs = [];
      for (const b of beside) {
        const last = runs.at(-1);
        if (last && Math.abs((last[1] + last[3]) / 2 - (b[1] + b[3]) / 2) < 2 && b[0] - last[2] <= 6) {
          last[2] = Math.max(last[2], b[2]);
          last[1] = Math.min(last[1], b[1]);
          last[3] = Math.max(last[3], b[3]);
        } else runs.push([...b]);
      }
      if (runs.filter((r) => r[2] - r[0] > pg.width * 0.2).length >= 3) continue;
      // (the text it stands over or under: what lies beside it, a margin, doesn't
      // count; nor does the running head or foot. Text across the box's own
      // height means it isn't a box above or below the text)
      // (by pieces of text: a line can run from the running head to the foot)
      const across = rest.flatMap((l) => l.spans.map((sp) => sp.bbox)).filter((b) => b[2] > s[0] && b[0] < s[2]);
      const tol = bodySize;
      const crossing = across.some((b) => b[3] > s[1] + tol && b[1] < s[3] - tol);
      const bodyAbove = across.some((b) => b[3] <= s[1] + tol && b[1] > pg.height * 0.1);
      const bodyBelow = across.some((b) => b[1] >= s[3] - tol && b[3] < pg.height * 0.9);
      if (crossing) continue;
      const above = bodyBelow && !bodyAbove;
      const below = bodyAbove && !bodyBelow;
      if (!above && !below) continue;
      const subPage = { width: pg.width, height: pg.height, lines: inside, images: [] };
      const L = pageCut(subPage, pageBands(subPage, bodySize), (b) => b.ok && b.rows >= 3, bodySize);
      if (!L.gutters.length) continue;
      return {
        page: { ...pg, lines: rest },
        sub: { leaves: L.leaves.map((f) => ({ ...f, shade: above })), gutters: L.gutters, rejected: L.rejected, above },
      };
    }
    return { page: pg, sub: null };
  }

  function docLayout(pages, bodySize) {
    const splits = pages.map((pg) => splitShades(pg, bodySize));
    const bodyPages = splits.map((x) => x.page);
    const per = bodyPages.map((pg) => pageBands(pg, bodySize));
    const strict = (b) => b.ok && b.y1 - b.y0 >= bodySize * LAYOUT.strictRun && b.rows >= LAYOUT.strictRows;
    const grid = [];
    for (const p of per) for (const b of p.bands) if (strict(b)) grid.push(b);
    const out = per.map((p, i) => {
      const own = p.bands.filter(strict);
      const at = (list, b) => list.filter((g) => Math.abs(g.x - b.x) <= 6);
      // short, but where this page's columns are parted; or where another
      // page's are, and as wide a gap as there
      // (or two lines short, right where one of this page's gaps ends: two
      // captions side by side over the columns, set a little narrower)
      const joins = (b) => own.some((g) => b.x0 <= g.x1 + 3 && b.x1 >= g.x0 - 3 && b.y1 >= g.y0 - bodySize * 2 && b.y0 <= g.y1 + bodySize * 2);
      const short = (b) => b.ok && ((b.rows >= 3 && (at(own, b).length > 0 || at(grid, b).some((g) => b.x1 - b.x0 >= (g.x1 - g.x0) * 0.6))) || (b.rows >= 2 && joins(b)));
      // a column of text beside a figure's labels or a table: text on one
      // side only, where the paper's columns are parted on other pages
      for (const b of p.bands) {
        if (strict(b) || short(b) || b.oneSide < LAYOUT.strictRows || b.y1 - b.y0 < bodySize * LAYOUT.strictRun) continue;
        const known = grid.filter((g) => !p.bands.includes(g) && g.x > b.x0 && g.x < b.x1).map((g) => g.x).sort((x, y) => x - y);
        if (known.length >= 2) Object.assign(b, { x: known[known.length >> 1], known: true });
      }
      return pageCut(bodyPages[i], p, (b) => strict(b) || short(b) || b.known, bodySize);
    });
    return out.map((L, i) => {
      const sub = splits[i].sub;
      let leaves = sub ? (sub.above ? [...sub.leaves, ...L.leaves] : [...L.leaves, ...sub.leaves]) : L.leaves;
      // a full-width block at the top of the page (a title, above the columns) is read first
      const cols = leaves.filter((f) => f.col);
      if (cols.length) {
        const top = Math.min(...cols.map((f) => f.y0));
        const head = leaves.filter((f) => !f.col && f.y0 <= top + 2 && f.y0 > pages[i].height * 0.06).sort((a, b) => a.y0 - b.y0);
        leaves = [...head, ...leaves.filter((f) => !head.includes(f))];
      }
      if (!sub) return leaves === L.leaves ? L : { ...L, leaves };
      return {
        ...L,
        leaves,
        gutters: [...L.gutters, ...sub.gutters],
        rejected: [...L.rejected, ...sub.rejected],
      };
    });
    // the opening page starts with its title, wherever the page puts the
    // authors (a column of names and addresses to the left of it, say)
    const first = out[0];
    if (first && first.leaves.length > 1) {
      let best = null;
      first.leaves.forEach((leaf, k) => {
        for (const it of leaf.items) {
          const b = it.box;
          if (!b || b.size < bodySize * 1.4 || b.y0 > pages[0].height * 0.6 || (b.text.match(/\p{L}/gu) || []).length < 3) continue;
          if (!best || b.size > best.size + 0.5) best = { size: b.size, k };
        }
      });
      if (best && best.k > 0) first.leaves.unshift(...first.leaves.splice(best.k, 1));
    }
    return out;
  }

  function pageCut(pg, p, accept, bodySize) {
    const { boxes, pics } = p;
    if (!boxes.length) return { leaves: [], gutters: [], rejected: [], boxes };
    // judge every band first; where accepted bands stand over one another
    // (a gap and a ragged edge beside it), the one with more lines beside it wins
    const bands = [...p.bands];
    const rejected = bands.filter((s) => !accept(s));
    const cands = bands.filter((s) => accept(s)).sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0) || b.y1 - b.y0 - (a.y1 - a.y0) || b.x1 - b.x0 - (a.x1 - a.x0));
    let gutters = [];
    for (const s of cands) {
      if (gutters.some((g) => s.x0 < g.x1 + 30 && s.x1 > g.x0 - 30 && Math.min(g.y1, s.y1) - Math.max(g.y0, s.y0) > 0.5 * (s.y1 - s.y0))) continue;
      gutters.push({ ...s });
    }
    // a gap runs on while nothing reaches its middle, then is trimmed to
    // where text stands against it; pieces of one gap become one
    for (const g of gutters) {
      let y0 = g.y0;
      let y1 = g.y1;
      while (y0 - 1 >= p.top && !p.blocked(g.x, y0 - 1)) y0--;
      while (y1 < p.bottom && !p.blocked(g.x, y1)) y1++;
      const whole = judgeBand(boxes, { ...g, y0, y1 }, pg.width, bodySize);
      // (a picture standing against the gap is part of its column too)
      const beside = pics.filter((q) => q[3] > y0 && q[1] < y1 && ((q[2] <= g.x0 + 2 && g.x0 - q[2] <= Math.max(25, (q[2] - q[0]) * 0.3)) || (q[0] >= g.x1 - 2 && q[0] - g.x1 <= Math.max(25, (q[2] - q[0]) * 0.3))));
      g.y0 = Math.max(y0, Math.min(whole.a0, ...beside.map((q) => q[1])) - 1);
      g.y1 = Math.min(y1, Math.max(whole.a1, ...beside.map((q) => q[3])) + 1);
    }
    gutters.sort((a, b) => a.x - b.x || a.y0 - b.y0);
    const merged = [];
    for (const g of gutters) {
      const m = merged.find((o) => Math.abs(o.x - g.x) <= 6 && g.y0 <= o.y1 + bodySize * 1.5 && g.y1 >= o.y0 - bodySize * 1.5);
      if (m) {
        m.y0 = Math.min(m.y0, g.y0);
        m.y1 = Math.max(m.y1, g.y1);
        if (g.x1 - g.x0 > m.x1 - m.x0) Object.assign(m, { x0: g.x0, x1: g.x1, x: g.x });
      } else merged.push(g);
    }
    gutters = merged;
    // cut the page
    const items = [...boxes.map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, box: b })), ...pics.map((q) => ({ x0: q[0], y0: q[1], x1: q[2], y1: q[3], pic: q }))];
    const leaves = [];
    const tol = bodySize * 1.5;
    const cut = (its, depth, cols) => {
      if (!its.length) return;
      const r = { x0: Math.min(...its.map((i) => i.x0)), y0: Math.min(...its.map((i) => i.y0)), x1: Math.max(...its.map((i) => i.x1)), y1: Math.max(...its.map((i) => i.y1)) };
      const mid = (i) => (i.x0 + i.x1) / 2;
      const usable = gutters.filter((g) => g.x > r.x0 + 4 && g.x < r.x1 - 4 && Math.min(g.y1, r.y1) - Math.max(g.y0, r.y0) > bodySize * 1.5 && its.some((i) => mid(i) < g.x) && its.some((i) => mid(i) > g.x));
      // a gap parts the block when it runs its whole height, or when what
      // stands past its ends is all to one side of it (a heading over one column)
      const oneSided = (g, past) => {
        const beyond = its.filter(past);
        return !beyond.some((i) => i.x0 < g.x0 && i.x1 > g.x1) && (!beyond.some((i) => mid(i) < g.x) || !beyond.some((i) => mid(i) > g.x));
      };
      const full = usable
        .filter((g) => (g.y0 <= r.y0 + tol || oneSided(g, (i) => (i.y0 + i.y1) / 2 < g.y0)) && (g.y1 >= r.y1 - tol || oneSided(g, (i) => (i.y0 + i.y1) / 2 > g.y1)))
        .sort((a, b) => a.x - b.x);
      if (full.length && depth < 14) {
        const xs = full.map((g) => g.x);
        const parts = xs.map(() => []).concat([[]]);
        for (const i of its) {
          let k = 0;
          while (k < xs.length && mid(i) > xs[k]) k++;
          parts[k].push(i);
        }
        parts.forEach((q) => cut(q, depth + 1, true));
        return;
      }
      // across, at the end of a gap: where it doesn't slice another gap's columns
      const ys = [];
      for (const g of usable) {
        if (g.y0 > r.y0 + tol) ys.push(g.y0);
        if (g.y1 < r.y1 - tol) ys.push(g.y1);
      }
      const sliced = (y) => usable.reduce((n, g) => n + (y > g.y0 + tol && y < g.y1 - tol ? Math.min(y - g.y0, g.y1 - y) : 0), 0);
      ys.sort((a, b) => sliced(a) - sliced(b) || a - b);
      for (const y of ys) {
        const above = its.filter((i) => (i.y0 + i.y1) / 2 < y);
        const below = its.filter((i) => (i.y0 + i.y1) / 2 >= y);
        if (!above.length || !below.length || depth >= 14) continue;
        cut(above, depth + 1, false);
        cut(below, depth + 1, false);
        return;
      }
      leaves.push({ ...r, col: !!cols, items: its });
    };
    cut(items, 0, false);
    return { leaves, gutters, rejected, boxes };
  }

  // ================================================================ PDF → HTML
  // Linotype "Mathematical Pi" fonts (APA and other publishers' symbols)
  // name glyphs H<number> and come without a Unicode map, so viewers show
  // "p [ .05" for "p < .05". Their names say which symbol it is.
  // (H11006 ±, H11349 ≤ and H11350 ≥ read off a CHEST paper: "mean ± SE", "hemoglobin (≤ 10 g/dL)", "age (≥ 65 years)")
  // (H20851 [ and H20852 ] off a Critical Care Medicine paper: "5.0 [2.0–13.0]")
  const PI_GLYPHS = { 9004: 'Δ', 11001: '+', 11002: '−', 11003: '×', 11004: '÷', 11005: '=', 11006: '±', 11011: '∼', 11021: '<', 11022: '>', 11349: '≤', 11350: '≥', 11569: '*', 20851: '[', 20852: ']' };
  // The same font without glyph names (older PDFs): the text holds the keys
  // the symbols sit on, so "p , 0.05", "n 5 136" and "38.58 C" mean
  // "p < 0.05", "n = 136" and "38.5° C". (Read off an AJRCCM paper; the keys
  // 1 to 6 are the last digit of H11001 to H11006.)
  const PI_ONE_KEYS = { 1: '+', 2: '−', 3: '×', 4: '÷', 5: '=', 6: '±', ',': '<', '.': '>', '<': '≤', '>': '≥', 8: '°' };
  function piGlyphs(differences) {
    if (!Array.isArray(differences)) return null;
    let map = null;
    differences.forEach((name, code) => {
      const m = /^H(\d{4,5})$/.exec(name || '');
      if (!m) return;
      const n = +m[1];
      // Greek lowercase in Unicode order: H9251 is α
      const ch = PI_GLYPHS[n] || (n >= 9251 && n <= 9275 ? String.fromCodePoint(n - 8306) : '');
      (map ||= {})[code] = ch;
    });
    return map;
  }

  function fixGlyphs(text, font) {
    // (a lone "d", "l" or "n" in a Math Pi or Dingbats font is its bullet: AJRCCM's lists)
    if (font && /MPi\d|MathPi|Dingbat|ZapfD/i.test(font) && /^\s*[dln]\s*$/.test(text)) return text.replace(/[dln]/, '•');
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

  // ---------------------------------------------------------------- headings
  // Bold by name, including suffix conventions ("Xmkncr.B", "Times-Bd").
  const BOLD_FONT = /Bold|-Bd|Medi|Semibold|Demi|Black|Heavy|CMBX|[.,_-](?:B|Bd|BI|SB)$/i;
  const MATH_FONT = /^(?:[A-Z]{6}\+)?(?:CM(?:MI|SY|EX)|MSAM|MSBM|Symbol|.*Math)/i;
  const baseFont = (name) => String(name || '').replace(/^[A-Z]{6}\+/, '');
  const SECTION_WORD = /^(abstract|introduction|background|related work|methods?|materials and methods|methodology|results(?: and discussion)?|discussion|conclusions?|acknowledge?ments?|references|appendix|limitations|summary)\b/i;
  const NUMBERED = /^(\d+(\.\d+)*\.?|[A-Z]\.|[IVX]+\.)\s+\S/;
  // short enough, wordy enough and unpunctuated enough to be a heading
  const headingText = (t) =>
    t.split(/\s+/).length <= 12 && !/[,;]$/.test(t) && /\p{L}{3}/u.test(t) && /^[\p{Lu}\d]/u.test(t) &&
    !/[*∗†‡\uE010]/u.test(t) && (t.match(/,/g) || []).length < 2 && // author lines
    !/\p{Ll}{2}[.:]\s+\p{Lu}\p{Ll}/u.test(t); // "Shortcuts. We have…": a run-in lead, not a heading
  // "1 INTRODUCTION", "6.1 EXPERIMENT: …": a numbered or standard section in capitals
  function capsHeading(t) {
    const letters = t.match(/\p{L}/gu) || [];
    const upper = letters.filter((c) => c !== c.toLowerCase()).length;
    return letters.length >= 4 && upper >= letters.length * 0.9 && t.split(/\s+/).length <= 10 && (NUMBERED.test(t) || SECTION_WORD.test(t));
  }
  // 1 → h3, 1.1 and deeper → h4
  const headingTag = (t) => ((/^\d+\.\d+/.test(t)) ? 'h4' : 'h3');

  // Headings set in their own type style, which no rule about size or a
  // "Bold" font name catches (obfuscated font names, +1pt headings). A style
  // (font + size) is a heading style when, across the document, it is used
  // only for short, wordy lines that the body text follows, and rarely.
  function learnHeadingStyles(pdf, bodySize) {
    const key = (font, size) => `${baseFont(font)}|${Math.round(size * 2) / 2}`;
    const lines = [];
    for (const pg of pdf.pages) {
      const ls = [];
      for (const l of pg.lines) {
        if (!horizontal(l)) continue;
        const text = ws(l.spans.map((sp) => sp.text).join('')).trim();
        if (!text) continue;
        const w = new Counter();
        l.spans.forEach((sp) => w.add(key(sp.font, sp.size), sp.text.length));
        ls.push({ text, k: w.mostCommon(), x0: l.bbox[0], x1: l.bbox[2], y: l.bbox[1] });
      }
      ls.sort((a, b) => a.y - b.y);
      // the line below, in the same column (overlapping horizontally)
      ls.forEach((l, i) => (l.next = ls.slice(i + 1).find((m) => m.x0 < l.x1 && l.x0 < m.x1)));
      lines.push(...ls);
    }
    const chars = new Counter();
    lines.forEach((l) => chars.add(l.k, l.text.length));
    const body = chars.mostCommon();
    const byStyle = new Map();
    for (const l of lines) (byStyle.get(l.k) || byStyle.set(l.k, []).get(l.k)).push(l);
    const out = new Set();
    for (const [k, ls] of byStyle) {
      const size = +k.split('|').pop();
      if (k === body || ls.length < 2 || size < bodySize - 0.3 || size >= bodySize + 3 || MATH_FONT.test(k)) continue;
      // (a long heading's second line starts lower-case, so not headingText here)
      const wordy = ls.filter((l) => l.text.split(/\s+/).length <= 14 && !/[,;]$/.test(l.text) && /\p{L}{3}/u.test(l.text) && (l.text.match(/\p{L}/gu) || []).length >= l.text.replace(/\s/g, '').length * 0.6);
      const followed = ls.filter((l) => l.next && l.next.k !== k);
      if (wordy.length >= ls.length * 0.85 && followed.length >= ls.length * 0.7 && chars.get(k) <= chars.get(body) * 0.05) out.add(k);
    }
    // the style that carries "Introduction", "Methods"… is the top level; others are subsections
    const major = new Set([...out].filter((k) => byStyle.get(k).some((l) => SECTION_WORD.test(l.text))));
    return { has: (font, size) => out.has(key(font, size)), minor: (font, size) => out.has(key(font, size)) && major.size > 0 && !major.has(key(font, size)) };
  }

  // Small-caps headings extract as "cOnclusiOn" / "WhAt Is AlreAdy knoWn":
  // capitals mid-word in several words of a short line. Normalise to
  // sentence case. (One odd word, like "McDonald", is left alone.)
  // Headings get the small-caps fix even as a single word ("AbstrAct"),
  // and a capital first letter ("results" → "Results").
  function headingCase(txt) {
    let t = txt;
    // small caps extracted as a jumble of cases ("BRinging CuLTuRE BACK in",
    // "CASE SELECTion"): sentence case, keeping acronyms the paper uses in its text
    const real = (w) => (camelVocab.get(w) || 0) >= 3;
    const jumbled = t.split(/\s+/).filter((w) => (/\p{Lu}{2,}\p{Ll}/u.test(w) || /\p{Ll}\p{Lu}/u.test(w)) && !real(w.replace(/[^\p{L}\d]/gu, '')));
    if (jumbled.length) {
      const out = t
        .split(/(\s+)/)
        .map((w) => (/^\p{Lu}{2,}$/u.test(w.replace(/[^\p{L}]/gu, '')) && (capsVocab.get(w.replace(/[^\p{L}]/gu, '')) || 0) >= 3) || real(w.replace(/[^\p{L}\d]/gu, '')) ? w : w.toLowerCase())
        .join('');
      return out.charAt(0).toUpperCase() + out.slice(1);
    }
    if (/^\p{L}+$/u.test(t) && /\p{Ll}\p{Lu}/u.test(t) && (camelVocab.get(t) || 0) < 3) t = t.toLowerCase();
    else t = fixSmallCaps(t);
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // Words with inner capitals that the document uses often ("ImageNet",
  // "PubMed") are spelled that way; small-caps artefacts appear once or twice.
  let camelVocab = new Map();
  let capsVocab = new Map(); // all-capital words in the text (acronyms)
  function fixSmallCaps(txt) {
    const words = txt.split(/\s+/);
    const odd = words.filter((w) => (/\p{Ll}\p{Lu}/u.test(w) || /^\p{Ll}+\p{Lu}/u.test(w)) && (camelVocab.get(w.replace(/[^\p{L}\d]/gu, '')) || 0) < 3).length;
    if (words.length > 14 || odd < Math.max(1, Math.ceil(words.length / 3)) || (words.length === 1 && !/^\p{Ll}/u.test(txt))) return txt;
    const lower = txt.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }

  // Join wrapped lines, de-hyphenating "sam-" + "ple" (from the simple flow),
  // but keeping hyphens the document uses elsewhere ("meta-" + "analyses").
  let hyphenVocab = new Set();
  function joinWrapped(lines) {
    let out = '';
    for (const ln of lines) {
      const a = out.endsWith('-') ? (/([\p{L}\d]+)-$/u.exec(out) || [])[1] : null;
      const b = a ? (/^[\p{L}\d]+/u.exec(ln) || [])[0] : null;
      if (a && b && hyphenVocab.has(`${a}-${b}`.toLowerCase())) out += ln;
      else if (out.endsWith('-') && out.length > 1 && /\p{L}/u.test(out.at(-2)) && /^\p{Ll}/u.test(ln)) out = out.slice(0, -1) + ln;
      else if (out.endsWith('-') && /\d/.test(out.at(-2) || '') && /^\p{L}/u.test(ln)) out += ln; // "152-" + "layer"
      else if (out.endsWith('-') && /\p{L}$/u.test(out.slice(0, -1)) && /^\p{Lu}/u.test(ln)) out += ln; // "Paris-" + "Sud": a compound
      else out = out ? out + ' ' + ln : ln;
    }
    return ws(out).trim();
  }

  // Join spans left-to-right. The script used " ".join, which splits
  // small caps ("A DAM : A M ETHOD") and superscripts; only insert a space
  // where there is a visible gap between the spans.
  function joinSpans(spans) {
    // the row's main text: the size with the most characters, and its height
    const bySize = new Counter();
    spans.forEach((s) => bySize.add(Math.round(s.size * 2) / 2, s.text.length));
    const mainSize = bySize.mostCommon();
    const main = spans.filter((s) => Math.abs(s.size - mainSize) < 0.6);
    const mainY = main.length ? sum(main.map((s) => s.yc ?? s.y)) / main.length : null;
    let out = '';
    let prev = null;
    for (const s of spans) {
      let text = s.text;
      if (mainY !== null && s.size < mainSize * 0.86 && text.trim()) {
        const dy = (s.yc ?? s.y) - mainY;
        if (dy < -0.12 * mainSize) text = SUP[0] + text.trim() + SUP[1];
        else if (dy > 0.08 * mainSize) text = SUB[0] + text.trim() + SUB[1];
      }
      if (prev) {
        const gap = s.x0 - prev.x1;
        const script = text.startsWith(SUP[0]) || text.startsWith(SUB[0]);
        if (!script && (gap > 0.12 * Math.min(prev.size, s.size) || (s.sp && gap > -0.2 * s.size) || /\s$/.test(out) || /^\s/.test(text))) out += ' ';
        else if (script && gap > 0.5 * s.size) out += ' ';
      }
      out += text;
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
    // (spaces ignored: scanned text spaces the same header differently, "A N D" / "AND")
    const norm = (t) => ws(t).toLowerCase().replace(/\s+/g, '').replace(/\d+/g, '#');

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
    const isBold = (sp) => !!(sp.flags & 16);

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
            spans.push({ text: t, x0: s.bbox[0], x1: s.bbox[2], y0: s.bbox[1], y1: s.bbox[3], yc: (s.bbox[1] + s.bbox[3]) / 2, y: (s.bbox[1] + s.bbox[3]) / 2, size: s.size, bold: isBold(s), font: s.font });
          }
        }
      }
      spans.sort((a, b) => a.yc - b.yc || a.x0 - b.x0);
      const rows = lineRows(spans, bodySize);
      const items = [];
      // display equations, as pictures
      const eqs = findEquations(rows, bodySize);
      if (eqs.length) {
        const blobs = await cropRegions(pg, eqs);
        eqs.forEach((box, k) => {
          if (!blobs[k]) return;
          images.push(blobs[k]);
          for (const r of box.reg) rows.splice(rows.indexOf(r), 1);
          items.push({ kind: 'eq', y0: box[1], y1: box[3], n: images.length - 1, alt: box.alt, no: box.no, em: box.em });
        });
      }
      for (const r of rows) {
        r.sort((a, b) => a.x0 - b.x0);
        const txt = resolveHat(ws(joinSpans(r)).trim());
        if (!txt || ROMAN_OR_DIGITS.test(txt)) continue;
        const weight = new Counter();
        r.forEach((z) => weight.add(pyRound(z.size), z.text.length));
        const fontWeight = new Counter();
        r.forEach((z) => fontWeight.add(z.font, z.text.length));
        const visible = r.filter((z) => z.text.trim());
        items.push({
          kind: 'text',
          text: txt,
          x0: r[0].x0,
          y0: Math.min(...r.map((z) => z.y0)),
          y1: Math.max(...r.map((z) => z.y1)),
          size: weight.mostCommon(),
          font: fontWeight.mostCommon(),
          rawSize: r.find((z) => z.font === fontWeight.mostCommon())?.size,
          bold: visible.every((z) => z.bold),
          boldish: sum(r.filter((z) => z.bold).map((z) => z.text.length)) >= 0.6 * sum(r.map((z) => z.text.length)),
        });
      }
      const keep = pg.images.filter(([x0, y0, x1, y1]) => x1 - x0 >= 4 && y1 - y0 >= 4 && !(y1 < ph * 0.1 || y0 > ph * 0.92));
      if (keep.length) {
        const blobs = await cropImages(pg, keep).catch(() => []);
        const rowsForCaptions = items.map((it) => ({ text: it.text, y0: it.y0, y1: it.y1 }));
        blobs.forEach((blob, k) => {
          if (!blob) return;
          images.push(blob);
          items.push({ kind: 'img', y0: keep[k][1], y1: keep[k][3], n: images.length - 1, fig: captionNumber(keep[k], rowsForCaptions), box: keep[k] });
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
        // (but a numbered or standard section heading is not an author line)
        const looksLikeSection = (t) => /^((\d+(\.\d+)*\.?|[IVX]+\.)\s+\S|(abstract|introduction|background|summary)\b)/i.test(t);
        if (after.length && after[0].boldish && after[0].size < big && after[0].y0 - run.at(-1).y1 < 40 && !looksLikeSection(after[0].text)) {
          author = after[0].text;
          after[0].kind = 'skip';
        }
      }
    }

    // ---- the document's usual gap between lines of body text: 1.5- or
    // double-spaced manuscripts have big gaps everywhere, so a fixed
    // threshold split their paragraphs every few lines
    const gaps = [];
    for (const items of pages) {
      const body = items.filter((it) => it.kind === 'text' && Math.abs(it.size - bodySize) <= 0.5);
      for (let i = 1; i < body.length; i++) {
        const g = body[i].y0 - body[i - 1].y1;
        if (g > -2 && g < bodySize * 3) gaps.push(g);
      }
    }
    gaps.sort((a, b) => a - b);
    const usualGap = gaps.length ? gaps[gaps.length >> 1] : 0;
    const paraGap = Math.max(4.0, 0.5 * bodySize, usualGap + Math.max(3, 0.35 * bodySize));

    // ---- emit
    let parts = [];
    const notes = [];
    const buf = [];
    const state = { last: null, list: false, label: null, titleDone: false };
    const styles = learnHeadingStyles(pdf, bodySize);
    const TERMINAL = '.!?:;”"\')]';
    const LABEL = /^(Fig\.?|Figure|Table|Box)\s*\d+[A-Za-z]?\.?$/i;
    const NUMITEM = /^\d{1,3}\.\s+\S/;

    const joinLines = joinWrapped;
    const flush = () => {
      if (buf.length) {
        const txt = joinLines(buf);
        if (state.label) {
          parts.push(`<p><strong>${escRich(state.label)}</strong> ${escRich(txt)}</p>`);
          state.label = null;
        } else parts.push(`<p>${escRich(txt)}</p>`);
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
            parts.push(`<h1>${escRich(title)}</h1>`);
            state.titleDone = true;
          }
          continue;
        }
        if (it.kind === 'eq') {
          flush();
          parts.push(eqTag(it.n, it.alt, it.no, it.em));
          pageStart = false;
          continue;
        }
        if (it.kind === 'img') {
          flush();
          parts.push(imgTag(it.n, it.fig, it.box));
          pageStart = false;
          continue;
        }
        const txt = it.text;
        const sz = it.size;
        // footnotes: small type near the page bottom
        if (sz <= bodySize - 2 && it.y0 > ph * 0.78 && !(capsHeading(txt) && NUMBERED.test(txt))) {
          if (fnCur.length && !/^\uE010?([a-z*†‡§]|\d{1,2})\uE011?\s*[A-Z]/.test(txt) && !txt.startsWith('Correspondence')) fnCur.push(txt);
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
          parts.push(`<h2>${escRich(txt)}</h2>`);
          pageStart = false;
          continue;
        }
        if (it.bold && LABEL.test(txt)) {
          flush();
          state.label = txt;
          pageStart = false;
          continue;
        }
        // a section heading: bold, in a heading style, or numbered in capitals
        const standalone = !buf.length || endsWithAny(buf.at(-1).trimEnd(), TERMINAL) || (state.last && it.y0 - state.last.y1 > paraGap);
        const capsNumbered = capsHeading(txt) && NUMBERED.test(txt) && sz >= bodySize - 2.5; // small caps run small
        if (
          capsNumbered ||
          (standalone && headingText(txt) && sz >= bodySize - 1 &&
            ((it.bold && (txt.length <= 40 || NUMBERED.test(txt) || SECTION_WORD.test(txt))) || styles.has(it.font, it.rawSize || sz) || capsHeading(txt)))
        ) {
          flush();
          const tag = styles.minor(it.font, it.rawSize || sz) && !NUMBERED.test(txt) ? 'h4' : headingTag(txt);
          parts.push(`<${tag}>${escRich(headingCase(txt))}</${tag}>`);
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
          if (gap > paraGap) newPara = true;
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
        parts.push(`<p><small>${escRich(n)}</small></p>`);
      }
    }
    return { parts, title, author };
  }

  async function pdfToHtml(blob, filename, log) {
    const pdf = await openPdf(blob, log);
    if (!pdf.pages.length) throw new Error('PDF has no pages');
    const pageW = pdf.pages[0].width;
    const images = [];
    // A ligature the font gives no letters for ("a?er", "de?ned": a private
    // or control character where "ft" or "fi" stands): the letters that make
    // a word the paper uses elsewhere
    {
      const ODD = /[\u0080-\u009F\uE000-\uF8FF]/u;
      const vocab = new Set();
      const all = pdf.pages.flatMap((pg) => pg.lines.flatMap((l) => l.spans));
      for (const sp of all) for (const w of sp.text.toLowerCase().match(/\p{L}{3,}/gu) || []) vocab.add(w);
      const LIGS = ['ft', 'fi', 'fl', 'ff', 'ffi', 'ffl', 'tt', 'th', 'f'];
      const chosen = new Map(); // (one character is one ligature throughout)
      for (const sp of all) {
        if (!ODD.test(sp.text)) continue;
        sp.text = sp.text.replace(/(\p{L}*)([\u0080-\u009F\uE000-\uF8FF])(\p{L}*)/gu, (m, a, ch, b) => {
          if (!a && !b) return m;
          let lig = chosen.get(ch);
          if (!lig) {
            lig = LIGS.find((x) => vocab.has((a + x + b).toLowerCase()));
            if (lig && (a + b).length >= 2) chosen.set(ch, lig);
          }
          return lig ? a + lig + b : m;
        });
      }
    }

    // dominant body font size across the document
    const sizes = new Counter();
    const globX0 = new Counter();
    for (const pg of pdf.pages) {
      for (const l of pg.lines) {
        for (const s of l.spans) {
          if (!s.text.trim()) continue;
          sizes.add(pyRound(s.size), s.text.trim().length);
          globX0.add(pyRound(s.bbox[0] / 5) * 5);
        }
      }
    }
    const bodySize = sizes.mostCommon() ?? 11;
    const styles = learnHeadingStyles(pdf, bodySize);
    // global body-text left edge (per-page voting fails on box-dominated pages)
    const globalBodyLeft = globX0.mostCommon() ?? 0;
    // where the columns are, page by page (two, three, or a mix)
    const layouts = docLayout(pdf.pages, bodySize);
    const laidOut = layouts.filter((L) => L.leaves.length);
    const twoCol = layouts.filter((L) => L.gutters.length).length >= Math.max(1, Math.ceil(laidOut.length * 0.25));
    // Hyphenated words as the document writes them mid-line ("meta-analyses"),
    // to tell a real hyphen from a line-break one when rejoining lines.
    hyphenVocab = new Set();
    camelVocab = new Map();
    capsVocab = new Map();
    for (const pg of pdf.pages)
      for (const l of pg.lines)
        for (const s of l.spans) {
          for (const m of s.text.matchAll(/[\p{L}\d]+(?:-[\p{L}\d]+)+/gu)) hyphenVocab.add(m[0].toLowerCase());
          for (const m of s.text.matchAll(/\p{L}*\p{Ll}\p{Lu}\p{L}*/gu)) camelVocab.set(m[0], (camelVocab.get(m[0]) || 0) + 1);
          for (const m of s.text.matchAll(/\b\p{Lu}{2,}\b/gu)) capsVocab.set(m[0], (capsVocab.get(m[0]) || 0) + 1);
        }
    const stem = (filename || 'paper').replace(/\.[^.]+$/, '');

    if (!twoCol && !pdfHasSideMargin(pdf, globalBodyLeft)) {
      log('  single-column layout');
      const { parts, title, author } = await pdfSimpleFlow(pdf, bodySize, images, log);
      pdf.doc.destroy();
      return { parts, images, title: dropScripts(title) || pdf.meta.title.trim() || stem, author: dropScripts(author) || pdf.meta.author.trim(), twoCol: false };
    }
    log(twoCol ? '  layout in columns' : '  layout with a side-margin column');

    // Whether this PDF's own spaces can be trusted: some mark spaces inside
    // words too (kerning, "ex tubation"), and then many of them are narrow
    let narrow = 0;
    let marked = 0;
    for (const pg of pdf.pages)
      for (const l of pg.lines) {
        let prev = null;
        let blank = false;
        for (const s of l.spans) {
          if (!s.text.trim()) {
            blank = true;
            continue;
          }
          if (prev && blank) {
            const g = (s.bbox[0] - prev.bbox[2]) / s.size;
            marked++;
            if (g > 0.005 && g < 0.07) narrow++;
          }
          prev = s;
          blank = false;
        }
      }
    const trustSpaces = marked >= 20 && narrow < marked * 0.12; // (Epstein 1997: 20%; well-made PDFs under 8%)
    // repeated running headers/footers
    const ph = pdf.pages[0].height;
    // (digits normalised so "page 3" and "page 4" match, and a third of the
    // pages is enough since journals alternate left/right-page headers)
    const edgeKey = (t) => stripMarks(t).toLowerCase().replace(/\s+/g, '').replace(/\d+/g, '#');
    const edgeLines = new Counter();
    for (const pg of pdf.pages) {
      const seen = new Set();
      const edge = [];
      for (const l of pg.lines) {
        const y = l.bbox[1];
        if (y < ph * 0.1 || y > ph * 0.9) {
          const t = edgeKey(l.spans.map((s) => s.text).join(''));
          if (t) seen.add(t);
          if (horizontal(l)) for (const sp of l.spans) if (sp.text.trim()) edge.push({ y: (sp.bbox[1] + sp.bbox[3]) / 2, x: sp.bbox[0], x1: sp.bbox[2], text: sp.text });
        }
      }
      // whole visual rows too: a footer can be several runs ("the bmj" logo +
      // text + page number), and rows are what the text is compared by later
      edge.sort((a, b) => a.y - b.y || a.x - b.x);
      let row = [];
      const addRow = () => {
        if (!row.length) return;
        row.sort((a, b) => a.x - b.x);
        const sorted = row.map((r) => r.text).join(' ');
        seen.add(edgeKey(sorted));
        seen.add(edgeKey(sorted.replace(/^\s*[\divxlc]{1,4}\s+|\s+[\divxlc]{1,4}\s*$/gi, '')));
        // and each piece of the row on its own ("Journal (2024) 12:32" … "Page 5 of 13"):
        // the columns can take a header apart
        let piece = [row[0]];
        const flush = () => piece.length < row.length && seen.add(edgeKey(piece.map((r) => r.text).join(' ')));
        for (let k = 1; k < row.length; k++) {
          if (row[k].x - (row[k - 1].x1 ?? row[k - 1].x) > 24) {
            flush();
            piece = [];
          }
          piece.push(row[k]);
        }
        flush();
        row = [];
      };
      for (const e of edge) {
        if (row.length && Math.abs(e.y - row.at(-1).y) > 3) addRow();
        row.push(e);
      }
      addRow();
      seen.forEach((t) => edgeLines.add(t));
    }
    const repeatedKeys = new Set(edgeLines.entries().filter(([, c]) => c >= Math.max(3, Math.floor(pdf.pages.length / 3))).map(([t]) => t));
    // (a footer row can pick up the page number beside it: "… | doi … 7")
    let inRefs = false; // past the References heading (across pages)
    const repeated = { has: (t) => repeatedKeys.has(edgeKey(t)) || repeatedKeys.has(edgeKey(t.replace(/^\s*[\divxlc]{1,4}\s+|\s+[\divxlc]{1,4}\s*$/gi, ''))) };
    let parts = [];
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
      // (the line's type, not its superscripts: "models.³⁸ ⁶⁵ ⁶⁶ ⁶⁸" is in body type)
      const big = Math.max(...main.map((m) => m.size));
      const sized = main.filter((m) => !(m.size < big * 0.8 && /^[\d\s,–\-−*†‡§¶]+$/.test(m.text)));
      const c = new Counter();
      (sized.length ? sized : main).forEach((m) => c.add(pyRound(m.size), m.text.length));
      return [txt, asideTxt, c.mostCommon()];
    };
    const joinSorted = (sps) => resolveHat(ws(joinSpans([...sps].sort((a, b) => a.x0 - b.x0))).trim());

    // A paragraph can run on across a column or page break; anything the page
    // adds at its end (margin notes, boxes, images) waits until it closes.
    const TERMINAL = '.!?:;\u201d"\')]';
    // a sentence can end in a full stop and citation numbers ("outcome.6", "al.12")
    const CITED_END = /[\p{L})\]][.!?]\d{1,3}(?:[,\u2013-]\d{1,3})*$/u;
    const endsSentence = (s) => endsWithAny(s, TERMINAL) || CITED_END.test(dropScripts(s).trimEnd());
    const paraBuf = [];
    let pending = [];
    let paraQuote = false; // the open paragraph is an indented block quote
    let carryLine = null;
    const flushPara = () => {
      if (paraBuf.length) {
        const joined = joinWrapped(paraBuf);
        if (joined) parts.push(paraQuote && paraBuf.length > 1 ? `<blockquote><p>${escRich(joined)}</p></blockquote>` : `<p>${escRich(joined)}</p>`);
        paraBuf.length = 0;
      }
      paraQuote = false;
      if (pending.length) {
        parts.push(...pending);
        pending = [];
      }
    };
    const emit = (html) => (paraBuf.length ? pending.push(html) : parts.push(html));

    // A scan's recognised text gets its type size page by page (the pages are
    // scanned at slightly different scales), so "body size" is the page's own there.
    const docBody = bodySize;
    const pageBody = (pg) => {
      const c = new Counter();
      for (const l of pg.lines) for (const s of l.spans) if (s.text.trim()) c.add(pyRound(s.size), s.text.trim().length);
      const all = sum(c.entries().map(([, n]) => n));
      const m = c.mostCommon();
      return m !== undefined && all >= 300 && c.get(m) >= all * 0.5 ? m : null;
    };
    for (const pg of pdf.pages) {
      const bodySize = (pg.scan && pageBody(pg)) || docBody;
      // the page's blocks in reading order, and the block each piece of text is in
      const leaves = twoCol ? layouts[pdf.pages.indexOf(pg)].leaves : [];
      const leafOf = new Map();
      leaves.forEach((leaf, k) => leaf.items.forEach((it) => it.box && leafOf.set(it.box.span, k)));
      const inLeaf = (s) => {
        if (leafOf.has(s)) return leafOf.get(s);
        const [cx, cy] = [(s.bbox[0] + s.bbox[2]) / 2, (s.bbox[1] + s.bbox[3]) / 2];
        const k = leaves.findIndex((f) => cx >= f.x0 && cx <= f.x1 && cy >= f.y0 && cy <= f.y1);
        return Math.max(0, k);
      };
      const spans = [];
      // (but a line of the column's text that starts that high goes on in the line under it)
      const mastTop = pg.height * 0.075;
      const textBelow = (l) => {
        const h = l.bbox[3] - l.bbox[1];
        return pg.lines.some((o) => o !== l && horizontal(o) && o.bbox[3] >= mastTop && o.bbox[1] > l.bbox[1] && o.bbox[1] - l.bbox[3] < h * 0.8 && Math.abs(o.bbox[0] - l.bbox[0]) < 3 && Math.abs(o.spans[0].size - l.spans[0].size) < 0.6 && o.spans.map((x) => x.text).join('').trim().length >= 30);
      };
      for (const l of pg.lines) {
        if (!horizontal(l)) continue;
        if (pg === pdf.pages[0] && l.bbox[3] < mastTop && !textBelow(l)) continue; // masthead on the first page (journal logo, header)
        let blank = false;
        const own = [];
        for (const s of l.spans) {
          const t = fixGlyphs(s.text, s.font);
          // (a space the PDF itself put between two words is kept, however
          // tight the justified line: "develop a prediction model")
          if (!t.trim()) {
            if (t) blank = true;
            continue;
          }
          own.push({ text: t, x0: s.bbox[0], x1: s.bbox[2], y: (s.bbox[1] + s.bbox[3]) / 2, size: s.size, font: s.font, bold: !!(s.flags & 16), line: l, leaf: twoCol ? inLeaf(s) : 0, ...(blank && trustSpaces ? { sp: true } : {}) });
          blank = /\s$/.test(t);
        }
        // (but some PDFs mark spaces inside words too, for kerning: "ex tubation",
        // under 0.07 em wide, where a word space in the tightest justified line
        // is 0.09 em or more; and none goes before closing punctuation or
        // beside a dash: "f/VT)", "4—Predictors", "61–67")
        // (and at least half the line's usual word space: a 0.08 em gap on a line
        // whose words stand 0.3 em apart is kerning too)
        const wide = own.map((x, i) => (x.sp && i ? (x.x0 - own[i - 1].x1) / x.size : 0)).filter((g) => g >= 0.08).sort((a, c) => a - c);
        const usual = wide.length ? wide[wide.length >> 1] : 0;
        own.forEach((x, i) => {
          if (!x.sp || !i) return;
          const g = (x.x0 - own[i - 1].x1) / x.size;
          if (g < 0.08 || g < usual * 0.5 || /^[)\]},.;:!?%’”—–-]/.test(x.text) || /[(\[{—–-]$/.test(own[i - 1].text)) delete x.sp;
        });
        spans.push(...own);
      }
      if (!spans.length && !pg.images.length) continue;
      if (!spans.length) {
        // a page that is only a figure
        const blobs = await cropImages(pg, pg.images.filter(([x0, y0, x1, y1]) => x1 - x0 >= 24 && y1 - y0 >= 24)).catch(() => []);
        for (const blob of blobs) if (blob) emit(`<p><img src="pdfimg:${images.push(blob) - 1}" alt=""/></p>`);
        continue;
      }
      // On a two-column page the "body left edge" idea doesn't apply: the most
      // common left edge may be the right column's, turning the whole left
      // column into a "boxed insert". Margin notes are a single-column thing.
      const bodyLeft = twoCol ? -Infinity : globalBodyLeft;

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

      // Group spans into visual rows (re-joins super/subscripts). On a
      // two-column page, split by column first: lines of the two columns sit
      // at slightly different heights and would otherwise chain into one row.
      // Spans crossing the centre (title, wide captions) form their own group.
      // Lines starting left of the left column are either a margin column
      // (affiliations, notes: stays narrow) or a boxed insert that starts
      // further left but runs into the column. Decide per block of lines.
      const lineKind = new Map();
      // (text left of the first column, BMJ's margin of addresses and notes,
      // is kept apart from the body text)
      const firstCols = leaves.map((f, k) => (f.col ? k : -1)).filter((k) => k >= 0 && leaves[k].x0 <= Math.min(...leaves.filter((f) => f.col).map((f) => f.x0)) + 20);
      const leafOfLine = (l) => {
        const sp = spans.find((x) => x.line === l);
        return sp ? sp.leaf : -1;
      };
      let leftEdge = -Infinity;
      if (twoCol && firstCols.length) {
        // (lines of the column's own text size: a page can be set smaller than the rest)
        const own = pg.lines.filter((l) => horizontal(l) && firstCols.includes(leafOfLine(l)) && l.spans.map((s) => s.text).join('').trim().length >= 20);
        const sizes = new Counter();
        for (const l of own) for (const s of l.spans) sizes.add(Math.round(s.size * 2) / 2, s.text.length);
        const colSize = sizes.mostCommon() ?? bodySize;
        const c = new Counter();
        for (const l of own) if (Math.abs(Math.max(...l.spans.map((s) => s.size)) - colSize) <= 1.2 || Math.abs(pyRound(l.spans[0].size) - bodySize) <= 1) c.add(pyRound(l.bbox[0] / 5) * 5);
        // (the leftmost edge many lines start at: in a reference list the
        // first line of each entry, not the more numerous hanging lines)
        const total = sum(c.entries().map(([, n]) => n));
        const edges = c.entries().filter(([, n]) => n >= Math.max(3, total * 0.15)).map(([x]) => x);
        // (from a handful of lines it can't be told: a few hanging lines of a reference list)
        if (total >= 6) leftEdge = edges.length ? Math.min(...edges) : c.mostCommon() ?? -Infinity;
      }
      if (twoCol && leftEdge > -Infinity) {
        // (a paragraph or section number hanging left of the text, "1  This
        // Code covers…", "1.1  To which…", is part of its line, not a margin)
        const LABEL = /^\s*\(?(?:\d{1,3}(?:\.\d{1,2}){0,3}|[ivxlc]{1,5}|[IVXLC]{1,5}|[a-zA-Z])[.)]?\s*$/;
        const atEdge = (x) => Math.abs(x - leftEdge) <= 4;
        const hanging = (l) => {
          const sp = l.spans.filter((x) => x.text.trim()).sort((a, b) => a.bbox[0] - b.bbox[0]);
          if (!sp.length || !LABEL.test(sp[0].text)) return false;
          if (sp[1]) return atEdge(sp[1].bbox[0]);
          const yc = (l.bbox[1] + l.bbox[3]) / 2;
          return pg.lines.some((o) => o !== l && atEdge(o.bbox[0]) && Math.abs((o.bbox[1] + o.bbox[3]) / 2 - yc) < (l.bbox[3] - l.bbox[1]));
        };
        const big = (l) => Math.max(...l.spans.map((x) => x.size)) >= bodySize * 1.6; // (a title is never a margin note)
        const outer = pg.lines.filter((l) => horizontal(l) && l.bbox[0] < leftEdge - 6 && firstCols.includes(leafOfLine(l)) && !hanging(l) && !big(l)).sort((a, b) => a.bbox[1] - b.bbox[1]);
        let block = [];
        const close = () => {
          const wide = block.filter((l) => l.bbox[2] > leftEdge + 20).length;
          for (const l of block) lineKind.set(l, wide >= block.length * 0.4 ? 'box' : 'margin');
          block = [];
        };
        for (const l of outer) {
          if (block.length && l.bbox[1] - block.at(-1).bbox[3] > (l.bbox[3] - l.bbox[1]) * 1.5) close();
          block.push(l);
        }
        close();
      }
      // A block that starts "Box 2 …" (a boxed insert set apart from the
      // columns): it waits until the page's text is through, so a sentence
      // that runs from one column to the next past it stays whole
      const boxLeaf = leaves.map((f) => {
        const first = f.items.find((it) => it.box && it.box.text.trim());
        // (one block apart from the columns: a box running in the columns themselves, over two of them, reads where it stands)
        return !f.col && !!first && f.items.filter((it) => it.box).length >= 4 && /^\s*Box\s+\d{1,2}\b/.test(first.box.text);
      });
      // a narrow column of words beside the body: its own kind of note
      const sideNote = leaves.map((f) => {
        if (!f.col || f.x1 - f.x0 >= pg.width * 0.2 || leaves.length < 2) return false;
        const letters = f.items.reduce((n, it) => n + (it.box ? (it.box.text.match(/\p{L}/gu) || []).length : 0), 0);
        return letters >= 60;
      });
      // A shaded box of running text with a column beside it ("Summary
      // points", "Box 1" set over the margin and the first column): a boxed
      // insert, read after the page's text, not line by line with the column
      const shadeBoxes = twoCol && !leaves.some((f) => f.shade !== undefined)
        ? (pg.shades || []).filter((s) => {
            const mid = (l) => [(l.bbox[0] + l.bbox[2]) / 2, (l.bbox[1] + l.bbox[3]) / 2];
            const within = (l) => {
              const [cx, cy] = mid(l);
              return cx > s[0] && cx < s[2] && cy > s[1] && cy < s[3];
            };
            const inside = pg.lines.filter((l) => horizontal(l) && within(l));
            if (inside.length < 6) return false;
            const text = (l) => l.spans.map((x) => x.text).join(' ').trim();
            if (inside.some((l) => CAPTION.test(text(l)))) return false;
            const words = inside.map((l) => text(l).split(/\s+/).length);
            if (words.filter((n) => n >= 6).length < 5) return false;
            // (no line runs out of it: a box, not a tint behind the columns)
            if (pg.lines.some((l) => !within(l) && horizontal(l) && l.bbox[2] > s[0] + 4 && l.bbox[0] < s[2] - 4 && l.bbox[3] > s[1] + 3 && l.bbox[1] < s[3] - 3)) return false;
            // (with text beside it, at its height: else it reads where it stands)
            return pg.lines.some((l) => horizontal(l) && (l.bbox[0] >= s[2] - 2 || l.bbox[2] <= s[0] + 2) && l.bbox[1] < s[3] && l.bbox[3] > s[1] && text(l).split(/\s+/).length >= 5);
          })
        : [];
      const inShadeBox = new Set();
      for (const s of shadeBoxes)
        for (const l of pg.lines) {
          const cx = (l.bbox[0] + l.bbox[2]) / 2;
          const cy = (l.bbox[1] + l.bbox[3]) / 2;
          if (cx > s[0] && cx < s[2] && cy > s[1] && cy < s[3]) inShadeBox.add(l);
        }
      const colOf = (sp) => {
        if (!twoCol) return 0;
        if (inShadeBox.has(sp.line)) return -3;
        const kind = lineKind.get(sp.line);
        // (only the part of the line left of the first column: a line can
        // run on to the next column's text at the same height)
        if (kind === 'margin' && sp.x1 <= leftEdge + 6) return -2;
        if (kind === 'box' && sp.x0 < leftEdge - 6) return -3;
        if (sideNote[sp.leaf]) return -2;
        if (boxLeaf[sp.leaf]) return -3;
        return sp.leaf;
      };
      const rows = [];
      for (const c of [-3, -2, ...(twoCol ? leaves.map((_, k) => k) : [0])]) {
        const group = spans.filter((sp) => colOf(sp) === c).sort((a, b) => a.y - b.y || a.x0 - b.x0);
        const own = lineRows(group, bodySize, c);
        rows.push(...own);
      }
      // a block set mostly in bold (an abstract, say): bold marks no heading there
      const boldLeaf = new Set();
      if (twoCol)
        leaves.forEach((_, k) => {
          const own = spans.filter((sp) => sp.leaf === k);
          const all = sum(own.map((sp) => sp.text.length));
          if (all >= 200 && sum(own.filter((sp) => sp.bold).map((sp) => sp.text.length)) >= all * 0.6) boldLeaf.add(k);
        });
      // a block that runs across the columns (on a page that has columns)
      const wideLeaf = (c) => twoCol && leaves.some((f) => f.col) && leaves[c] && !leaves[c].col;

      // "Abstract  Social relationships have…": a run-in label in bigger or
      // bold type at the start of a body line is a heading of its own
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = [...rows[i]].sort((a, b) => a.x0 - b.x0);
        const [head, ...rest] = r;
        if (!rest.length || head.text.trim().split(/\s+/).length > 4 || sum(rest.map((sp) => sp.text.length)) < 20) continue;
        const restSize = rest[0].size;
        const differs = head.size >= restSize + 2 || (head.bold && !rest.some((sp) => sp.bold) && SECTION_WORD.test(head.text.trim()));
        if (!differs || rest.some((sp) => Math.abs(sp.size - restSize) > 1)) continue;
        // (in small print, "Acknowledgment: The authors thank…", the label stays in its line)
        if (head.size < restSize + 2 && restSize < bodySize - 0.5) continue;
        const a = [head];
        const b = rest;
        a.col = b.col = rows[i].col;
        rows.splice(i, 1, a, b);
      }
      {
        const boxes = findEquations(rows, bodySize);
        if (boxes.length) {
          const blobs = await cropRegions(pg, boxes);
          boxes.forEach((box, k) => {
            if (!blobs[k]) return;
            images.push(blobs[k]);
            const n = images.length - 1;
            const first = [...box.reg].sort((a, b) => a.base - b.base)[0];
            for (const r of box.reg) rows.splice(rows.indexOf(r), 1);
            const sp = { text: `\uE000${n}\uE001${box.alt}\uE001${box.no}\uE001${box.em}`, x0: box[0], x1: box[2], y: first.base, size: bodySize, font: '', bold: false, line: first[0].line };
            const row = [sp];
            row.col = first.col;
            row.base = first.base;
            row.eq = true;
            rows.splice(rows.indexOf(first) >= 0 ? rows.indexOf(first) : rows.length, 0, row);
          });
        }
      }
      let ordered = [];
      const pageAsides = [];
      const marginRows = [];
      const boxRows = [];
      const leftBlockRows = [];
      for (let row of rows) {
        const rowCol = row.col; // (row gets replaced by filtered copies below)
        const row0 = row;
        if (row.eq) {
          ordered.push([twoCol ? rowCol : 0, row[0].y, row[0].text, bodySize, row[0].x0, false, row[0].x1, false, false]);
          continue;
        }
        if (rowCol === -2 || rowCol === -3) {
          // margin notes and boxed inserts: after the page's text, so they
          // don't interrupt the narrative (as the script does for boxes)
          const mtxt = fixSmallCaps(joinSorted(row));
          if (mtxt.length > 1 && !repeated.has(mtxt) && !ROMAN_OR_DIGITS.test(mtxt))
            (rowCol === -2 ? marginRows : boxRows).push({ txt: mtxt, y: row[0].y, x1: Math.max(...row.map((z) => z.x1)), bold: row.every((z) => z.bold), sz: row[0].size });
          continue;
        }
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
        if ((repeated.has(txt) && !CAPTION.test(txt)) || ROMAN_OR_DIGITS.test(txt)) continue;
        txt = fixSmallCaps(txt);
        // Labels inside vector figures ("weight layer", "iter. (1e4)"): short
        // runs of smaller type, or rows that are mostly numbers.
        const letters = (txt.match(/\p{L}/gu) || []).length;
        // (but the short last line of a caption or note continues the long line above it)
        const continues = () => {
          const x0 = Math.min(...row.map((z) => z.x0));
          return rows.some((o) => {
            if (o === row || !o.length || !(o[0].y < row[0].y) || row[0].y - o[0].y > sz * 1.9 || Math.abs(o[0].size - row[0].size) > 0.6) return false;
            const ot = o.map((z) => z.text).join(' ').trim();
            return Math.abs(Math.min(...o.map((z) => z.x0)) - x0) < 4 && ot.length > 40 && !/[.!?:]\s*$/.test(ot);
          });
        };
        // (a bold line a size below the body that reads like words is a subheading, not a label)
        const allBold = row.every((z) => z.bold || !z.text.trim());
        const wordy = /^\p{Lu}/u.test(txt) && letters > txt.replace(/\s/g, '').length * 0.8;
        // (and a short bold line, even one word or in smaller type, right above a
        // paragraph that starts at its left edge heads that paragraph: "Patients",
        // "Funding" over the back matter's small print)
        // (words of one line of text, not cells of a table row: no wide gaps)
        const solid = (r) => {
          const xs = r.filter((z) => z.text.trim()).sort((a, b) => a.x0 - b.x0);
          return xs.every((z, i) => !i || z.x0 - xs[i - 1].x1 < z.size * 1.5);
        };
        const headsText = () => {
          const x0 = Math.min(...row.map((z) => z.x0));
          if (!solid(row)) return false;
          return rows.some((o) => {
            if (!o.length || o === row || o.col !== rowCol || !(o[0].y > row[0].y) || o[0].y - row[0].y > Math.max(sz, o[0].size) * 2.2) return false;
            // (the paragraph starts at its edge, or with a first-line indent)
            const dx = Math.min(...o.map((z) => z.x0)) - x0;
            if (Math.max(...o.map((z) => z.size)) < row[0].size - 0.3 || o.every((z) => z.bold || !z.text.trim()) || dx < -3 || dx > sz * 2.5) return false;
            const ot = o.map((z) => z.text).join(' ').trim();
            return ot.split(/\s+/).length >= 6 && (ot.match(/\p{L}/gu) || []).length >= ot.replace(/\s/g, '').length * 0.7 && solid(o);
          });
        };
        // (or in italic, as older journals set their run-in subheadings: "Relevant Predictors")
        const allItalic = row.every((z) => /italic|oblique/i.test(z.font || '') || !z.text.trim());
        const heads = (allBold || allItalic) && wordy && sz >= bodySize * 0.7 && !/[.,;:]$/.test(txt) && txt.split(/\s+/).length <= 8 && headsText();
        const subhead = (allBold && wordy && sz >= bodySize - 1.2 && txt.split(/\s+/).length >= 2) || heads;
        const refsTitle = /^\s*(\d+\.?\s+)?(references|bibliography|literature cited|works cited)\s*$/i.test(txt);
        if (refsTitle) inRefs = true;
        // (in the reference list a line of numbers is the end of a citation,
        // "44:1524–1527", "care. JAMA 2018; 319:1317–1318", not a figure label)
        const refTail = inRefs && sz >= bodySize * 0.6 && /\d/.test(txt) && /[;:]|\d{4}/.test(txt) && txt.length <= 90;
        // (and in a reference list set in narrow columns, short lines are the rule)
        const refLine = inRefs && sz >= bodySize * 0.6 && letters >= 3;
        // (a line of running text can be mostly numbers, "(n = 4 [15%]), and shock (n = 3 [12%]).":
        // it stands in the text when a wordy line of the same type starts at the same edge right above or below it)
        const inText = () => {
          const x0 = Math.min(...row.map((z) => z.x0));
          return rows.some((o) => {
            if (!o.length || o.col !== rowCol || Math.abs(o[0].y - row[0].y) > sz * 1.9 || Math.abs(o[0].y - row[0].y) < 1 || Math.abs(o[0].size - row[0].size) > 0.6) return false;
            if (Math.abs(Math.min(...o.map((z) => z.x0)) - x0) > 4) return false;
            const ot = o.map((z) => z.text).join(' ').trim();
            return ot.split(/\s+/).length >= 6 && (ot.match(/\p{L}/gu) || []).length >= ot.replace(/\s/g, '').length * 0.6;
          });
        };
        // (nor is a line within a block of running text in its type, lines at
        // one edge and close together, three of them sentences: "where",
        // "LP = −4.37 − 0.33 (HTN) + …" in a box that explains a model)
        const inBlock = () => {
          const x0 = Math.min(...row.map((z) => z.x0));
          const same = rows
            .filter((o) => o.length && o.col === rowCol && Math.abs(Math.max(...o.map((z) => z.size)) - Math.max(...row0.map((z) => z.size))) <= 0.6 && Math.abs(Math.min(...o.map((z) => z.x0)) - x0) <= 4)
            .map((o) => [Math.max(...o.map((z) => z.y)), o])
            .sort((a, b) => a[0] - b[0]);
          const i = same.findIndex((e) => e[1] === row0);
          if (i < 0) return false;
          let lo = i;
          let hi = i;
          while (lo > 0 && same[lo][0] - same[lo - 1][0] <= sz * 2.5) lo--;
          while (hi < same.length - 1 && same[hi + 1][0] - same[hi][0] <= sz * 2.5) hi++;
          const wordyLine = (o) => {
            const ot = o.map((z) => z.text).join(' ').trim();
            return ot.split(/\s+/).length >= 8 && (ot.match(/\p{L}/gu) || []).length >= ot.replace(/\s/g, '').length * 0.55 && /[.;:,]/.test(ot);
          };
          return same.slice(lo, hi + 1).filter((e) => wordyLine(e[1])).length >= 3;
        };
        // (nor is a section's name in capitals, set a little smaller: "DISCUSSION" in small caps)
        const sectionName = capsHeading(txt) && sz >= bodySize * 0.75;
        if (!CAPTION.test(txt) && !refsTitle && !sectionName && ((sz < bodySize - 0.5 && txt.split(/\s+/).length <= 4 && !continues() && !subhead && !refTail && !refLine) || (letters < txt.replace(/\s/g, '').length * 0.4 && !refTail && !inText())) && ((/^\s*[*†‡§¶]/.test(txt) && letters < txt.replace(/\s/g, '').length * 0.5) || !inBlock())) continue;
        const col = !twoCol ? 0 : rowCol === undefined ? 0 : rowCol;
        const bold = (row.every((sp) => sp.bold || !sp.text.trim()) && !boldLeaf.has(rowCol)) || (subhead && allItalic); // (an italic subheading counts as one)
        const fw = new Counter();
        row.forEach((sp) => fw.add(sp.font, sp.text.length));
        const font = fw.mostCommon();
        const styled = fw.get(font) >= 0.9 * sum(row.map((sp) => sp.text.length)) && styles.has(font, row.find((sp) => sp.font === font)?.size ?? sz);
        const minor = styled && styles.minor(font, row.find((sp) => sp.font === font)?.size ?? sz);
        ordered.push([col, row[0].y, txt, sz, Math.min(...row.map((sp) => sp.x0)), bold, Math.max(...row.map((sp) => sp.x1)), styled, minor, false, heads]);
        if (aside && aside.length > 3 && !repeated.has(aside)) pageAsides.push([aside, sz]);
      }
      // the page's blocks in their reading order, each from its top down
      if (twoCol) ordered.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      // Bold lines of running text (an abstract set in bold) are no headings:
      // a long bold line with another right above or below it
      {
        const longBold = (t) => t && t[5] && t[2].split(/\s+/).length >= 8;
        const runs = ordered.map((t, i) => longBold(t) && [ordered[i - 1], ordered[i + 1]].some((o) => longBold(o) && o[0] === t[0] && Math.abs(o[1] - t[1]) < t[3] * 1.8));
        ordered.forEach((t, i) => {
          // (and the short last line of such a paragraph)
          const tail = t[5] && !runs[i] && runs[i - 1] && ordered[i - 1][0] === t[0] && t[1] - ordered[i - 1][1] < t[3] * 1.8 && Math.abs(t[4] - ordered[i - 1][4]) < 4;
          if (runs[i] || tail) t[5] = false;
        });
      }
      // Notes at the foot of a column (where the authors work, "*See also
      // p. 2756") stand between a sentence and its next column: they wait
      // until the page's text is through, like margin notes. They are told
      // two ways: by their small type, or, where the text itself is set as
      // small (a Methods section), by the sentence they interrupt.
      if (twoCol && !inRefs) {
        const first = pg === pdf.pages[0];
        const MARK = /^\s*[*†‡§¶‖#]/;
        leaves.forEach((leaf, c) => {
          if (!leaf.col) return;
          const own = ordered.filter((t) => t[0] === c);
          const nextCol = leaves.findIndex((f, j) => j > c && f.col);
          if (nextCol < 0 || own.length < 3) return;
          const lineGaps = (rows) => rows.slice(1).map((t, i) => t[1] - rows[i][1]).filter((g) => g > 0).sort((a, b) => a - b);
          const setOff = (k, usual) => own[k][1] - own[k - 1][1] >= usual * 1.4;
          let k = 0;
          // (1) small against the text above it and the text the next column
          // goes on with: a Methods section set small all through isn't notes
          const goesOn = ordered.find((t) => t[0] === nextCol && t[2].length >= 20);
          if (goesOn) {
            let j = own.length;
            while (j > 0 && own[j - 1][3] <= goesOn[3] - 0.8 && !own[j - 1][2].startsWith('')) j--;
            const g = lineGaps(own.slice(0, j));
            if (j > 0 && j < own.length && own[j - 1][3] >= Math.max(...own.slice(j).map((t) => t[3])) + 0.8 && setOff(j, g.length ? g[g.length >> 1] : bodySize * 1.2) && (first || MARK.test(own[j][2]))) k = j;
          }
          // (2) set off from a sentence left unfinished, which the next
          // column takes up (it starts in lower case), and marked as a note
          const takesUp = ordered.find((t) => t[0] === nextCol && !t[2].startsWith(''));
          if (!k && takesUp && /^\p{Ll}/u.test(takesUp[2].trimStart())) {
            const g = lineGaps(own);
            const usual = g.length ? g[g.length >> 1] : bodySize * 1.2;
            // (at the foot of the column, under a full line of the same text the next column goes on with)
            for (let j = Math.max(1, Math.ceil(own.length * 0.6)); j < own.length && !k; j++) {
              const above = own[j - 1];
              if (!setOff(j, usual) || endsWithAny(above[2].trimEnd(), TERMINAL) || above[2].length < 30 || above[5] || CAPTION.test(above[2]) || Math.abs(above[3] - takesUp[3]) > 0.6) continue;
              if (MARK.test(own[j][2]) || (first && own[j][3] <= above[3] - 0.4)) k = j;
            }
          }
          // (3) a line or two in bold, set off above and below, in the middle
          // of a sentence that goes on under it ("For editorial comment see
          // page 1061" in a box): a notice, not part of the sentence
          {
            const g = lineGaps(own);
            const usual = g.length ? g[g.length >> 1] : bodySize * 1.2;
            for (let j = 1; j < own.length - 1; j++) {
              const above = own[j - 1];
              if (!own[j][5] || above[5] || above[2].length < 30 || !setOff(j, usual) || endsWithAny(above[2].trimEnd(), TERMINAL)) continue;
              const m = own[j + 1][5] && j + 2 < own.length && !setOff(j + 1, usual) ? j + 1 : j;
              const after = own[m + 1];
              // (plain text of one size above and below, the notice no bigger)
              if (after[5] || Math.abs(after[3] - above[3]) > 0.6 || own[j][3] > above[3] + 1.5) continue;
              if (after[1] - own[m][1] < usual * 1.4 || !/^\p{Ll}/u.test(after[2].trimStart())) continue;
              const notice = own.slice(j, m + 1);
              if (notice.map((t) => t[2]).join(' ').split(/\s+/).length < 3 || notice.some((t) => t[2].startsWith('\uE000') || CAPTION.test(t[2]))) continue;
              for (const t of notice) {
                ordered.splice(ordered.indexOf(t), 1);
                marginRows.push({ txt: t[2], y: t[1], x1: t[6], bold: false, sz: t[3] });
              }
              after[9] = true; // (the sentence goes straight on, across the space the notice left)
              own.splice(j, notice.length);
              if (k > j) k -= notice.length;
              break;
            }
          }
          if (!k) return;
          const foot = own.slice(k);
          if (foot.some((t) => CAPTION.test(t[2]) || /^\s*(references|bibliography)\s*$/i.test(t[2])) || foot[0][5]) return;
          for (const t of foot) {
            ordered.splice(ordered.indexOf(t), 1);
            marginRows.push({ txt: t[2], y: t[1], x1: t[6], bold: t[5], sz: t[3] });
          }
        });
        // A box at the head of a column ("Take-home message", in smaller type)
        // that a sentence from the column before runs past: the sentence goes on
        // under it in lower case. The box waits until the page's text is through.
        leaves.forEach((leaf, c) => {
          if (!leaf.col) return;
          const prevCol = leaves.findLastIndex((f, j) => j < c && f.col);
          const before = prevCol >= 0 && ordered.filter((t) => t[0] === prevCol).at(-1);
          if (!before || before[5] || before[2].length < 20 || endsWithAny(before[2].trimEnd(), TERMINAL)) return;
          const own = ordered.filter((t) => t[0] === c);
          const j = own.findIndex((t) => Math.abs(t[3] - before[3]) < 0.6 && !t[5]);
          if (j < 2 || !/^\p{Ll}/u.test(own[j][2].trimStart())) return;
          const box = own.slice(0, j);
          // (a box has a title, in bold: not a caption's last lines or a table's notes)
          if (!box[0][5]) return;
          // (all of it smaller than the text, or bold headings; set off from the text under it)
          if (box.some((t) => (!t[5] && t[3] > before[3] - 0.8) || t[2].startsWith('\uE000') || CAPTION.test(t[2]))) return;
          if (own[j][1] - box.at(-1)[1] < before[3] * 1.6 || box.map((t) => t[2]).join(' ').split(/\s+/).length < 8) return;
          for (const t of box) {
            ordered.splice(ordered.indexOf(t), 1);
            boxRows.push({ txt: t[2], y: t[1], x1: t[6], bold: t[5], sz: t[3] });
          }
        });
      }

      // Join body lines into paragraphs. Indents are measured per column (the
      // right column is not "indented" relative to the left one), and a larger
      // vertical gap than usual also starts a paragraph.
      const bodyX0 = new Map();
      const bodyX1 = new Map();
      const lineGap = new Map();
      for (const c of new Set(ordered.map((t) => t[0]))) {
        const lines = ordered.filter((t) => t[0] === c && t[3] < bodySize + 3);
        if (!lines.length) continue;
        const cnt = new Counter();
        lines.forEach((t) => cnt.add(pyRound(t[4])));
        bodyX0.set(c, cnt.mostCommon());
        const ends = new Counter();
        lines.forEach((t) => ends.add(pyRound(t[6] / 4) * 4));
        bodyX1.set(c, ends.mostCommon());
        // (from one line to the next: pieces at the same height, a figure's labels, don't count)
        const gaps = lines.slice(1).map((t, i) => t[1] - lines[i][1]).filter((g) => g > bodySize * 0.7).sort((a, b) => a - b);
        if (gaps.length) lineGap.set(c, gaps[gaps.length >> 1]);
      }
      // the last line of a paragraph still open from the previous page
      let prev = paraBuf.length ? carryLine : null;
      // A caption sitting in the middle of running text (top of a column) is
      // collected on the side, so the paragraph around it stays in one piece.
      let capBuf = null;
      const endCaption = () => {
        if (capBuf) emit(`<p>${escRich(joinWrapped(capBuf.lines))}</p>`);
        capBuf = null;
      };
      const SECTION = /^((\d+(\.\d+)*\.?|[A-Z]\.|[IVX]+\.)\s+\S|(abstract|introduction|background|related work|methods?|materials and methods|results|discussion|conclusions?|acknowledge?ments?|references|appendix)\b)/i;
      let lastHeading = null;
      let lastLead = null; // the last line of a paragraph set in big type
      let lastSmall = null; // the section heading just emitted, to join a wrapped second line
      // A contents page in the front matter: the EPUB has its own contents,
      // and the printed one comes out jumbled (entries, page numbers, columns)
      // a labelled heading wrapped onto lines that run on in lowercase ("5.2 Research
      // misconduct, / questionable research practices / and minor shortcomings")
      const headingLike = (t) => t[7] || t[5] || t[3] >= bodySize + 2;
      for (const t of ordered) {
        if (!headingLike(t) || !/^(?:\d{1,2}(?:\.\d{1,2})*|[A-Z])\.?\s+\p{Lu}/u.test(t[2])) continue;
        for (;;) {
          const n = ordered
            .filter((o) => o !== t && o[0] === t[0] && o[1] > t[1] && o[1] - t[1] < t[3] * 2.4)
            .sort((a, b) => a[1] - b[1])[0];
          if (!n || n[7] !== t[7] || n[5] !== t[5] || Math.abs(n[3] - t[3]) >= 0.5 || !/^\p{Ll}/u.test(n[2]) || (t[2] + ' ' + n[2]).split(/\s+/).length > 16) break;
          t[2] += ' ' + n[2];
          t[1] = n[1];
          t[6] = Math.max(t[6], n[6]);
          ordered.splice(ordered.indexOf(n), 1);
        }
      }
      if (pdf.pages.indexOf(pg) < 5 && ordered.some((t) => /^(table of )?contents?$/i.test(t[2].trim()))) {
        const rest = ordered.filter((t) => !/^(table of )?contents?$/i.test(t[2].trim()));
        const tocish = rest.filter((t) => /\s\d{1,3}$/.test(t[2].trim()) || /^\d{1,2}(\.\d{1,2})*\.?\s+\S/.test(t[2].trim()));
        if (rest.length && tocish.length >= rest.length * 0.6) ordered = [];
      }
      const emitRows = (list) => {
      for (let k = 0; k < list.length; k++) {
        let [c, y, txt, sz, x0, bold, x1, styled, minor, runsOn, heads] = list[k];
        if (txt.startsWith('\uE000')) {
          const [n, alt, no, em] = txt.slice(1).split('\uE001');
          flushPara();
          parts.push(eqTag(n, alt, no, em));
          prev = null;
          continue;
        }
        // first-page badges, not content
        if (pg === pdf.pages[0] && /^(open access|(research|review|original|brief) (article|research|report|communication)|research|r e s e a r c h.*)$/i.test(txt.trim())) continue;
        if (capBuf) {
          // (a caption's wide first line counts as full width, its next line as a column)
          // (the caption of another figure or table, right under this one, is its own)
          const [cm, c0] = [CAPTION.exec(txt), CAPTION.exec(capBuf.lines[0])];
          const another = cm && (!c0 || captionKey(cm) !== captionKey(c0) || endsWithAny(capBuf.lines.at(-1).trimEnd(), '.'));
          // (the short last line of a caption that runs across the columns
          // stands in a column: it goes with the unfinished line right above it)
          const lastLine = c !== capBuf.c && y > capBuf.y && y - capBuf.y < sz * 1.9 && Math.abs(sz - capBuf.sz) < 0.6 && Math.abs(x0 - capBuf.x0) < 4 && !endsWithAny(capBuf.lines.at(-1).trimEnd(), TERMINAL);
          let gapBreak = (c !== capBuf.c && !lastLine) || another || y - capBuf.y > (lineGap.get(c) || sz * 1.4) * 1.6 || Math.abs(sz - capBuf.sz) >= 1;
          // (in a block of notes, a sentence ending short of the margin ends its note)
          if (capBuf.aside && endsWithAny(capBuf.lines.at(-1).trimEnd(), TERMINAL) && capBuf.lastX1 < capBuf.maxX1 - 20) gapBreak = true;
          if (!gapBreak) {
            capBuf.lines.push(txt);
            capBuf.y = y;
            capBuf.lastX1 = x1;
            capBuf.maxX1 = Math.max(capBuf.maxX1 || 0, x1);
            continue;
          }
          endCaption();
        }
        // (a sentence that wraps onto "Fig. 3. Best performing …" isn't a
        // caption: the line before it in the same type didn't end a sentence)
        const midSentence = prev && prev.c === c && y > prev.y && y - prev.y < (lineGap.get(c) || sz * 1.4) * 1.4 && Math.abs(sz - prev.sz) < 0.5 && !endsWithAny(prev.txt.trimEnd(), TERMINAL);
        if (CAPTION.test(txt) && !midSentence) {
          capBuf = { lines: [txt], c, y, sz, x0 };
          continue;
        }
        // full-width lines in small type between the columns (a table's
        // note) are a block of their own: they mustn't take in the column
        // text that follows, which continues the page before
        if (wideLeaf(c) && sz <= bodySize - 1 && !headingText(txt) && txt.split(/\s+/).length >= 4) {
          capBuf = { lines: [txt], c, y, sz, x0, aside: true, lastX1: x1, maxX1: x1 };
          continue;
        }
        // bold, body-sized, short and numbered (or a standard name): a section heading
        const nWords = txt.split(/\s+/).length;
        // (a sentence ends before its citation numbers: "…new models.³⁸ ⁶⁵")
        const standalone = !paraBuf.length || endsWithAny(paraBuf.at(-1).trimEnd().replace(/([.!?])\s?\d{1,3}(?:[\s,–-]+\d{1,3})*$/, '$1'), TERMINAL);
        if (
          (bold && sz >= bodySize - 1.2 && sz < bodySize + 3 && !endsWithAny(txt, ',;') &&
            ((nWords <= 12 && SECTION.test(txt)) || (nWords <= 8 && standalone && !endsWithAny(txt, '.:') && /^\p{Lu}/u.test(txt)))) ||
          (standalone && sz >= bodySize - 0.5 && sz < bodySize + 3 && headingText(txt) && (styled || capsHeading(txt))) ||
          (capsHeading(txt) && sz >= bodySize - 2.5 && (NUMBERED.test(txt) || (standalone && nWords <= 4 && sz < bodySize + 3))) ||
          // (a section name in the headings' type, whatever came before: keywords without a full stop)
          (styled && nWords <= 4 && SECTION.test(txt) && headingText(txt) && sz >= bodySize - 0.5 && sz < bodySize + 3) ||
          // "1.1 Vision for a new publication culture": decimal-numbered, short, on its own
          // (some layouts mark headings by colour only)
          (standalone && /^\d{1,2}\.\d{1,2}(?:\.\d{1,2})*\.?\s+\p{Lu}/u.test(txt) && nWords <= 12 && !endsWithAny(txt, '.:;,') && sz >= bodySize - 0.5 && sz < bodySize + 3) ||
          // (a short bold or italic line right above its paragraph, in the text's own smaller type)
          (heads && standalone)
        ) {
          flushPara();
          const tag = (minor && !bold) || (heads && sz < bodySize - 1.2) ? 'h4' : 'h3';
          // a heading wrapped onto a second line is one heading
          if (lastSmall && lastSmall.tag === tag && lastSmall.minor === minor && lastSmall.c === c && y > lastSmall.y && y - lastSmall.y < sz * 2.4 && parts.length - 1 === lastSmall.i && !endsWithAny(lastSmall.text, '.') &&
            !NUMBERED.test(txt) && !SECTION_WORD.test(txt) && !(SECTION_WORD.test(lastSmall.text) && lastSmall.text.split(/\s+/).length <= 2)) {
            lastSmall.text += ' ' + txt;
            lastSmall.y = y;
            parts[lastSmall.i] = `<${tag}>${escRich(headingCase(lastSmall.text))}</${tag}>`;
            prev = null;
            lastHeading = null;
            continue;
          }
          parts.push(`<${tag}>${escRich(headingCase(txt))}</${tag}>`);
          lastSmall = { i: parts.length - 1, tag, text: txt, c, y, minor };
          prev = null;
          lastHeading = null;
          continue;
        }
        // big type is a heading, unless it's running text set large (an abstract or lead)
        // (a lead paragraph set large: lines start lowercase or follow a large
        // line of running text in the same size)
        // (a title wrapped onto a second line starts lowercase too: "a new publication culture";
        // "eLife digest" doesn't count as lowercase)
        const wrapsTitle = lastHeading && Math.abs(lastHeading.sz - sz) < 0.6 && lastHeading.c === c && y - lastHeading.y < sz * 2.2;
        const bigText0 = txt.split(/\s+/).length > 14 || (lastHeading && (lastHeading.text + ' ' + txt).split(/\s+/).length > 24) || (/^\p{Ll}+(?:\s|$)/u.test(txt) && !wrapsTitle) ||
          /[.!?]\s+\p{Lu}|,$/u.test(txt.replace(/^\s*\d{1,2}(\.\d{1,2})*\.?\s+/, '')) || // sentences: running text (after any section number)
          (lastHeading && lastHeading.sz >= sz * 1.5 && txt.split(/\s+/).length >= 5) || // the paragraph under a title, in much smaller type
          (lastLead && lastLead.c === c && Math.abs(lastLead.sz - sz) < 0.5 && y > lastLead.y && y - lastLead.y < sz * 1.8) ||
          // (the first lines of a lead paragraph: five lines or more run on in this size)
          (!(title === null && sz >= bodySize + 6) &&
            (() => {
              let n = 1;
              for (let j = k + 1, py = y; j < list.length && n < 5; j++) {
                const t = list[j];
                if (t[0] !== c || Math.abs(t[3] - sz) >= 0.5 || t[1] <= py || t[1] - py >= sz * 1.8) break;
                py = t[1];
                n++;
              }
              return n >= 5;
            })());
        // (a bold numbered subheading is a heading, whatever follows: "1.1 To which activities does this Code apply?")
        const bigText = bigText0 && !(bold && /^\d{1,2}\.\d{1,2}\.?\s+\p{Lu}/u.test(txt) && txt.split(/\s+/).length <= 14 && !/[.!?]\s+\p{Lu}/u.test(txt));
        if (sz >= bodySize + 3 && bigText) lastLead = { c, y, sz };
        if (sz >= bodySize + 3 && !bigText) {
          flushPara();
          txt = txt.replace(/\s+(?:DOI|doi):?\s*10\.\S+.*$/, ''); // a DOI printed beside the title
          // a heading wrapped onto two lines is one heading
          // (a title runs on after its colon: "Hiring as Cultural Matching: The Case of …")
          if (lastHeading && Math.abs(lastHeading.sz - sz) < 0.6 && lastHeading.c === c && y - lastHeading.y < sz * 2.2 && !endsWithAny(lastHeading.text, lastHeading.tag === 'h1' || /^\p{Ll}/u.test(txt) ? '.' : '.:')) {
            lastHeading.text += ' ' + txt;
            lastHeading.y = y;
            parts[lastHeading.i] = `<${lastHeading.tag}>${escRich(lastHeading.text)}</${lastHeading.tag}>`;
            if (lastHeading.tag === 'h1') title = lastHeading.text;
            continue;
          }
          const tag = title === null && sz >= bodySize + 6 ? 'h1' : 'h2';
          if (tag === 'h1') title = txt;
          parts.push(`<${tag}>${escRich(txt)}</${tag}>`);
          lastHeading = { i: parts.length - 1, tag, text: txt, sz, y, c };
          prev = null;
          continue;
        }
        lastHeading = null;
        // "2.4 Inequities in access to journals and other / publication venues"
        if (lastSmall && parts.length - 1 === lastSmall.i && lastSmall.minor === minor && lastSmall.c === c && y > lastSmall.y && y - lastSmall.y < sz * 2.2 && /^\p{Ll}/u.test(txt) && txt.split(/\s+/).length <= 6 && !endsWithAny(txt, '.:;,') && !endsWithAny(lastSmall.text, '.:')) {
          lastSmall.text += ' ' + txt;
          lastSmall.y = y;
          parts[lastSmall.i] = `<${lastSmall.tag}>${escRich(headingCase(lastSmall.text))}</${lastSmall.tag}>`;
          continue;
        }
        const x = bodyX0.get(c);
        let startsPara = x !== undefined && x0 > x + 3;
        if (prev && prev.c === c && lineGap.has(c) && y - prev.y > lineGap.get(c) * 1.6) startsPara = true;
        if (prev && Math.abs(sz - prev.sz) >= 2) startsPara = true;
        // the previous line stopped well short of the column edge: its paragraph ended
        if (prev && prev.c === c && bodyX1.has(c) && prev.x1 < bodyX1.get(c) - (bodyX1.get(c) - (bodyX0.get(c) ?? 0)) * 0.15 && endsWithAny(prev.txt.trimEnd(), TERMINAL)) startsPara = true;
        // block quotes: every line keeps the indent, so an indented line under
        // a line indented the same way continues it (a first-line indent doesn't repeat)
        const indented = x !== undefined && x0 > x + 6;
        // (across a column or page break, compare the indent from each column's margin)
        const moved = !prev || prev.c !== c || y < prev.y;
        const sameIndent = prev && prev.indented && Math.abs(sz - prev.sz) < 0.5 &&
          (moved ? Math.abs(x0 - x - prev.indent) <= 1.5 : Math.abs(x0 - prev.x0) <= 1.5 && y - prev.y < (lineGap.get(c) || sz * 1.4) * 1.6);
        // (prose only: indented table rows stay one per line)
        const prose = (txt.match(/\p{L}{2,}/gu) || []).length >= 4 && (txt.match(/\d/g) || []).length < txt.length * 0.15;
        // (but a bulleted item ends at a finished sentence followed by extra space)
        const itemEnds = paraBuf.length && /^\s*•/.test(paraBuf[0]) && prev && endsWithAny(prev.txt.trimEnd(), TERMINAL) && y - prev.y > (lineGap.get(c) || sz * 1.4) * 1.15;
        if (indented && sameIndent && prose && !itemEnds) startsPara = false;
        // the short last line of an indented paragraph ("like him.") continues
        // the line above when that one didn't end a sentence
        const tail = indented && prev && prev.c === c && prev.indented && Math.abs(x0 - prev.x0) <= 1.5 && Math.abs(sz - prev.sz) < 0.5 && y > prev.y && y - prev.y < (lineGap.get(c) || sz * 1.4) * 1.6 && !endsWithAny(prev.txt.trimEnd(), TERMINAL);
        if (tail) startsPara = false;
        // a numbered or bulleted item's lines hang under its text, further in
        // than the number: "1. We present all … / could be recorded in …"
        const hangs = prev && prev.c === c && paraBuf.length === 1 && /^\s*(\d{1,2}[.)]|\(?[a-z][.)]|[•\u2013-])\s/.test(paraBuf[0]) && x0 > prev.x0 + 3 && x0 - prev.x0 < sz * 3 && y > prev.y && y - prev.y < (lineGap.get(c) || sz * 1.4) * 1.6 && Math.abs(sz - prev.sz) < 1.5 &&
          // (not a sub-item: its own marker, "B Group 1 …" with a symbol font's bullet, or under an item ending in a colon)
          !/^\s*([•\u2013-]|\d{1,2}[.)]|\(?[a-z][.)]|\p{Lu}\s+\p{Lu})/u.test(txt) && !endsWithAny(prev.txt.trimEnd(), ':');
        if (hangs) startsPara = false;
        if (startsWithAny(txt.trimStart(), ['•', '–', '- ', '* '])) startsPara = true;
        else if (startsPara && paraBuf.length && /^\s*•/.test(paraBuf[0]) && prev && prev.c === c && y > prev.y && y - prev.y < (lineGap.get(c) || sz * 1.4) * 1.6 && Math.abs(sz - prev.sz) < 0.5 && x !== undefined && x0 > x + 3 && !(endsWithAny(prev.txt.trimEnd(), TERMINAL) && y - prev.y > (lineGap.get(c) || sz * 1.4) * 1.15)) startsPara = false;
        // (a word broken at the end of the line above goes on here, whatever
        // the indent: the lines beside a big first letter)
        if (startsPara && prev && prev.c === c && y > prev.y && y - prev.y < (lineGap.get(c) || sz * 1.4) * 1.6 && Math.abs(sz - prev.sz) < 0.5 && /\p{Ll}-$/u.test(prev.txt.trimEnd()) && /^\p{Ll}/u.test(txt)) startsPara = false;
        // a short line standing alone atop a column, after a finished
        // sentence ("Endpoints", then a gap, then its text): not the end of
        // the paragraph before
        if (!startsPara && twoCol && prev && prev.c !== c && endsWithAny(prev.txt.trimEnd(), TERMINAL) && /^\p{Lu}/u.test(txt) && txt.split(/\s+/).length <= 6 && !endsWithAny(txt, TERMINAL + ',')) {
          const below = ordered.find((o) => o[0] === c && o[1] > y + 1);
          if (below && below[1] - y > (lineGap.get(c) || sz * 1.4) * 1.4) startsPara = true;
        }
        if (runsOn && paraBuf.length) startsPara = false;
        if (startsPara) {
          flushPara();
          paraQuote = indented && sz < bodySize - 0.4;
        } else if (!(indented && sameIndent && prose) && !tail) paraQuote = paraQuote && indented;
        paraBuf.push(txt);
        prev = { c, y, sz, x1, txt, x0, indented, indent: x0 - (x ?? x0) };
      }
      };
      // A shaded box at the top of the page, with a paragraph still open from the
      // page before: the paragraph goes on under the box, so the box is set aside
      // and comes once that paragraph has closed (as margin notes do).
      const boxIdx = new Set(leaves.map((f, k) => (f.shade ? k : -1)).filter((k) => k >= 0));
      if (boxIdx.size && paraBuf.length && ordered.some((t) => boxIdx.has(t[0]))) {
        const carried = paraBuf.splice(0);
        const carriedQuote = paraQuote;
        const carriedPrev = prev;
        const realParts = parts;
        const realPending = pending;
        parts = [];
        pending = [];
        prev = null;
        emitRows(ordered.filter((t) => boxIdx.has(t[0])));
        endCaption();
        flushPara();
        const boxHtml = parts;
        parts = realParts;
        pending = realPending;
        pending.push(...boxHtml);
        paraBuf.push(...carried);
        paraQuote = carriedQuote;
        prev = carriedPrev;
        emitRows(ordered.filter((t) => !boxIdx.has(t[0])));
      } else emitRows(ordered);
      endCaption();
      // keep an unfinished paragraph open across the page break
      if (paraBuf.length && endsSentence(paraBuf.at(-1))) flushPara();
      carryLine = prev;

      // deferred table rows / boxed prose
      if (leftBlockRows.length) {
        const boxX0s = leftBlockRows.map(([, x]) => x).filter((x) => x !== null);
        const boxBase = boxX0s.length ? Math.min(...boxX0s) : 0;
        const bbuf = [];
        let tableLines = [];
        const flushBox = () => {
          if (bbuf.length) {
            const j = joinWrapped(bbuf);
            if (j) emit(`<p>${escRich(j)}</p>`);
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
            emit('<p>' + tableLines.map(escRich).join('<br/>') + '</p>');
            tableLines = [];
          }
          if (lx0 > boxBase + 3 || startsWithAny(ltxt.trimStart(), ['•', '–', '-', '*'])) flushBox();
          bbuf.push(ltxt);
        }
        flushBox();
        if (tableLines.length) emit('<p>' + tableLines.map(escRich).join('<br/>') + '</p>');
      }
      for (const [aside] of pageAsides) emit(`<p><small>${escRich(aside)}</small></p>`);
      // boxed inserts: bold short lines are their headings; a short line ends an item
      if (boxRows.length) {
        const ends = new Counter();
        boxRows.forEach((r) => ends.add(pyRound(r.x1 / 6) * 6));
        const right = Math.max(ends.mostCommon(), ...boxRows.map((r) => r.x1).filter((x) => x < ends.mostCommon() + 12));
        let buf = [];
        const out = () => {
          if (buf.length) emit(`<p>${escRich(joinWrapped(buf))}</p>`);
          buf = [];
        };
        let head = null; // (a box's title wrapped onto a second line is one title)
        // (items set a little further apart than their lines: "Summary points"
        // without bullets)
        const steps = boxRows.slice(1).map((r, i) => r.y - boxRows[i].y).filter((d) => d > 0 && d < boxRows[0].sz * 2);
        const step = steps.length >= 6 ? steps.sort((a, b) => a - b)[steps.length >> 1] : 0;
        boxRows.forEach((r, i) => {
          const prev = boxRows[i - 1];
          // (a "Box 1: …" title runs on for a line or two)
          const titleGoesOn = head && /^Box\s+\d/.test(head.text) && prev && prev.bold && r.bold && !buf.length && r.y > prev.y && r.y - prev.y < r.sz * 1.8 && !/[.?!]\s*$/.test(prev.txt) && !/[:]\s*$/.test(r.txt);
          if (titleGoesOn || (r.bold && r.txt.split(/\s+/).length <= (/^Box\s+\d/.test(r.txt) ? 20 : 10) && !CAPTION.test(r.txt))) {
            if (head && prev && prev.bold && r.y > prev.y && r.y - prev.y < r.sz * 1.8 && !buf.length) {
              head.text += ' ' + r.txt;
              // (a long title is a sentence already: its capitals are names)
              head.list[head.i] = `<h4>${escRich(head.text.split(/\s+/).length > 12 ? head.text : headingCase(head.text))}</h4>`;
              return;
            }
            out();
            const list = paraBuf.length ? pending : parts; // (where emit puts it)
            emit(`<h4>${escRich(headingCase(r.txt))}</h4>`);
            head = { list, i: list.length - 1, text: r.txt };
            return;
          }
          head = null;
          buf.push(r.txt);
          const next = boxRows[i + 1];
          // (a short line ends an item, and a bullet starts one)
          // (but not before a line that goes on in lowercase: a long word wrapped)
          const apart = step && next && Math.abs(next.sz - r.sz) < 0.3 && next.y - r.y > step * 1.07 && next.y - r.y > step + 0.7 && next.y - r.y < step * 1.6 && /^\s*[\p{Lu}\d]/u.test(next.txt);
          if (apart || (r.x1 < right - 40 && !(next && /^\s*\p{Ll}/u.test(next.txt) && !/[.?!:;]\s*$/.test(r.txt))) || !next || next.bold || /^\s*[•▪■◦‣●]/.test(next.txt)) out();
        });
        out();
      }
      // margin notes: consecutive lines joined into small paragraphs
      if (marginRows.length) {
        let buf = [];
        let lastY = null;
        const out = () => {
          if (buf.length) emit(`<p><small>${escRich(joinWrapped(buf))}</small></p>`);
          buf = [];
        };
        for (const r of marginRows) {
          if (lastY !== null && r.y - lastY > r.sz * 1.6) out();
          buf.push(r.txt);
          lastY = r.y;
        }
        out();
      }
      // The script's multi-column branch dropped images entirely; keep them,
      // after the page's text (column order makes exact placement guesswork).
      const keep = pg.images.filter(([x0, y0, x1, y1]) => x1 - x0 >= 24 && y1 - y0 >= 24 && !(y1 < ph * 0.1 || y0 > ph * 0.92));
      if (keep.length) {
        const blobs = await cropImages(pg, keep).catch(() => []);
        const capRows = rows.map((r) => ({ text: joinSpans([...r].sort((a, b) => a.x0 - b.x0)), y0: Math.min(...r.map((z) => z.y - z.size / 2)), y1: Math.max(...r.map((z) => z.y + z.size / 2)) }));
        blobs.forEach((blob, k) => {
          if (!blob) return;
          images.push(blob);
          emit(imgTag(images.length - 1, captionNumber(keep[k], capRows), keep[k]));
        });
      }
    }
    flushPara();
    pdf.doc.destroy();
    // A drop cap (the big first letter of the text) comes out as a heading of
    // one letter between the lines beside it and the rest: "he adoption …
    // tradi-" · "T" · "tionally …". Put it back: "The adoption … traditionally …"
    for (let i = 1; i < parts.length; i++) {
      const cap = /^<h[1-6][^>]*>([A-Z])<\/h[1-6]>$/.exec(parts[i]);
      if (!cap) continue;
      const P = /^<p>(\p{Ll}[\s\S]*)<\/p>$/u;
      const before = P.exec(parts[i - 1] || '');
      const after = P.exec(parts[i + 1] || '');
      if (before) {
        let text = cap[1] + before[1];
        let drop = 1;
        // the lines beside the cap end mid-word or mid-sentence: the rest follows
        if (after && !/[.!?:]$/.test(before[1].trim())) {
          text = /-$/.test(text) ? text.replace(/-$/, '') + after[1] : `${text} ${after[1]}`;
          drop = 2;
        }
        parts.splice(i - 1, 1 + drop, `<p>${text}</p>`);
      } else if (after) parts.splice(i, 2, `<p>${cap[1]}${after[1]}</p>`);
    }
    // a chapter title on a divider page, printed again atop the next page: one heading
    const H2 = /^<h2>(.*)<\/h2>$/;
    const norm = (h) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    for (let i = parts.length - 1; i > 0; i--) {
      const [a, b] = [H2.exec(parts[i - 1]), H2.exec(parts[i])];
      if (a && b && norm(a[1]).length >= 4 && (norm(b[1]) === norm(a[1]) || norm(b[1]).endsWith(' ' + norm(a[1])))) parts.splice(i - 1, 1);
    }
    return { parts, images, title: dropScripts(title) || pdf.meta.title.trim() || stem, author: pdf.meta.author.trim(), twoCol };
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
          const res = await fetchT(new URL(src, baseUrl).href, {}, 30000);
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
        let type = blob ? (blob.type || '').split(';')[0] : '';
        // tiny files are spacers/pixels; text/html is a bot-check or error page
        if (!blob || (blob.size < 1024 && !(bestSrc(img) || '').startsWith('pdfimg:')) || (type && type !== 'application/octet-stream' && !type.startsWith('image/'))) {
          img.remove();
          continue;
        }
        if (!IMG_TYPES[type]) {
          const ext = ((bestSrc(img) || '').split(/[?#]/)[0].match(/\.[a-z]+$/i) || [''])[0].toLowerCase();
          type = EXT_TYPES[ext] || 'image/jpeg';
        }
        const name = `images/img${String(i).padStart(3, '0')}${IMG_TYPES[type]}`;
        media.push({ name, blob, type });
        img.setAttribute('src', name);
        for (const a of ['srcset', 'data-srcset', 'data-src', 'loading', 'decoding', 'sizes', 'width', 'height', 'style']) if (!(a === 'style' && img.parentElement && img.parentElement.classList.contains('equation'))) img.removeAttribute(a); // (an equation keeps its size in em)
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

  // LaTeX's \resizebox comes through arXiv's HTML as a box of fixed size
  // (sized for the printed page) with the content scaled inside it. On a
  // phone the box is too wide and too short, so the table spills over the
  // text after it. Let the content take its natural size; CSS fits it.
  function unboxScaled(root) {
    for (const el of root.querySelectorAll('[style]')) {
      const st = el.getAttribute('style');
      if (!/(^|;)\s*(transform|width|height)\s*:/i.test(st) || !el.querySelector('table, img, svg')) continue;
      if (!/ltx_transformed|ltx_inline-block/.test(el.className) && !/transform\s*:/i.test(st)) continue;
      const kept = st
        .split(';')
        .filter((d) => d.trim() && !/^\s*(transform|width|height|vertical-align)\s*:/i.test(d))
        .join(';');
      if (kept) el.setAttribute('style', kept);
      else el.removeAttribute('style');
    }
    // (a table can't sit inside an inline element in an EPUB: make those blocks)
    for (const sp of [...root.querySelectorAll('span')].reverse()) {
      if (!sp.querySelector('table')) continue;
      const div = sp.ownerDocument.createElement('div');
      for (const at of sp.attributes) div.setAttribute(at.name, at.value);
      div.append(...sp.childNodes);
      sp.replaceWith(div);
    }
  }

  function cleanFragment(root, title) {
    unboxScaled(root);
    dropDuplicateHeading(root, title);
    sanitizeIds(root);
    fixDanglingFragments(root);
    namespaceIds(root);
    fixAriaReferences(root);
    stripBadAttributes(root);
    fixDanglingFragments(root);
  }

  // ================================================================ figure placement
  // Put every figure (and table) right after the paragraph that first refers
  // to it, whatever the source: text sources often collect figures at the
  // end, and PDFs put them wherever they fell on the page.
  const REF_RE = /\b(Figs?\.?|Figures?|Tables?|Tabs?\.)\s*((?:\d+[A-Za-z]?(?:\s*(?:,|and|&|–|-|to)\s*)?)+)/gi;
  const kindOf = (word) => (/^t/i.test(word) ? 'table' : 'figure');
  function numbersIn(list) {
    const out = new Set();
    for (const m of list.matchAll(/(\d+)[A-Za-z]?(?:\s*(?:–|-|to)\s*(\d+))?/g)) {
      const a = +m[1];
      const b = m[2] ? +m[2] : a;
      for (let n = a; n <= Math.min(b, a + 30); n++) out.add(n);
    }
    return out;
  }

  // PDF output: join each caption paragraph ("Figure 3. …") with the images
  // tagged as belonging to it into one <figure>.
  function groupPdfFigures(root) {
    const doc = root.ownerDocument;
    for (const p of [...root.querySelectorAll('p')]) {
      if (p.querySelector('img')) continue;
      const m = CAPTION.exec(p.textContent);
      if (!m) continue;
      const imgs = [...root.querySelectorAll(`img[data-fig="${captionKey(m)}"]`)].filter((img) => !img.closest('figure'));
      if (!imgs.length) continue;
      const fig = doc.createElement('figure');
      for (const img of imgs) {
        const holder = img.closest('p');
        fig.append(img);
        if (holder && !holder.textContent.trim() && !holder.querySelector('img')) holder.remove();
      }
      const cap = doc.createElement('figcaption');
      cap.append(...p.childNodes);
      // small-caps labels extract lowercase ("fig 1 |")
      const t0 = cap.firstChild;
      if (t0 && t0.nodeType === 3) t0.data = t0.data.replace(/^(\s*)(fig|table)\b/, (_, sp, w) => sp + w[0].toUpperCase() + w.slice(1));
      fig.append(cap);
      p.replaceWith(fig);
    }
    // Images whose caption got merged into running text still know their
    // number: wrap them as "Figure N" so they can be placed all the same.
    const leftover = new Map();
    for (const img of root.querySelectorAll('img[data-fig]')) {
      if (img.closest('figure')) continue;
      const n = img.getAttribute('data-fig');
      if (!leftover.has(n)) leftover.set(n, []);
      leftover.get(n).push(img);
    }
    for (const [n, imgs] of leftover) {
      const fig = doc.createElement('figure');
      const first = imgs[0].closest('p') || imgs[0];
      first.before(fig);
      for (const img of imgs) {
        const holder = img.closest('p');
        fig.append(img);
        if (holder && !holder.textContent.trim() && !holder.querySelector('img')) holder.remove();
      }
      const cap = fig.appendChild(doc.createElement('figcaption'));
      const [kind, num] = n.split('-');
      cap.appendChild(doc.createElement('strong')).textContent = `${kind === 'table' ? 'Table' : 'Figure'} ${num}`;
    }
    root.querySelectorAll('[data-fig]').forEach((el) => el.removeAttribute('data-fig'));
  }

  function placeFigures(root, log) {
    const figures = [...root.querySelectorAll('figure')].filter((f) => !f.parentElement.closest('figure'));
    if (!figures.length) return;
    // stop at the reference list: "see Figure 2" there is someone else's figure
    const blocks = [];
    for (const el of root.querySelectorAll('h1, h2, h3, h4, p, li')) {
      if (/^h/.test(el.localName) && /^(references|bibliography|literature cited|works cited)\b/i.test(el.textContent.trim())) break;
      if (el.localName === 'li' && el.querySelector('p')) continue;
      if (!/^h/.test(el.localName) && !el.closest('figure, table, .ltx_bibliography')) blocks.push(el);
    }
    const after = new Map(); // block → last figure placed after it (keeps order)
    let moved = 0;
    for (const fig of figures) {
      const cap = fig.querySelector('figcaption') || fig;
      const m = /^\s*(Figs?\.?|Figures?|FIGURE|Tables?|TABLE)\s*(\d+)/i.exec(cap.textContent.replace(/^\s*\S*?(?=(Fig|Tab))/i, ''));
      const ids = new Set([fig.id, ...[...fig.querySelectorAll('[id]')].map((e) => e.id)].filter(Boolean));
      const kind = m ? kindOf(m[1]) : null;
      const num = m ? +m[2] : null;
      const target = blocks.find((b) => {
        if ([...b.querySelectorAll('a[href^="#"]')].some((a) => ids.has(a.getAttribute('href').slice(1)))) return true;
        if (!m) return false;
        for (const r of b.textContent.matchAll(REF_RE)) if (kindOf(r[1]) === kind && numbersIn(r[2]).has(num)) return true;
        return false;
      });
      if (!target) continue;
      // insert at block level: a figure can't go inside a list
      let anchor = target;
      while (anchor.parentElement && anchor.parentElement !== root && /^(ul|ol|li)$/.test(anchor.parentElement.localName)) anchor = anchor.parentElement;
      if (anchor.localName === 'li') anchor = anchor.closest('ul, ol') || anchor;
      const prev = after.get(anchor) || anchor;
      if (prev.nextElementSibling !== fig) {
        prev.after(fig);
        moved++;
      }
      after.set(anchor, fig);
    }
    // headings left with nothing under them ("Figures", "Tables")
    for (const h of [...root.querySelectorAll('h2, h3, h4')]) {
      const next = h.nextElementSibling;
      if (/^(figures?|tables?|figures and tables|figure legends)$/i.test(h.textContent.trim()) && (!next || /^h[1-4]$/.test(next.localName))) h.remove();
    }
    if (moved) log(`→ placed ${moved} figure(s)/table(s) after their first mention`);
  }

  // ================================================================ in-document links
  // Turn citations, figure/table and section mentions into links. Sources
  // that already link (arXiv HTML, PMC cross-references) keep theirs.
  function replaceInText(root, re, make, skip = 'a, h1, h2, h3, h4, h5, h6, .refs, script, style, math') {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!re.test(n.data) || (n.parentElement && n.parentElement.closest(skip))) continue;
      nodes.push(n);
    }
    let count = 0;
    for (const node of nodes) {
      const frag = doc.createDocumentFragment();
      let last = 0;
      for (const m of node.data.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
        const made = make(m, doc);
        if (!made) continue;
        frag.append(node.data.slice(last, m.index), ...made);
        last = m.index + m[0].length;
        count++;
      }
      if (!last) continue;
      frag.append(node.data.slice(last));
      node.replaceWith(frag);
    }
    return count;
  }
  const anchor = (doc, href, text) => {
    const a = doc.createElement('a');
    a.setAttribute('href', '#' + href);
    a.textContent = text;
    return a;
  };
  const surnameKey = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');

  function linkify(root, log) {
    const doc = root.ownerDocument;
    let links = 0;
    // ---- the reference list
    let container = root.querySelector('.ltx_bibliography, ol.refs');
    if (container) container.classList.add('refs');
    const REF_TITLE = /^(references|bibliography|literature cited|works cited|reference list|cited literature)\b/i;
    let refHead = [...root.querySelectorAll('h1, h2, h3, h4')].find((h) => REF_TITLE.test(h.textContent.trim()));
    // set smaller than body text, "References" can come out as a plain line
    if (!refHead) refHead = [...root.querySelectorAll('p')].find((p) => REF_TITLE.test(p.textContent.trim()) && p.textContent.trim().length < 30);
    // or run into the list itself: "References 1. Sutton RS, …"
    if (!refHead) {
      const p = [...root.querySelectorAll('p')].find((x) => /^(references|bibliography|literature cited|works cited)\s+\[?1[\].]?\s/i.test(x.textContent.trim()));
      const t = p && p.firstChild && p.firstChild.nodeType === 3 ? p.firstChild : null;
      const m = t && /^\s*(references|bibliography|literature cited|works cited)\s+/i.exec(t.data);
      if (m) {
        t.data = t.data.slice(m[0].length);
        refHead = doc.createElement('h2');
        refHead.textContent = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
        p.before(refHead);
      }
    }
    // no title at all: a closing run of paragraphs that mostly start "12 Surname AB" / "[12]"
    if (!refHead) {
      // (one unbroken run from the end: it stops at a heading, or after a few
      // paragraphs in a row that aren't references; a numbered list in the
      // text, "1. Create many bootstrap samples", isn't the reference list)
      const kids = [...root.children];
      // (a surname can start with a particle: "1 van Smeden M", "4 de Jong PA")
      const PARTICLE = "(?:(?:van|von|de|der|den|del|della|di|da|du|dos|le|la|ten|ter|el|al)\\s+)*";
      const starts = (e) => new RegExp(`^\\[?\\d{1,3}[\\].]?\\s+${PARTICLE}[\\p{Lu}][\\p{L}'’-]+`, 'u').test(e.textContent.trim());
      // (a piece of a reference broken off at a column end: "models (part 2): …
      // BMJ 2023;383:e074820. doi:…": it carries on the list, it doesn't break it)
      const refPiece = (e) => /\bdoi[:.]\s*10\.|\b(?:1[89]|20)\d\d;\s*\d+|\bet al\b|(?:^|\s)\d{1,3}\s[\p{Lu}][\p{L}'’-]+\s[\p{Lu}]{1,3}[,.]/u.test(e.textContent);
      // (entries run on inside a paragraph count too: "…doi:10.1136/x 5 Collins GS, …")
      const inner = (e) => [...e.textContent.matchAll(new RegExp(`\\s\\d{1,3}\\s+${PARTICLE}[\\p{Lu}][\\p{L}'’-]+\\s[\\p{Lu}]{1,4}(?:Jr|Sr)?[,.]`, 'gu'))].length;
      let hits = 0;
      let gap = 0;
      let first = null;
      for (let i = kids.length - 1, seen = 0; i >= 0 && seen <= 400; i--) {
        const e = kids[i];
        if (/^h[1-6]$/.test(e.localName)) {
          if (hits) break;
          continue;
        }
        if (e.localName !== 'p') continue;
        seen++;
        if (starts(e)) {
          hits += 1 + inner(e);
          gap = 0;
          first = e;
        } else if (refPiece(e)) {
          gap = 0;
          hits += inner(e);
        }
        else if (++gap > 3 || (seen > 6 && hits < seen * 0.4)) break;
      }
      if (first && hits >= 5) {
        refHead = doc.createElement('h2');
        refHead.textContent = 'References';
        first.before(refHead);
      }
    }
    let rebuilt = false;
    if (!container && refHead) {
      const level = +refHead.tagName[1];
      container = doc.createElement('div');
      container.className = 'refs';
      let n = refHead.nextElementSibling;
      const take = [];
      while (n && !(/^H[1-4]$/.test(n.tagName) && +n.tagName[1] <= level) && n.localName !== 'figure') {
        take.push(n);
        n = n.nextElementSibling;
      }
      // A short section printed mid-list (Acknowledgments, Author contributions)
      // interrupts it: when the numbering carries on just after, so does the list.
      const numOf = (e) => +(/^\[?(\d{1,3})[\].]?\s/.exec((e.textContent || '').trim()) || [])[1] || 0;
      for (let guard = 0; n && guard < 5; guard++) {
        const seen = new Set(take.flatMap((e) => [...(e.textContent || '').matchAll(/(?:^|\s)\[?(\d{1,3})[\].]?\s+\p{Lu}/gu)].map((m) => +m[1])));
        const last = Math.max(0, ...[...seen].filter((m) => seen.has(m - 1))); // end of the running sequence, not a stray number
        if (!last) break;
        let k = n;
        let skipped = 0;
        while (k && skipped < 40 && !(k.localName === 'p' && numOf(k) === last + 1)) {
          if (/^H[12]$/.test(k.tagName)) k = null; // a real new part of the paper
          else {
            k = k.nextElementSibling;
            skipped++;
          }
        }
        if (!k || skipped >= 40) break;
        const resumed = [];
        while (k && !/^H[1-4]$/.test(k.tagName) && k.localName !== 'figure') {
          resumed.push(k);
          k = k.nextElementSibling;
        }
        take.push(...resumed);
        n = k;
      }
      refHead.after(container);
      container.append(...take);
      // PDF-sourced lists arrive as paragraphs, sometimes several entries per
      // paragraph: split at "[12]" or "12 Surname X" / "12. Surname" starts.
      const out = [];
      for (const t of [...container.children].map((e) => e.textContent.trim()).filter(Boolean)) {
        out.push(
          ...t
            .split(/(?=\[\d{1,3}\]\s)|(?<=\s)(?=\d{1,3}\.?\s+(?:(?:van|von|de|der|den|da|di|du|dos|le|la|del|ten|ter|el|al)\s+)*[\p{Lu}][\p{L}'’-]+(?:\s[\p{Lu}][\p{L}'’-]+)?,?\s+(?:[\p{Lu}]{1,3}[,.\s]|[\p{Lu}]\.))/u)
            .map((x) => x.trim())
            .filter(Boolean)
        );
      }
      // Entries that don't start with a person ("13. European Society of …",
      // "21. R Core Team"): inside entry 12, "13. " followed by a capital
      // starts entry 13. (The numbering itself says where to split.)
      for (let i = 0; i < out.length; i++) {
        const m = /^\[?(\d{1,3})([\].])\s/.exec(out[i]);
        if (!m) continue;
        const next = +m[1] + 1;
        const mark = m[2] === ']' ? `[${next}] ` : `${next}. `;
        const at = out[i].indexOf(` ${mark}`, m[0].length);
        const head = out[i].slice(0, at).trim();
        const rest = out[i].slice(at + 1 + mark.length);
        // (a lowercase start only after a finished entry: "…47:457–463 16. govinfo: …")
        if (at > 20 && (/^[\p{Lu}\d"“]/u.test(rest) && /[.)\d]$|\/$/.test(head) || /^\p{Ll}/u.test(rest) && /\d$/.test(head))) {
          out.splice(i, 1, out[i].slice(0, at).trim(), out[i].slice(at + 1).trim());
        }
      }
      // Unnumbered lists: entries run together after a full stop, starting
      // "Surname AB, Surname CD" or "Surname AB. 1999"
      if (out.filter((t) => /^\[?\d{1,3}[\].]?\s/.test(t)).length < Math.max(3, out.length * 0.2)) {
        const AUTHOR_START = /(?<=[\p{L}\d)]\.\s)(?=[\p{Lu}][\p{L}'’-]+(?:[ -][\p{Lu}][\p{L}'’-]+)?\s[\p{Lu}]{1,3}(?:,\s[\p{Lu}][\p{L}'’-]+(?:[ -][\p{Lu}][\p{L}'’-]+)?\s[\p{Lu}]{1,3}[,.]|\.\s(?:1[89]|20)\d\d))/u;
        // social-science style: "Surname, First[, First Surname][ and First Surname]. 1998."
        const NAMED_START = /(?<=\s)(?=[\p{Lu}][\p{L}'’-]+,\s[\p{Lu}][\p{L}'’-]+(?:\s[\p{Lu}]\.)*(?:,\s[\p{Lu}][\p{L}'’.\s-]{1,40}?)*(?:,?\s(?:and|&)\s[\p{Lu}][\p{L}'’.\s-]{1,40}?)?\.\s(?:1[89]|20)\d\d[a-z]?\.)/u;
        // APA: "Grice, H. P. (1975). Logic and …" (not inside an author list: "…, & Hope, K. (2004).")
        const APA_START = /(?<![,&]\s|\band\s)(?<=\S\s)(?=[\p{Lu}][\p{L}'’-]+(?:[ -][\p{Lu}][\p{L}'’-]+)?,\s[\p{Lu}]\.[^()]{0,160}?\((?:1[89]|20)\d\d[a-z]?\)\.)/u;
        // "Alberts SC, Altmann J. 2012." is an entry start even where the entry
        // before lost its last line (no full stop to split after)
        const VANCOUVER_START = /(?<![,&]\s|\band\s)(?<=[.)\]\d]\s)(?=(?:[\p{Lu}][\p{L}'’-]+(?:[ -][\p{Lu}][\p{L}'’-]+)?\s[\p{Lu}]{1,3},\s)*[\p{Lu}][\p{L}'’-]+(?:[ -][\p{Lu}][\p{L}'’-]+)?\s[\p{Lu}]{1,3}\.\s(?:1[89]|20)\d\d[a-z]?\.\s)/u;
        out.splice(0, out.length, ...out.flatMap((t) => t.split(AUTHOR_START).flatMap((x) => x.split(NAMED_START)).flatMap((x) => x.split(APA_START)).flatMap((x) => x.split(VANCOUVER_START)).map((x) => x.trim()).filter(Boolean)));
      }
      // one paragraph per printed line: fold lines that don't start an
      // entry into the entry above (when the list is numbered at all)
      const isStart = (t) => /^\[?\d{1,3}[\].]?\s/.test(t);
      // an entry that ran on into the next one ("… Jan 10. 3. Canada: …"):
      // split where the next number in sequence starts
      const splitRunOns = () => {
        if (out.filter(isStart).length < 3) return;
        const split = [];
        for (let t of out) {
          for (;;) {
            const m = /^\[?(\d{1,3})[\].]?\s/.exec(t);
            if (!m) break;
            const next = +m[1] + 1;
            // ("8." or "[8]"; or a bare "8" before a name with initials, as BMJ numbers them: "…bmj.l5358 8 Damen JAAG, …")
            const at = new RegExp(`(?<=[.)]\\s)\\[?${next}[\\].]\\s+(?=[\\p{Lu}])|(?<=[.)\\d]\\s)${next}\\s+(?=(?:(?:van|von|de|der|den|del|di|da|du|le|la|ten|ter)\\s+)*[\\p{Lu}][\\p{L}'’-]+(?:[ -][\\p{Lu}][\\p{L}'’-]+)?\\s[\\p{Lu}](?:-?[\\p{Lu}]){0,3}(?:Jr|Sr)?[,.\\s])`, 'u').exec(t);
            if (!at) break;
            split.push(t.slice(0, at.index).trim());
            t = t.slice(at.index);
          }
          split.push(t);
        }
        out.splice(0, out.length, ...split);
      };
      splitRunOns();
      if (out.filter(isStart).length >= Math.max(3, out.length * 0.2)) {
        const merged = [];
        // "3Department of …": an affiliation (marker glued to the word) from a side column
        for (const t of out.filter((x) => !/^\d{1,2}\p{Lu}\p{Ll}+/u.test(x))) {
          if (isStart(t) || !merged.length) merged.push([t]);
          else merged.at(-1).push(t);
        }
        out.splice(0, out.length, ...merged.map((lines) => joinWrapped(lines)));
        // (and again once lines are joined: "…doi:10.1136/bmj.l5358 8 Damen JAAG, …"
        // sat inside a line that didn't start an entry)
        splitRunOns();
      } else {
        // author–year lists: an entry starts "Surname, …" or "Surname AB"; other lines continue the one above
        const startsEntry = (t) => /^[\p{Lu}][\p{L}'’-]+(?:[ -][\p{Lu}][\p{L}'’-]+)?(?:,\s|\s[\p{Lu}]{1,3}[,.\s])/u.test(t);
        if (out.filter(startsEntry).length >= Math.max(3, out.length * 0.5)) {
          const merged = [];
          for (const t of out) {
            // (a wrapped author list continues after a comma, however the line starts)
            if ((startsEntry(t) && !(merged.length && /,$/.test(merged.at(-1).at(-1).trim()))) || !merged.length) merged.push([t]);
            else merged.at(-1).push(t);
          }
          out.splice(0, out.length, ...merged.map((lines) => joinWrapped(lines)));
        }
      }
      container.replaceChildren(
        ...out.map((t, i) => {
          const p = doc.createElement('p');
          p.className = 'ref-entry';
          const m = /^\[?(\d{1,3})[\].]?\s/.exec(t);
          p.id = m ? `ref-${m[1]}` : `ref-x${i + 1}`;
          p.textContent = t;
          return p;
        })
      );
      rebuilt = true;
    }
    const byNumber = new Map();
    const entries = [];
    if (container) {
      const items = container.matches('.ltx_bibliography') ? [...container.querySelectorAll('li')] : [...container.children];
      items.forEach((e, i) => {
        if (!e.id) e.id = `ref-x${i + 1}`;
        const t = e.textContent.trim();
        const m = /^\[?(\d{1,3})[\].]?\s/.exec(t);
        const num = m ? +m[1] : container.matches('ol') ? i + 1 : null;
        if (num && !byNumber.has(num)) byNumber.set(num, e.id);
        const year = (/\b(1[89]\d\d|20\d\d)[a-z]?\b/.exec(t) || [])[0];
        // the surname's last word: "De Filippo C" is cited as "De Filippo" or "Filippo"
        const sur = (/^(?:\[?\d+[\].]?\s+)?((?:[\p{L}'’-]+\s){0,3}?[\p{Lu}][\p{L}'’-]+)(?:,|\s[\p{Lu}]{1,3}[,.\s])/u.exec(t) || [])[1];
        const first = sur ? sur.split(/\s+/).pop() : (/^(?:\[?\d+[\].]?\s+)?([\p{Lu}][\p{L}'’-]+)/u.exec(t) || [])[1];
        entries.push({ id: e.id, year, first: first && surnameKey(first), text: surnameKey(t.slice(0, 300)) });
      });
    }
    // sources that already link their citations (arXiv HTML, PMC xrefs)
    const refIds = new Set(entries.map((e) => e.id));
    const alreadyLinked = [...root.querySelectorAll('a[href^="#"]')].some((a) => refIds.has(a.getAttribute('href').slice(1)));

    // ---- numbered citations: [3], [3, 5–7], and superscript ³ / ⁵,⁶
    if (byNumber.size && !alreadyLinked) {
      const linkNums = (inner, doc) => {
        const out = [];
        let last = 0;
        for (const m of inner.matchAll(/\d{1,3}/g)) {
          if (!byNumber.has(+m[0])) continue;
          out.push(inner.slice(last, m.index), anchor(doc, byNumber.get(+m[0]), m[0]));
          last = m.index + m[0].length;
        }
        if (!out.length) return null;
        out.push(inner.slice(last));
        return out;
      };
      const numbered = links; // (before the bracket and superscript citations)
      links += replaceInText(root, /\[(\d{1,3}(?:\s*[-–,;]\s*\d{1,3})*)\]/, (m, doc) => {
        const inner = linkNums(m[1], doc);
        return inner && ['[', ...inner, ']'];
      });
      // superscripts in the title/author block are affiliations, not citations
      const supLinked = [];
      const heads = [...root.querySelectorAll('h2, h3, h4')].filter((h) => !h.closest('header'));
      // (only where the article starts: a "Background" late in the paper, an
      // example's own sections, isn't it, or nothing before it would link)
      const blocks = [...root.querySelectorAll('h1, h2, h3, h4, p, li')];
      const early = (h) => blocks.indexOf(h) <= blocks.length * 0.25;
      const named = heads.find((h) => /^\s*(\d+\.?\s*)?(abstract|summary|introduction|background|methods?|rationale|objectives?)\b/i.test(h.textContent) && early(h));
      // (or the first paragraph of running text, when it comes before any such
      // heading: an article that opens without one, its first section untitled)
      // (running text is mostly lowercase words; an author list, "Xingdong
      // Chen1,2, Jeffrey Gole4, …", is mostly names)
      const prose = (b) => {
        const ws = b.textContent.trim().split(/\s+/);
        return ws.length >= 40 && ws.filter((w) => /^\p{Ll}/u.test(w)).length >= ws.length * 0.5;
      };
      const firstProse = blocks.find((b) => b.localName === 'p' && !b.closest('.refs, figure, table') && prose(b));
      const cand = [named || heads[0], firstProse].filter(Boolean);
      const bodyStart = cand.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0];
      // A citation broken over two lines comes as two superscripts, "20 21 24-"
      // and "32": one again
      for (const sup of [...root.querySelectorAll('sup')]) {
        if (!sup.parentNode || !/[-\u2010-\u2015\u2212]\s*$/.test(sup.textContent)) continue; // (any hyphen or dash: BMJ sets U+2011)
        let n = sup.nextSibling;
        while (n && n.nodeType === 3 && !n.data.trim()) n = n.nextSibling;
        // (or its end came out as plain text: "24-" then " 26 and …")
        const plain = sup.nextSibling && sup.nextSibling.nodeType === 3 ? /^\s?(\d{1,3})(?!\d)/.exec(sup.nextSibling.data) : null;
        if (plain && !(n && n.nodeType === 1 && n.localName === 'sup')) {
          sup.textContent = sup.textContent.trimEnd() + plain[1];
          sup.nextSibling.data = sup.nextSibling.data.slice(plain[0].length);
          continue;
        }
        if (n && n.nodeType === 1 && n.localName === 'sup' && /^\s*\d/.test(n.textContent)) {
          sup.textContent = sup.textContent.trimEnd() + n.textContent.trim();
          for (let k = sup.nextSibling; k && k !== n; ) {
            const nx = k.nextSibling;
            k.remove();
            k = nx;
          }
          n.remove();
        }
      }
      const maxRef = Math.max(0, ...byNumber.keys());
      for (const sup of root.querySelectorAll('sup')) {
        if (sup.closest('a, .refs, h1, h2, h3, h4, math')) continue;
        if (bodyStart && sup.compareDocumentPosition(bodyStart) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
        let t = sup.textContent.trim();
        // two numbers that lost the space between them, "5455": 54 and 55
        if (/^\d{3,4}$/.test(t) && +t > maxRef) {
          for (let k = 1; k < t.length; k++) {
            const [a, b] = [+t.slice(0, k), +t.slice(k)];
            if (t[k] !== '0' && a >= 1 && b > a && b - a <= 9 && byNumber.has(a) && byNumber.has(b)) {
              t = `${a} ${b}`;
              break;
            }
          }
        }
        if (!/^\d{1,3}(?:\s*[-\u2010-\u2015\u2212,]\s*\d{1,3})*$/.test(t) && !/^\d{1,3}(?:\s+\d{1,3})+$/.test(t) && !/^\d{1,3}(?:[\s,]+\d{1,3})*(?:\s*[-\u2010-\u2015\u2212]\s*\d{1,3})(?:[\s,]+\d{1,3})*$/.test(t)) continue;
        const prevText = sup.previousSibling && sup.previousSibling.nodeType === 3 ? sup.previousSibling.data : '';
        // 10⁶ or 2×10³ is a power, not a citation ("(part 2¹⁰" is one)
        if (/(?:^|[^\d.])10\s*$|[×x]\s*\d+\s*$|\d\s*\^\s*$/.test(prevText)) continue;
        // (glued to the word after it, "²Institute of …", it marks an affiliation:
        // a citation is followed by a space or punctuation)
        const nextText = sup.nextSibling && sup.nextSibling.nodeType === 3 ? sup.nextSibling.data : '';
        if (/^\p{L}/u.test(nextText)) continue;
        // (one opening a paragraph marks an affiliation, "¹ Centre for …", never a citation)
        const block = sup.closest('p, li');
        // (and so do those in a list of affiliations: "…Shanghai, China. ² Taizhou
        // Institute of Health Sciences, …", mostly capitalised names and places)
        if (block) {
          const ws = block.textContent.trim().split(/\s+/);
          if (ws.length >= 8 && ws.filter((w) => /^\p{Ll}/u.test(w)).length < ws.length * 0.3) continue;
        }
        if (block) {
          const r = doc.createRange();
          r.setStart(block, 0);
          r.setEndBefore(sup);
          if (!r.toString().trim()) continue;
        }
        const inner = linkNums(t, doc);
        if (!inner) continue;
        sup.replaceChildren(...inner);
        supLinked.push(sup);
        links++;
      }
      // journals that cite in parentheses, "(2)", "(5, 6)", "(3–5)": only when
      // the paper doesn't cite in brackets or superscripts, and not after a
      // word that makes it something else ("Eq. (2)", "Table (1)", "n = (3)")
      if (links - numbered < 3) {
        const inParens = links;
        const max = Math.max(...byNumber.keys());
        links += replaceInText(root, /\((\d{1,3}(?:\s*[-–,]\s*\d{1,3})*)\)/, (m, doc) => {
          const before = m.input.slice(Math.max(0, m.index - 14), m.index);
          // (as a word: "acceptable (2–4)" doesn't end in "Table")
          if (/\b(?:Eqs?\.?|Equations?|Figs?\.?|Figures?|Tables?|Steps?|Items?|Panels?|Models?)\s*$/i.test(before) || /[=<>±×]\s*$/.test(before) || /\w$/.test(before)) return null;
          const nums = m[1].match(/\d+/g).map(Number);
          if (nums.some((n) => n < 1 || n > max)) return null;
          const inner = linkNums(m[1], doc);
          return inner && ['(', ...inner, ')'];
        });
        // (the paper cites in parentheses: its one or two superscript numbers
        // are units, "10,000/mm³", not citations)
        if (links - inParens >= 5 && supLinked.length <= 2) {
          for (const sup of supLinked) sup.textContent = sup.textContent;
          links -= supLinked.length;
        }
      }
    }
    // ---- author–year citations: (Amodei, 2024; VandeHei & Allen, 2025)
    if (entries.length && byNumber.size < entries.length / 2 && !alreadyLinked) {
      // first author + year; a second author picks between namesakes; with
      // the year lost from a damaged entry, the only entry by that author
      const find = (name, year, second) => {
        const byName = entries.filter((e) => e.first === surnameKey(name));
        const withSecond = (list) => (second && list.filter((e) => e.text.includes(surnameKey(second))).length ? list.filter((e) => e.text.includes(surnameKey(second))) : list);
        const dated = withSecond(byName.filter((e) => e.year && e.year.slice(0, 4) === year.slice(0, 4)));
        if (dated.length) return dated[0];
        const undated = withSecond(byName.filter((e) => !e.year));
        return undated.length === 1 ? undated[0] : null;
      };
      // (a group can hold more than citations: "(mean ± SD …; Smith et al., 2012; Figure 1)")
      links += replaceInText(root, /\(([^()]{0,400}?\b(?:1[89]|20)\d\d[a-z]?\b[^()]{0,300})\)/u, (m, doc) => {
        const out = ['('];
        let any = false;
        for (const [i, seg] of m[1].split(/;\s*/).entries()) {
          if (i) out.push('; ');
          // the first surname leads, however many follow: "Stainback, Tomaskovic-Devey, and Skaggs 2010"
          const lead = /^(\s*(?:see(?: also)?|e\.g\.,?|cf\.|for a review, see)?\s*)(([\p{Lu}][\p{L}'’-]+)(?:,? [^;()]{0,80}?)?,?\s+((?:1[89]|20)\d\d[a-z]?))/u.exec(seg);
          const second = lead && (/(?:,|\band|&)\s+([\p{Lu}][\p{L}'’-]+)/u.exec(lead[2].slice(lead[3].length)) || [])[1];
          const leadHit = lead && find(lead[3], lead[4], second);
          if (leadHit) {
            out.push(seg.slice(0, lead[1].length), anchor(doc, leadHit.id, lead[2]), seg.slice(lead[0].length));
            any = true;
            continue;
          }
          const c = /([\p{Lu}][\p{L}'’-]+)(?:\s+(?:et al\.?|(?:and|&)\s*([\p{Lu}][\p{L}'’-]+)))?,?\s+((?:1[89]|20)\d\d[a-z]?)/u.exec(seg);
          const hit = c && find(c[1], c[3], c[2]);
          if (hit) {
            out.push(seg.slice(0, c.index), anchor(doc, hit.id, c[0]), seg.slice(c.index + c[0].length));
            any = true;
          } else out.push(seg);
        }
        out.push(')');
        return any ? out : null;
      });
      // in a sentence: "Smith et al. (2019)", "Roux & Fitzgibbon (2010)"
      links += replaceInText(root, /([\p{Lu}][\p{L}'’-]+)(?:\s+(?:et al\.?|(?:and|&)\s+([\p{Lu}][\p{L}'’-]+)))?\s+\(((?:1[89]|20)\d\d[a-z]?)(?::\s?[\d–-]+)?\)/u, (m, doc) => {
        const hit = find(m[1], m[3], m[2]);
        return hit ? [anchor(doc, hit.id, m[0])] : null;
      });
    }
    // ---- figure / table mentions → the figure
    const figs = new Map();
    root.querySelectorAll('figure').forEach((f) => {
      const m = /^\s*(Figs?\.?|Figures?|FIGURE|Tables?|TABLE)\s*(\d+)/i.exec((f.querySelector('figcaption') || f).textContent);
      if (!m) return;
      const key = `${kindOf(m[1])}-${m[2]}`;
      if (!f.id) f.id = key;
      if (!figs.has(key)) figs.set(key, f.id);
    });
    if (figs.size)
      links += replaceInText(
        root,
        /\b(Figs?\.?|Figures?|Tables?|Tabs?\.)\s*(\d+)([A-Za-z]?)/,
        (m, doc) => {
          const id = figs.get(`${kindOf(m[1])}-${m[2]}`);
          return id ? [anchor(doc, id, m[0])] : null;
        },
        'a, h1, h2, h3, h4, h5, h6, .refs, figcaption, script, style, math'
      );
    // ---- "Section 3.1" → the heading numbered 3.1
    const secs = new Map();
    root.querySelectorAll('h2, h3, h4').forEach((h) => {
      const m = /^\s*((?:\d+\.)*\d+)\.?\s+\S/.exec(h.textContent);
      if (!m) return;
      if (!h.id) h.id = `sec-${m[1].replace(/\./g, '-')}`;
      secs.set(m[1], h.id);
    });
    if (secs.size)
      links += replaceInText(root, /\b(Sections?|Sec\.|§)\s*((?:\d+\.)*\d+)/, (m, doc) => {
        const id = secs.get(m[2]);
        return id ? [anchor(doc, id, m[0])] : null;
      });
    if (links) log(`→ linked ${links} citation(s) and cross-reference(s)`);
  }

  // ================================================================ sources
  async function fromArxivHtml(arxivId, log) {
    log(`→ fetching arXiv HTML for ${arxivId}`);
    let res;
    try {
      res = await fetchT(`https://arxiv.org/html/${arxivId}`, {}, 45000);
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

  // PubMed Central full text as JATS XML. NCBI's E-utilities serves it for
  // open-access papers *and* author manuscripts (free to read, not openly
  // licensed), with permissive CORS; Europe PMC's API only covers the
  // open-access subset, so it's the fallback. Europe PMC also maps DOI → PMCID.
  async function fromPubmedCentral(doi, log) {
    log('→ looking for free full text in PubMed Central');
    const q = encodeURIComponent(`DOI:"${doi}"`);
    const s = await fetchT(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${q}&format=json&resultType=lite`).then((r) => r.json());
    const results = (s.resultList && s.resultList.result) || [];
    const hit = results.find((r) => r.pmcid && r.isOpenAccess === 'Y') || results.find((r) => r.pmcid);
    if (!hit) {
      log('  ! not in PubMed Central');
      return null;
    }
    const pmcid = hit.pmcid;
    const parse = async (res) => {
      if (!res.ok) return null;
      const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
      return xml.querySelector('parsererror') || !xml.querySelector('article body') ? null : xml;
    };
    let xml = null;
    let via = 'PubMed Central';
    try {
      xml = await parse(await fetchT(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${pmcid.replace(/^PMC/i, '')}&rettype=xml`, {}, 45000));
    } catch {}
    if (!xml) {
      log('  ! NCBI had no full text; trying Europe PMC');
      try {
        xml = await parse(await fetchT(`https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`, {}, 45000));
        via = 'Europe PMC';
      } catch {}
    }
    if (!xml) {
      log(`  ! ${pmcid} has no full text available to apps (the publisher may only allow reading it on the PMC website)`);
      return null;
    }
    const kind = hit.isOpenAccess === 'Y' ? 'open access' : 'author manuscript / free to read';
    log(`  using ${via} full text (${pmcid}, ${kind})`);
    const doc = document.implementation.createHTMLDocument('');
    const root = doc.createElement('div');
    const article = xml.querySelector('article');
    jatsToHtml(article, doc, root, `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/bin/`);
    const title = ws(article.querySelector('article-meta title-group article-title')?.textContent || '').trim();
    const authors = [...article.querySelectorAll('article-meta contrib[contrib-type="author"] name')].map((n) =>
      [n.querySelector('given-names')?.textContent, n.querySelector('surname')?.textContent].filter(Boolean).join(' ')
    );
    const url = `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`;
    return { doc, root, baseUrl: url, title, authors, sourceUrl: url, label: 'PubMed Central' };
  }

  function jatsToHtml(xml, doc, root, imageBase = null) {
    const xdoc = xml.ownerDocument || xml; // xml may be the <article> element
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
        else if (n === 'xref' && /^(fig|table|bibr|fn|sec)$/.test(c.getAttribute('ref-type') || '') && c.getAttribute('rid')) {
          const a = into.appendChild(doc.createElement('a'));
          a.setAttribute('href', '#' + c.getAttribute('rid').split(/\s+/)[0]);
          inline(c, a);
        }
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
    // Figures, tables and displayed maths sit inside a <p> in NCBI's XML
    // (<p>text <table-wrap>…</table-wrap> more text</p>): they are blocks of
    // their own, and the text around them stays text.
    const BLOCK_IN_P = new Set(['table-wrap', 'table-wrap-group', 'fig', 'fig-group', 'disp-formula', 'disp-quote', 'list', 'boxed-text']);
    const block = (node, depth, into) => {
      for (const c of node.children) {
        const n = c.localName;
        if (n === 'title') into.append(inline(c, doc.createElement(`h${Math.min(6, depth + 1)}`)));
        else if (n === 'sec' || n === 'ack' || n === 'app' || n === 'boxed-text') {
          // section ids, so "see Section 2" cross-references resolve
          const before = into.childElementCount;
          block(c, depth + 1, into);
          const h = into.children[before];
          if (h && /^H\d$/.test(h.tagName) && c.getAttribute('id')) h.setAttribute('id', c.getAttribute('id'));
        }
        else if (n === 'p' && [...c.children].some((k) => BLOCK_IN_P.has(k.localName))) {
          let run = [];
          const flush = () => {
            if (!run.length) return;
            const tmp = doc.createElement('div');
            tmp.append(...run.map((x) => x.cloneNode(true)));
            const para = inline(tmp, doc.createElement('p'));
            if (para.textContent.trim()) into.append(para);
            run = [];
          };
          for (const k of c.childNodes) {
            if (k.nodeType === 1 && BLOCK_IN_P.has(k.localName)) {
              flush();
              block({ children: [k] }, depth, into);
            } else run.push(k);
          }
          flush();
        }
        else if (n === 'p') into.append(inline(c, doc.createElement('p')));
        else if (n === 'list') {
          const ol = doc.createElement(c.getAttribute('list-type') === 'order' ? 'ol' : 'ul');
          for (const li of c.querySelectorAll(':scope > list-item')) block(li, depth, ol.appendChild(doc.createElement('li')));
          into.append(ol);
        } else if (n === 'fig') {
          const cap = el('figcaption', inline(c.querySelector('label') || doc.createElement('x'), el('strong')), ' ');
          const capNode = c.querySelector('caption');
          if (capNode) [...capNode.children].forEach((k) => cap.append(inline(k, el('span')), ' '));
          const fig = el('figure');
          if (c.getAttribute('id')) fig.setAttribute('id', c.getAttribute('id'));
          const g = c.querySelector('graphic');
          const href = g && (g.getAttribute('xlink:href') || g.getAttributeNS('http://www.w3.org/1999/xlink', 'href'));
          if (href && imageBase) {
            // dropped later if the host won't serve it to us
            const img = fig.appendChild(doc.createElement('img'));
            img.setAttribute('src', imageBase + href + (/\.[a-z]{3,4}$/i.test(href) ? '' : '.jpg'));
            img.setAttribute('alt', '');
          }
          fig.append(cap);
          into.append(fig);
        } else if (n === 'table-wrap') {
          const fig = el('figure');
          if (c.getAttribute('id')) fig.setAttribute('id', c.getAttribute('id'));
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
          const t = xdoc.createElementNS(null, 'title');
          t.textContent = 'Acknowledgements';
          sec.insertBefore(t, sec.firstChild);
        }
        const holder = xdoc.createElementNS(null, 'holder');
        holder.append(sec.cloneNode(true));
        block(holder, 0, root);
      }
      const refs = back.querySelectorAll('ref-list ref');
      if (refs.length) {
        root.append(el('h2', 'References'));
        const ol = root.appendChild(el('ol'));
        ol.className = 'refs';
        refs.forEach((r) => {
          const li = ol.appendChild(el('li', refText(r.querySelector('mixed-citation, element-citation, citation') || r)));
          if (r.getAttribute('id')) li.setAttribute('id', r.getAttribute('id'));
        });
      }
    }
    root.querySelectorAll('h1').forEach((h) => {
      const h2 = doc.createElement('h2');
      h2.append(...h.childNodes);
      h.replaceWith(h2);
    });
  }

  // A JATS reference as readable text. An <element-citation> is bare fields
  // (surname, title, source, year, DOI, PMID…) with nothing between them:
  // run together they read "NamenAMElyEW…Med20011636586410.1164/…" and the
  // DOI can't be found. Set it out as a citation; elsewhere just keep the
  // fields apart.
  function refText(c) {
    const kids = (n, name) => [...n.children].filter((k) => k.localName === name);
    const kid = (n, name) => kids(n, name)[0] || null;
    const txt = (n) => (n ? ws(n.textContent).trim() : '');
    if (c.localName === 'element-citation' || (c.localName === 'citation' && !/[.,;]\s/.test(c.textContent))) {
      const people = [];
      for (const g of [c, ...kids(c, 'person-group')]) {
        for (const n of kids(g, 'name')) {
          const sur = txt(kid(n, 'surname'));
          const given = txt(kid(n, 'given-names'));
          if (sur) people.push(given ? `${sur} ${given}` : sur);
        }
        for (const n of kids(g, 'collab')) people.push(txt(n));
        if (kid(g, 'etal')) people.push('et al.');
      }
      const id = (type) => txt(kids(c, 'pub-id').find((x) => x.getAttribute('pub-id-type') === type));
      const title = txt(kid(c, 'article-title')) || txt(kid(c, 'chapter-title'));
      const source = txt(kid(c, 'source'));
      const [year, vol, issue, fpage, lpage] = ['year', 'volume', 'issue', 'fpage', 'lpage'].map((k) => txt(kid(c, k)));
      let where = [source, year].filter(Boolean).join('. ');
      if (vol) where += `;${vol}`;
      if (issue) where += `(${issue})`;
      if (fpage) where += `:${fpage}${lpage ? '–' + lpage : ''}`;
      const doi = id('doi');
      const pmid = id('pmid');
      // what else it says, in order (publisher, edition, a comment, a web address)
      const USED = new Set(['person-group', 'name', 'collab', 'etal', 'pub-id', 'article-title', 'chapter-title', 'source', 'year', 'volume', 'issue', 'fpage', 'lpage', 'label', 'date', 'month', 'day', 'object-id']);
      const rest = [...c.children].filter((k) => !USED.has(k.localName)).map((k) => (k.localName === 'ext-link' || k.localName === 'uri' ? txt(k) || k.getAttribute('xlink:href') || '' : txt(k))).filter(Boolean);
      const pubLoc = txt(kid(c, 'publisher-loc'));
      const pubName = txt(kid(c, 'publisher-name'));
      const more = rest.filter((x) => x !== pubLoc && x !== pubName);
      const publisher = pubName ? (pubLoc ? `${pubLoc}: ${pubName}` : pubName) : '';
      const parts = [people.join(', '), title, publisher && !vol ? [source, publisher, year].filter(Boolean).join('. ') : where, ...more].filter(Boolean).map((x) => x.replace(/[.\s]+$/, ''));
      let out = parts.map((x) => x + (/[?!]$/.test(x) ? '' : '.')).join(' ');
      if (doi) out += ` doi:${doi}`;
      if (pmid) out += ` PMID: ${pmid}`;
      if (out.replace(/[.\s]/g, '')) return out.trim();
    }
    // mixed citations carry their own punctuation; only keep tags apart
    let out = '';
    const walk = (n) => {
      for (const k of n.childNodes) {
        if (k.nodeType === 3) out += k.data;
        else if (k.nodeType === 1) {
          if (out && /[\p{L}\d]$/u.test(out) && !/^(italic|bold|sub|sup|sc|underline|monospace|named-content)$/.test(k.localName)) out += ' ';
          walk(k);
          if (k.localName === 'pub-id' || k.localName === 'ext-link') out += ' ';
        }
      }
    };
    walk(c);
    return ws(out).replace(/\s+([,.;:)])/g, '$1').trim();
  }

  // ================================================================ web pages
  // A web page reaches us one of two ways: fetched directly (only sites that
  // allow cross-origin reads; most don't), or as a page the user saved in
  // their browser and shared in. Chrome on Android saves pages as MHTML
  // (⋮ → Download), which carries the images too.

  // MHTML (multipart/related): returns { html, url, resources: Map(url → Blob) }.
  function parseMhtml(text) {
    const head = text.slice(0, 4000);
    const bm = /boundary="?([^";\r\n]+)"?/i.exec(head);
    if (!bm) throw new Error('not an MHTML file');
    const url = (/^Snapshot-Content-Location:\s*(\S+)/im.exec(head) || [])[1] || '';
    const resources = new Map();
    let html = null;
    let htmlUrl = url;
    for (const part of text.split('--' + bm[1]).slice(1)) {
      const split = part.search(/\r?\n\r?\n/);
      if (split < 0) continue;
      const hdr = part.slice(0, split).replace(/\r?\n[ \t]+/g, ' ');
      const body = part.slice(split).replace(/^\r?\n\r?\n/, '');
      const h = (name) => ((new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(hdr) || [])[1] || '').trim();
      const type = h('Content-Type').split(';')[0].toLowerCase();
      const charset = (/charset="?([\w-]+)/i.exec(h('Content-Type')) || [])[1] || 'utf-8';
      const enc = h('Content-Transfer-Encoding').toLowerCase();
      const loc = h('Content-Location');
      let bytes;
      if (enc === 'base64') {
        const b = atob(body.replace(/\s+/g, ''));
        bytes = new Uint8Array(b.length);
        for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
      } else if (enc === 'quoted-printable') {
        const t = body.replace(/=\r?\n/g, '');
        const out = [];
        for (let i = 0; i < t.length; i++) {
          if (t[i] === '=' && /^[0-9A-F]{2}$/i.test(t.substr(i + 1, 2))) {
            out.push(parseInt(t.substr(i + 1, 2), 16));
            i += 2;
          } else {
            const c = t.charCodeAt(i);
            if (c < 128) out.push(c);
            else out.push(...new TextEncoder().encode(t[i]));
          }
        }
        bytes = new Uint8Array(out);
      } else bytes = new TextEncoder().encode(body);
      if (type === 'text/html' && html === null) {
        let dec;
        try {
          dec = new TextDecoder(charset);
        } catch {
          dec = new TextDecoder('utf-8');
        }
        html = dec.decode(bytes);
        htmlUrl = loc || url;
      } else if (loc && type.startsWith('image/')) resources.set(loc, new Blob([bytes], { type }));
    }
    if (html === null) throw new Error('no page found in the MHTML file');
    return { html, url: htmlUrl, resources };
  }

  // A saved-page file (MHTML or plain HTML) → { html, url, resources }.
  async function readPageFile(file) {
    const text = await file.text();
    if (/^\s*(From:|Snapshot-Content-Location:|MIME-Version:|Content-Type:\s*multipart\/related)/im.test(text.slice(0, 2000)) && /multipart\/related/i.test(text.slice(0, 4000))) return parseMhtml(text);
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const url = doc.querySelector('link[rel=canonical]')?.getAttribute('href') || metaContent(doc, 'og:url') || '';
    return { html: text, url, resources: new Map() };
  }

  async function fetchPage(url) {
    let res;
    try {
      res = await fetchT(url, { credentials: 'omit' }, 45000);
    } catch {
      throw new Error('this site doesn’t let apps read its pages');
    }
    if (!res.ok) throw new Error(`the site answered ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!/html|xml/i.test(type)) throw new Error('that link isn’t a web page');
    return { html: await res.text(), url: res.url || url, resources: new Map() };
  }

  // Details for the Add form.
  function pageMeta(page) {
    const doc = new DOMParser().parseFromString(page.html, 'text/html');
    const date = metaContent(doc, 'citation_publication_date', 'citation_date', 'article:published_time', 'dc.date', 'date', 'parsely-pub-date') || doc.querySelector('time[datetime]')?.getAttribute('datetime') || '';
    const year = (/\b(19|20)\d\d\b/.exec(date) || [])[0];
    const canon = doc.querySelector('link[rel=canonical]')?.getAttribute('href');
    let url = page.url || '';
    try {
      if (canon) url = new URL(canon, url || undefined).href;
    } catch {}
    let site = metaContent(doc, 'og:site_name', 'citation_journal_title', 'application-name');
    if (!site && url) try { site = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    // "Title - Site" / "Title | Site": drop the site part
    let title = getTitle(doc, '');
    const tail = /\s+[|\-–—]\s+([^|\-–—]{2,40})$/.exec(title);
    if (tail && site && (tail[1].toLowerCase().includes(site.toLowerCase().split('.')[0]) || site.toLowerCase().includes(tail[1].toLowerCase().trim()))) title = title.slice(0, tail.index);
    return {
      title,
      authors: getAuthors(doc).length ? getAuthors(doc) : [...doc.querySelectorAll('[rel=author], [itemprop=author] [itemprop=name], .byline .author, a[href*="/author/"]')].map((a) => ws(a.textContent).trim()).filter((t, i, all) => t && t.length < 60 && all.indexOf(t) === i).slice(0, 6),
      year: year ? Number(year) : null,
      venue: site || '',
      abstract: metaContent(doc, 'citation_abstract', 'description', 'og:description', 'twitter:description'),
      doi: (metaContent(doc, 'citation_doi', 'dc.identifier', 'prism.doi').match(/10\.\d{4,9}\/\S+/) || [])[0] || null,
      url,
    };
  }

  const ARTICLE_SELECTORS = ['[itemprop=articleBody]', 'div.c-article-body', 'div.article-body', 'div.article__body', 'div.post-content', 'div.entry-content', 'div.available-content', 'div.body.markup', 'article', 'main', '[role=main]'];
  const JUNK = '.mw-editsection,.printfooter,#catlinks,.navbox,.mw-jump-link,[class*=share],[class*=social],[class*=comment],[class*=related],[class*=newsletter],[class*=subscribe],[class*=promo],[class*=paywall],[class*=recommend],[id*=comment],[class*=breadcrumb]';
  // Elements an EPUB can hold; anything else (custom elements, video, inputs) is unwrapped or dropped.
  const KEEP_TAGS = new Set('a abbr b bdi bdo blockquote br caption cite code col colgroup dd del dfn div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp section small span strong sub sup table tbody td tfoot th thead time tr u ul var wbr math'.split(' '));
  const DROP_TAGS = 'video,audio,canvas,template,dialog,input,select,textarea,label,object,embed,source,track,map,area,picture > source';

  // The element holding the article's prose: a known container if it has real
  // text, else the tightest element holding most of the page's paragraph text.
  function articleNode(doc) {
    for (const sel of ARTICLE_SELECTORS) {
      const cands = [...doc.querySelectorAll(sel)].filter((el) => ws(el.textContent).length >= 400);
      if (cands.length) return cands.sort((a, b) => ws(b.textContent).length - ws(a.textContent).length)[0];
    }
    const score = new Map();
    for (const p of doc.querySelectorAll('p')) {
      const n = ws(p.textContent).trim().length;
      if (n < 40) continue;
      for (let el = p.parentElement; el && el !== doc.documentElement; el = el.parentElement) score.set(el, (score.get(el) || 0) + n);
    }
    const best = Math.max(0, ...score.values());
    if (best < 800) return doc.body;
    let pick = null;
    for (const [el, sc] of score) if (sc >= best * 0.85 && (!pick || ws(el.textContent).length < ws(pick.textContent).length)) pick = el;
    return pick;
  }

  // Maths a page drew with MathJax: keep its MathML, drop the drawing. The
  // drawing is SVG or styled spans (removed as noise, or left as junk), and
  // the MathML sits beside it: in a script (MathJax 2), a data-mathml
  // attribute, or a hidden copy for screen readers (MathJax 2 and 3).
  const MML_NS = 'http://www.w3.org/1998/Math/MathML';
  function liftMathJax(doc) {
    const parse = (src) => {
      const x = new DOMParser().parseFromString(src.replace(/^\s*<math\b(?![^>]*xmlns=)/, `<math xmlns="${MML_NS}"`), 'application/xml');
      const m = x.documentElement;
      return m && m.localName === 'math' && !x.querySelector('parsererror') ? doc.importNode(m, true) : null;
    };
    const asBlock = (m, block) => {
      if (m && block) m.setAttribute('display', 'block');
      return m;
    };
    // the hidden copy, or the data-mathml attribute, of a drawing
    const mathOf = (frame) => {
      const hidden = frame.querySelector('.MJX_Assistive_MathML math, mjx-assistive-mml math');
      if (hidden) return doc.importNode(hidden, true);
      const attr = frame.getAttribute('data-mathml');
      return attr ? parse(attr) : null;
    };
    const DRAWN = '.MathJax_SVG, .MathJax_CHTML, .MathJax, mjx-container';
    for (const frame of [...doc.querySelectorAll(DRAWN)]) {
      if (!frame.isConnected || frame.parentElement?.closest(DRAWN)) continue;
      const block = !!frame.closest('.MathJax_SVG_Display, .MathJax_Display, .MathJax_CHTML_Display') || frame.getAttribute('display') === 'true' || frame.classList.contains('MJXc-display');
      // MathJax 2 keeps the source in <script id="MathJax-Element-N"> next to "…-Frame"
      const id = (frame.id || '').replace(/-Frame$/, '');
      const script = id && id !== frame.id ? doc.getElementById(id) : null;
      const m = mathOf(frame) || (script && /math\/mml/.test(script.type) ? parse(script.textContent) : null);
      if (!m) continue;
      const holder = frame.closest('.MathJax_SVG_Display, .MathJax_Display, .MathJax_CHTML_Display') || frame;
      holder.replaceWith(asBlock(m, block));
      if (script) script.remove();
    }
    // MathML left only as a script (the page saved before MathJax drew it)
    for (const sc of [...doc.querySelectorAll('script[type^="math/mml"]')]) {
      const m = parse(sc.textContent);
      if (m) sc.replaceWith(asBlock(m, /mode=display/.test(sc.type) || m.getAttribute('display') === 'block'));
    }
    doc.querySelectorAll('.MathJax_Preview, .MJX_Assistive_MathML, mjx-assistive-mml').forEach((el) => el.remove());
    // block maths sits in a paragraph of its own
    for (const m of doc.getElementsByTagNameNS(MML_NS, 'math')) {
      const box = m.parentElement;
      if (m.getAttribute('display') === 'block' && box && ws(box.textContent).length - ws(m.textContent).length < 12) box.classList.add('equation');
    }
  }

  function fromWebPage(page, log) {
    const doc = new DOMParser().parseFromString(page.html, 'text/html');
    const meta = pageMeta(page);
    const baseUrl = page.url || meta.url || location.href; // where the page actually was: relative image links resolve against it
    liftMathJax(doc);
    denoise(doc.body);
    doc.querySelectorAll(STRIP).forEach((el) => el.remove());
    const root = articleNode(doc);
    // saved pages: point images at the copies inside the file
    if (page.resources && page.resources.size) {
      for (const img of root.querySelectorAll('img')) {
        const sets = [img.getAttribute('srcset'), ...[...(img.closest('picture')?.querySelectorAll('source[srcset]') || [])].map((x) => x.getAttribute('srcset'))];
        // Chrome's saved pages keep only the src, but store whichever candidate it loaded
        const cands = [img.getAttribute('src'), img.getAttribute('data-src'), ...sets.flatMap((v) => (v || '').split(',').map((x) => x.trim().split(/\s+/)[0]))].filter(Boolean);
        for (const c of cands) {
          let abs;
          try {
            abs = new URL(c, baseUrl).href;
          } catch {
            continue;
          }
          const blob = page.resources.get(abs) || page.resources.get(c);
          if (blob) {
            img.setAttribute('src', URL.createObjectURL(blob));
            for (const a of ['srcset', 'data-srcset', 'data-src']) img.removeAttribute(a);
            break;
          }
        }
      }
    }
    const total = ws(root.textContent).length;
    root.querySelectorAll(JUNK).forEach((el) => {
      if (el.isConnected && ws(el.textContent).length < total * 0.25) el.remove();
    });
    root.querySelectorAll(DROP_TAGS).forEach((el) => el.remove());
    for (const el of [...root.querySelectorAll('*')].reverse()) {
      const tag = el.localName;
      if (!KEEP_TAGS.has(tag) && !el.parentElement?.closest('math')) el.replaceWith(...el.childNodes);
    }
    log(`  web page: ${meta.venue || baseUrl}`);
    return { doc, root, baseUrl, title: meta.title || 'Web page', authors: meta.authors, sourceUrl: meta.url || page.url || '', label: 'Web page' };
  }

  // The pictures of a stored PDF, by figure: { 'figure-3': blob, 'table-1': blob }
  async function pdfFigureImages(pdf, log) {
    const pdfSrc = await fromPdf(pdf.blob, pdf.name, log);
    const byKey = new Map();
    for (const img of pdfSrc.root.querySelectorAll('img[data-fig]')) {
      const m = /^pdfimg:(\d+)$/.exec(img.getAttribute('src') || '');
      if (m && pdfSrc.images[+m[1]]) byKey.set(img.getAttribute('data-fig'), pdfSrc.images[+m[1]]);
    }
    return byKey;
  }

  // A figure in the text with no picture gets the PDF's picture of the same
  // number, when the PDF has one. (Only pictures move: the text is untouched.)
  async function fillFiguresFromPdf(src, pdf, log) {
    const bare = [...src.root.querySelectorAll('figure')].filter((f) => !f.querySelector('img, object[data]'));
    if (!bare.length) return 0;
    const byKey = await pdfFigureImages(pdf, log).catch((err) => (log('  ! ' + err.message), new Map()));
    const doc = src.root.ownerDocument;
    const old = src.pdfImages || [];
    const extra = [];
    for (const f of bare) {
      const cap = f.querySelector('figcaption') || f;
      const m = /^\s*(Fig(?:ure)?s?\.?|Table)\s*(\d{1,2})\b/i.exec(cap.textContent);
      const blob = m && byKey.get(captionKey(m));
      if (!blob) continue;
      const img = doc.createElement('img');
      // numbered after the pictures the text already has
      img.setAttribute('src', `pdfimg:${old.length + extra.length}`);
      img.setAttribute('alt', '');
      extra.push(blob);
      f.insertBefore(img, f.firstChild);
    }
    if (extra.length) {
      src.pdfImages = [...old, ...extra];
      log(`  ${extra.length} figure picture(s) taken from the stored PDF; the text is the ${src.label} text`);
    } else log(`  the stored PDF has no picture for ${bare.length} figure(s): captions only`);
    return extra.length;
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
table{border-collapse:collapse;font-size:.85em;max-width:100%;}
td,th{overflow-wrap:break-word;}
td,th{border:1px solid #9995;padding:.2em .4em;}
.equation,.ltx_equation{display:block;overflow-x:auto;}
.equation.numbered{display:flex;align-items:center;justify-content:space-between;gap:0.6em;}
.equation img{min-width:0;max-width:100%;}
.eqno{flex:none;}
.ltx_tag_equation{float:right;}
.ltx_bibitem{font-size:.9em;}
small{font-size:.85em;}
blockquote{margin:.8em 0 .8em 1.4em;padding-left:.8em;border-left:2px solid #8885;font-size:.95em;}
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
  async function make(paper, { source = 'auto', pdf = null, page = null, log = () => {} } = {}) {
    const warnings = [];
    let src = null;
    const tryArxiv = (source === 'auto' || source === 'arxiv') && paper.arxiv;
    const tryPmc = (source === 'auto' || source === 'pmc') && paper.doi && !/^10\.48550\//i.test(paper.doi);
    if (tryArxiv) src = await fromArxivHtml(paper.arxiv, log).catch((e) => (log('  ! ' + e.message), null));
    if (!src && tryPmc) src = await fromPubmedCentral(paper.doi, log).catch((e) => (log('  ! ' + e.message), null));
    if (!src && page) src = fromWebPage(page, log);
    const tryWeb = (source === 'web' || (source === 'auto' && !paper.doi && !paper.arxiv && !pdf)) && paper.url && !/\.pdf([?#]|$)/i.test(paper.url);
    if (!src && tryWeb) {
      log(`→ fetching ${paper.url}`);
      try {
        src = fromWebPage(await fetchPage(paper.url), log);
      } catch (err) {
        log('  ! ' + err.message);
        if (source === 'web' || !paper.doi) throw new Error(`Couldn’t read the page: ${err.message}. Save it in your browser (Chrome: ⋮ → Download) and share the saved file to PaperReads.`);
      }
    }
    if (!src && (source === 'auto' || source === 'pdf') && pdf) {
      src = await fromPdf(pdf.blob, pdf.name, log);
      if (src.twoCol) log('  set in columns: the text is put in reading order, tables and figures kept as pictures');
    }
    if (!src) throw new Error(pdf || source !== 'auto' ? 'No usable source found for this paper.' : 'No HTML version found. Attach the PDF first, then convert from it.');

    const title = paper.title || src.title;
    const authors = paper.authors && paper.authors.length ? paper.authors : src.authors;
    log(`→ title: ${title}`);
    const words = ws(src.root.textContent).trim().split(' ').length;
    log(`→ extracted ~${words} words`);
    if (words < 120) warnings.push('Very little text was extracted.');

    if (src.label === 'PDF') groupPdfFigures(src.root);
    placeFigures(src.root, log);
    linkify(src.root, log);
    // Text sources whose figure images are off-limits to apps (PubMed Central,
    // Europe PMC): the text stays as it is, and the stored PDF supplies the
    // pictures of the figures it left bare, matched by figure number.
    if (src.label !== 'PDF' && src.label !== 'arXiv HTML' && pdf && (source === 'auto' || source === 'pdf')) {
      await fillFiguresFromPdf(src, pdf, log);
    }
    const wanted = src.root.querySelectorAll('img, object[data]').length;
    const media = await localizeImages(src.root, src.baseUrl, src.pdfImages || [], log);
    let missingFigures = src.root.querySelectorAll('figure').length && src.label !== 'PDF' ? Math.max(0, wanted - media.length) : 0;
    // a text source that left the figures out entirely (some manuscripts in
    // PubMed Central) while the text refers to them: count those as missing
    if (!missingFigures && src.label !== 'PDF' && src.label !== 'arXiv HTML' && !src.root.querySelector('figure, img')) {
      const nums = new Set([...src.root.textContent.matchAll(/\b(?:Fig(?:ure)?s?\.?)\s*(\d{1,2})\b/gi)].map((m) => m[1]));
      missingFigures = nums.size;
    }
    if (missingFigures) log(`  ! ${missingFigures} figure(s) will show their caption only`);
    absolutizeLinks(src.root, src.baseUrl);
    cleanFragment(src.root, title);
    log('→ generating cover');
    const cover = await makeCover(title, authors[0] || '');
    log('→ packaging EPUB');
    const blob = await buildEpub({ title, authors, sourceUrl: src.sourceUrl, root: src.root, media, cover, id: paper.doi ? `doi:${paper.doi}` : `urn:paperreads:${paper.id}` });
    const file = new File([blob], safeName(title) + '.epub', { type: 'application/epub+zip' });
    log(`✓ ${file.name} (${Math.round(file.size / 1024)} KB)`);
    return { file, cover, source: src.label, warnings, missingFigures, twoCol: !!src.twoCol, images: media.length };
  }

  // Which sources could work for this paper, for the UI.
  function sources(paper, hasPdf) {
    const out = [];
    if (paper.arxiv) out.push(['arxiv', 'arXiv HTML']);
    if (paper.doi && !/^10\.48550\//i.test(paper.doi)) out.push(['pmc', 'PubMed Central (free full text)']);
    if (hasPdf) out.push(['pdf', 'Stored PDF']);
    if (paper.url && !/\.pdf([?#]|$)/i.test(paper.url) && !paper.arxiv) out.push(['web', 'Web page (from its link)']);
    return out;
  }

  return { make, sources, makeCover, epubjs, jszip, pdfjs, pdfToHtml, readPageFile, fetchPage, pageMeta };
})();

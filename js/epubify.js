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
    return out.replace(/<(sup|sub)>\s*<\/\1>/g, '');
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
            fonts[id] = { name: f.name || '', bold: !!f.bold, asc: f.ascent || 0.8, desc: f.descent || -0.2, remap: piGlyphs(f.differences) };
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
        // corners along the baseline direction and the "up" direction, so
        // sideways text (rotated tables) gets a true bounding box as well
        const ulen = Math.hypot(tx[2], tx[3]) || 1;
        const up = [tx[2] / ulen, tx[3] / ulen];
        const corners = [0, it.width].flatMap((a) => [f.asc, f.desc].map((h) => [x0 + dir[0] * a + up[0] * h * size, yb + dir[1] * a + up[1] * h * size]));
        const span = {
          text: f.remap ? [...it.str].map((ch) => f.remap[ch.codePointAt(0)] ?? ch).join('') : it.str,
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
      const regions = vectorRegions(lib, ops, vp, lines);
      // A scanned page with recognised text over it: the scan isn't a figure.
      // Keep the text, and cut the figures and tables out of the scan.
      const pageScan = raster.find((b) => (b[2] - b[0]) * (b[3] - b[1]) > vp.width * vp.height * 0.7);
      if (pageScan && lines.filter((l) => l.spans.some((sp) => sp.text.trim())).length >= 5) {
        raster = raster.filter((b) => b !== pageScan);
        regions.push(...scanRegions(lines, vp.width, vp.height, await inkMeter(page, vp)));
      }
      // text drawn inside a figure region is part of the picture: keep it
      // out of the running text (labels of a flow diagram, table cells)
      if (regions.length) {
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
      const images = [...raster.filter((b) => !regions.some((r) => b[0] >= r[0] - 2 && b[1] >= r[1] - 2 && b[2] <= r[2] + 2 && b[3] <= r[3] + 2)), ...regions];
      pages.push({ page, vp, width: vp.width, height: vp.height, lines, images });
    }
    let meta = { title: '', author: '' };
    try {
      const md = await doc.getMetadata();
      meta = { title: md.info.Title || '', author: md.info.Author || '' };
    } catch {}
    return { doc, pages, meta };
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
        if (area > W * H * 0.5) continue; // page background
        if (b[3] < H * 0.07 || b[1] > H * 0.93) continue; // header/footer bars, logos
        if (b[3] - b[1] < 3 && b[2] - b[0] > 40) rules.push(b);
        if (b[2] - b[0] > W * 0.85 && b[3] - b[1] < 3) continue; // full-width rules
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
    for (const g of groups.values()) {
      const r = [Infinity, Infinity, -Infinity, -Infinity];
      for (const { b } of g) r.splice(0, 4, Math.min(r[0], b[0]), Math.min(r[1], b[1]), Math.max(r[2], b[2]), Math.max(r[3], b[3]));
      const weight = sum(g.map((x) => x.w));
      const rotated = g.filter((x) => x.rot);
      const w = r[2] - r[0];
      const h = r[3] - r[1];
      const drawn = weight >= 15 && w >= 80 && h >= 50;
      const sideways = rotated.length >= 6 && w >= 60 && h >= 60;
      if (!drawn && !sideways) continue;
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
    // a region inside another is part of it
    return out.filter((r, i) => !out.some((o, j) => j !== i && o[0] <= r[0] && o[1] <= r[1] && o[2] >= r[2] && o[3] >= r[3] && (o[2] - o[0]) * (o[3] - o[1]) > (r[2] - r[0]) * (r[3] - r[1])));
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
      const top = rs.find((r) => r[1] > cy1 - 1 && r[1] - cy1 < 70 && r[0] < cx1 && r[2] > cx0 - 10 && r[0] > cx0 - 40);
      if (!top) continue;
      const nextCap = Math.min(H, ...caps.filter((c) => c !== cap && c.bbox[1] > top[1] && c.bbox[0] < top[2] && c.bbox[2] > top[0]).map((c) => c.bbox[1]));
      const same = rs.filter((r) => r !== top && r[1] > top[1] + 4 && r[1] < nextCap && Math.abs(r[0] - top[0]) < 8 && Math.abs(r[2] - top[2]) < 8);
      if (!same.length) continue;
      const bottom = same[same.length - 1];
      // header rows can sit above the first rule (BMJ, BMC): the table starts
      // where the caption (and its title, aligned with it) ends
      let start = top[1] - 2;
      const capSize = cap.spans[0].size;
      let capEnd = cy1;
      const between = flat.filter((l) => l !== cap && l.bbox[1] >= cap.bbox[1] && (l.bbox[1] + l.bbox[3]) / 2 > cy1 && (l.bbox[1] + l.bbox[3]) / 2 < top[1] && l.bbox[0] < top[2] && l.bbox[2] > top[0]).sort((a, c) => a.bbox[1] - c.bbox[1]);
      let i = 0;
      while (i < between.length && Math.abs(between[i].bbox[0] - cx0) < 3 && Math.abs(between[i].spans[0].size - capSize) < 0.8 && between[i].bbox[1] - capEnd < capSize * 0.8) capEnd = between[i++].bbox[3];
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

  function scanRegions(lines, W, H, ink) {
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
    const prose = (l) => l.bbox[2] - l.bbox[0] > bodyW * 0.6 && text(l).split(/\s+/).length >= 7 && !upper(text(l)) && !spread(l);
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
        while (j < flat.length && upper(text(flat[j])) && flat[j].bbox[1] - last.bbox[3] < size(last) * 2) last = flat[j++];
        const end = flat.slice(j).findIndex(prose);
        const rows = end < 0 ? flat.slice(j) : flat.slice(j, j + end);
        if (!rows.length) continue;
        box[1] = last.bbox[3] + 4;
        box[3] = Math.min(end < 0 ? H * 0.95 : flat[j + end].bbox[1] - 2, Math.max(...rows.map((l) => l.bbox[3])) + 10);
      } else {
        // the figure is above its caption, below the running text before it
        const above = flat.slice(0, i).reverse().find((l) => prose(l) || l === header);
        box[1] = above ? above.bbox[3] + 3 : H * 0.06;
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
      let [x0, , x1] = [W * 0.03, 0, W * 0.97];
      while (x1 - x0 > 40 && ink([x0, r[1], x0 + 4, r[3]], []) < 0.001) x0 += 4;
      while (x1 - x0 > 40 && ink([x1 - 4, r[1], x1, r[3]], []) < 0.001) x1 -= 4;
      return Object.assign([Math.max(0, x0 - 8), r[1], Math.min(W, x1 + 8), r[3]], { vector: true });
    };
    // Figures whose caption the recognition missed: a tall stretch without
    // running text where the scan has drawing beyond the recognised words.
    if (ink) {
      const top = header ? header.bbox[3] + 3 : H * 0.05;
      const marks = [top, ...flat.filter(prose).flatMap((l) => [l.bbox[1], l.bbox[3]]), H * 0.95].sort((a, c) => a - c);
      const textBoxes = flat.map((l) => l.bbox);
      for (let i = 0; i + 1 < marks.length; i++) {
        const box = [W * 0.03, marks[i] + 3, W * 0.97, marks[i + 1] - 3];
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

  // Which "Figure N" caption on this page belongs to an image? The nearest
  // one, preferring captions below the image (the usual layout).
  // (case-insensitive: small-caps captions extract as "fig 1 |", "table 2 |")
  // "Figure 2." / "fig 1 |" / "Figure 2 (A) …" / "Figure 4 Estimated …", but not "Figure 2 shows" or "Figure 2A shows"
  const CAPTION = /^\s*([Ff][Ii][Gg](?:[Uu][Rr][Ee])?\.?|[Tt][Aa][Bb][Ll][Ee])\s*([A-Z]?\d+)\s*(?:[.:|]|$|(?<=\s)(?=\(|\p{Lu}\p{Ll}|\p{Lu}{3,}\s))/u;
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

  // Render the page once and crop each image box (PyMuPDF get_pixmap(clip=…)).
  async function cropImages(pg, boxes) {
    const scale = 2;
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

  // ================================================================ PDF → HTML
  // Where is the gap between two columns? Not always the page centre: BMJ,
  // for one, has a wide left margin, so its gutter sits at ~60% of the width.
  // Scan for the vertical line that body-text lines don't cross.
  function findGutter(pdf, pageW) {
    const sizes = new Counter();
    for (const pg of pdf.pages) for (const l of pg.lines) for (const s of l.spans) if (s.text.trim()) sizes.add(pyRound(s.size));
    const body = sizes.mostCommon();
    const lines = [];
    for (const pg of pdf.pages)
      for (const l of pg.lines) if (horizontal(l) && l.spans.map((s) => s.text).join('').trim().length >= 20 && Math.abs(pyRound(l.spans[0].size) - body) <= 1) lines.push(l.bbox);
    if (lines.length < 40) return null;
    let best = null;
    for (let x = pageW * 0.3; x <= pageW * 0.72; x += 2) {
      let cross = 0;
      let left = 0;
      let right = 0;
      for (const [x0, , x1] of lines) {
        if (x0 < x - 3 && x1 > x + 3) cross++;
        else if (x1 <= x + 3) left++;
        else right++;
      }
      if (left < lines.length * 0.2 || right < lines.length * 0.2 || cross > lines.length * 0.12) continue;
      if (!best || cross < best.cross) best = { x, cross, run: [x] };
      else if (cross === best.cross && x - best.run.at(-1) <= 2) best.run.push(x); // widen the gap
    }
    return best ? best.run[best.run.length >> 1] : null;
  }

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
    if (centre < sides * 0.15 && sides > n * 0.3) return true;
    // The gutter test above is fooled by labels inside figures. Second test:
    // in two-column text, almost no full lines of body text cross the centre.
    const sizes = new Counter();
    for (const pg of pdf.pages) for (const l of pg.lines) for (const s of l.spans) if (s.text.trim()) sizes.add(pyRound(s.size));
    const body = sizes.mostCommon();
    let left = 0;
    let right = 0;
    let across = 0;
    for (const pg of pdf.pages) {
      for (const l of pg.lines) {
        const text = l.spans.map((s) => s.text).join('');
        if (text.trim().length < 25 || Math.abs(pyRound(l.spans[0].size) - body) > 1) continue;
        const [x0, , x1] = l.bbox;
        if (x0 < pageW * 0.45 && x1 > pageW * 0.55) across++;
        else if (x1 <= pageW * 0.55) left++;
        else right++;
      }
    }
    const total = left + right + across;
    return total > 40 && across < total * 0.15 && left > total * 0.25 && right > total * 0.25;
  }

  // Linotype "Mathematical Pi" fonts (APA and other publishers' symbols)
  // name glyphs H<number> and come without a Unicode map, so viewers show
  // "p [ .05" for "p < .05". Their names say which symbol it is.
  const PI_GLYPHS = { 11001: '+', 11002: '−', 11003: '×', 11004: '÷', 11005: '=', 11021: '<', 11022: '>', 11569: '*' };
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
        if (!script && (gap > 0.12 * Math.min(prev.size, s.size) || /\s$/.test(out) || /^\s/.test(text))) out += ' ';
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
            spans.push({ text: t, x0: s.bbox[0], x1: s.bbox[2], y0: s.bbox[1], y1: s.bbox[3], yc: (s.bbox[1] + s.bbox[3]) / 2, size: s.size, bold: isBold(s), font: s.font });
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
    const styles = learnHeadingStyles(pdf, bodySize);
    // global body-text left edge (per-page voting fails on box-dominated pages)
    const globalBodyLeft = globX0.mostCommon() ?? 0;
    const gutter = findGutter(pdf, pageW);
    const twoCol = gutter !== null || pdfIsTwoColumn(pdf, pageW);
    const mid = gutter ?? pageW / 2;
    // In two-column mode, text left of the left column (BMJ's affiliations
    // and notes margin) is a margin column, kept apart from the body text.
    let leftEdge = -Infinity;
    if (twoCol) {
      const c = new Counter();
      for (const pg of pdf.pages)
        for (const l of pg.lines) if (horizontal(l) && l.bbox[2] <= mid + 3 && l.spans.map((s) => s.text).join('').trim().length >= 20 && Math.abs(pyRound(l.spans[0].size) - bodySize) <= 1) c.add(pyRound(l.bbox[0] / 5) * 5);
      leftEdge = c.mostCommon() ?? -Infinity;
    }
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
    log(twoCol ? '  two-column layout' : '  layout with a side-margin column');

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
          if (horizontal(l)) for (const sp of l.spans) if (sp.text.trim()) edge.push({ y: (sp.bbox[1] + sp.bbox[3]) / 2, x: sp.bbox[0], text: sp.text });
        }
      }
      // whole visual rows too: a footer can be several runs ("the bmj" logo +
      // text + page number), and rows are what the text is compared by later
      edge.sort((a, b) => a.y - b.y || a.x - b.x);
      let row = [];
      const addRow = () => {
        if (!row.length) return;
        const sorted = row.sort((a, b) => a.x - b.x).map((r) => r.text).join(' ');
        seen.add(edgeKey(sorted));
        seen.add(edgeKey(sorted.replace(/^\s*[\divxlc]{1,4}\s+|\s+[\divxlc]{1,4}\s*$/gi, '')));
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
    const repeated = { has: (t) => repeatedKeys.has(edgeKey(t)) || repeatedKeys.has(edgeKey(t.replace(/^\s*[\divxlc]{1,4}\s+|\s+[\divxlc]{1,4}\s*$/gi, ''))) };
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
      main.forEach((m) => c.add(pyRound(m.size), m.text.length));
      return [txt, asideTxt, c.mostCommon()];
    };
    const joinSorted = (sps) => resolveHat(ws(joinSpans([...sps].sort((a, b) => a.x0 - b.x0))).trim());

    // A paragraph can run on across a column or page break; anything the page
    // adds at its end (margin notes, boxes, images) waits until it closes.
    const TERMINAL = '.!?:;\u201d"\')]';
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

    for (const pg of pdf.pages) {
      const spans = [];
      for (const l of pg.lines) {
        if (!horizontal(l)) continue;
        if (pg === pdf.pages[0] && l.bbox[3] < pg.height * 0.075) continue; // masthead on the first page (journal logo, header)
        for (const s of l.spans) {
          const t = fixGlyphs(s.text, s.font);
          if (t.trim()) spans.push({ text: t, x0: s.bbox[0], x1: s.bbox[2], y: (s.bbox[1] + s.bbox[3]) / 2, size: s.size, font: s.font, bold: !!(s.flags & 16), line: l });
        }
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
      if (twoCol && leftEdge > -Infinity) {
        const outer = pg.lines.filter((l) => horizontal(l) && l.bbox[0] < leftEdge - 6).sort((a, b) => a.bbox[1] - b.bbox[1]);
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
      const colOf = (sp) => {
        if (!twoCol) return 0;
        const kind = lineKind.get(sp.line);
        if (kind === 'margin') return -2;
        if (kind === 'box') return -3;
        return sp.x0 < mid - 12 && sp.x1 > mid + 12 ? -1 : (sp.x0 + sp.x1) / 2 < mid ? 0 : 1;
      };
      const rows = [];
      for (const c of [-3, -2, -1, 0, 1]) {
        const group = spans.filter((sp) => colOf(sp) === c).sort((a, b) => a.y - b.y || a.x0 - b.x0);
        let cur = null;
        for (const s of group) {
          if (cur && Math.abs(s.y - cur.at(-1).y) <= 5) cur.push(s);
          else {
            if (cur) rows.push(cur);
            cur = [s];
            cur.col = c;
          }
        }
        if (cur) rows.push(cur);
      }
      if (twoCol) {
        // a full-width span's row also takes same-height spans from the columns
        for (const r of rows.filter((x) => x.col === -1)) {
          for (const o of rows.filter((x) => x.col >= 0 && x.length && Math.abs(x[0].y - r[0].y) <= 5)) r.push(...o.splice(0));
        }
        for (let i = rows.length - 1; i >= 0; i--) if (!rows[i].length) rows.splice(i, 1);
      }

      // "Abstract  Social relationships have…": a run-in label in bigger or
      // bold type at the start of a body line is a heading of its own
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = [...rows[i]].sort((a, b) => a.x0 - b.x0);
        const [head, ...rest] = r;
        if (!rest.length || head.text.trim().split(/\s+/).length > 4 || sum(rest.map((sp) => sp.text.length)) < 20) continue;
        const restSize = rest[0].size;
        const differs = head.size >= restSize + 2 || (head.bold && !rest.some((sp) => sp.bold) && SECTION_WORD.test(head.text.trim()));
        if (!differs || rest.some((sp) => Math.abs(sp.size - restSize) > 1)) continue;
        const a = [head];
        const b = rest;
        a.col = b.col = rows[i].col;
        rows.splice(i, 1, a, b);
      }
      let ordered = [];
      const pageAsides = [];
      const marginRows = [];
      const boxRows = [];
      const leftBlockRows = [];
      for (let row of rows) {
        const rowCol = row.col; // (row gets replaced by filtered copies below)
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
        if (repeated.has(txt) || ROMAN_OR_DIGITS.test(txt)) continue;
        txt = fixSmallCaps(txt);
        // Labels inside vector figures ("weight layer", "iter. (1e4)"): short
        // runs of smaller type, or rows that are mostly numbers.
        const letters = (txt.match(/\p{L}/gu) || []).length;
        if (!CAPTION.test(txt) && ((sz < bodySize - 0.5 && txt.split(/\s+/).length <= 4) || letters < txt.replace(/\s/g, '').length * 0.4)) continue;
        const col = !twoCol ? 0 : rowCol === undefined ? 0 : rowCol;
        const bold = row.every((sp) => sp.bold || !sp.text.trim());
        const fw = new Counter();
        row.forEach((sp) => fw.add(sp.font, sp.text.length));
        const font = fw.mostCommon();
        const styled = fw.get(font) >= 0.9 * sum(row.map((sp) => sp.text.length)) && styles.has(font, row.find((sp) => sp.font === font)?.size ?? sz);
        const minor = styled && styles.minor(font, row.find((sp) => sp.font === font)?.size ?? sz);
        ordered.push([col, row[0].y, txt, sz, Math.min(...row.map((sp) => sp.x0)), bold, Math.max(...row.map((sp) => sp.x1)), styled, minor]);
        if (aside && aside.length > 3 && !repeated.has(aside)) pageAsides.push([aside, sz]);
      }
      if (twoCol) {
        // full-width rows above the columns come first, the rest after
        // (measured from real column text, not a stray label above it)
        // where the columns start: the first long line with more of them just below
        // (a lone label at the top, "Original Research | Critical Care", isn't it)
        const ysOf = (lines) => lines.map((t) => t[1]).sort((a, b) => a - b);
        const cluster = (lines) => {
          const ys = ysOf(lines);
          return ys.find((y, i) => ys[i + 2] !== undefined && ys[i + 2] - y < bodySize * 5);
        };
        const bodyLines = ordered.filter((t) => t[0] >= 0 && t[2].length >= 30 && Math.abs(t[3] - bodySize) <= 1);
        // (a page all in smaller type, like the reference list: any real column lines will do)
        const anyLines = ordered.filter((t) => t[0] >= 0 && t[2].length >= 30);
        const colTop = cluster(bodyLines) ?? cluster(anyLines) ?? ysOf(anyLines)[0] ?? Infinity;
        // headings side by side at the top of each column ("Introduction" | "Methods") stay in their columns
        const sideBySide = (t) => ordered.some((o) => o !== t && o[0] === 1 - t[0] && Math.abs(o[1] - t[1]) <= 3 && (t[0] === 0 ? o[4] - t[6] : t[4] - o[6]) > 20);
        for (const t of ordered) {
          if (t[0] === -1 && t[1] > colTop) t[0] = 2;
          else if (t[0] >= 0 && t[0] <= 1 && t[1] < colTop - 2 && !sideBySide(t)) t[0] = -1; // author lines etc. above the columns
        }
        // a bare "Table 5" label over a full-width title goes with its title
        for (const t of ordered) {
          if (t[0] < 0 || t[0] > 1 || !/^\s*(fig(ure)?\.?|table)\s*[A-Z]?\d+[.:]?\s*$/i.test(t[2])) continue;
          const below = ordered.filter((o) => o[1] > t[1] && o[1] - t[1] < t[3] * 2.5 && Math.abs(o[4] - t[4]) < 20).sort((a, b) => a[1] - b[1])[0];
          if (below && (below[0] === -1 || below[0] === 2)) t[0] = below[0];
        }
        ordered = ordered.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
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
        const gaps = lines.slice(1).map((t, i) => t[1] - lines[i][1]).filter((g) => g > 0).sort((a, b) => a - b);
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
      let lastSmall = null; // the section heading just emitted, to join a wrapped second line
      for (let [c, y, txt, sz, x0, bold, x1, styled, minor] of ordered) {
        // first-page badges, not content
        if (pg === pdf.pages[0] && /^(open access|(research|review|original|brief) (article|research|report|communication)|research|r e s e a r c h.*)$/i.test(txt.trim())) continue;
        if (capBuf) {
          // (a caption's wide first line counts as full width, its next line as a column)
          const gapBreak = (c !== capBuf.c && c !== -1 && capBuf.c !== -1) || y - capBuf.y > (lineGap.get(c) || sz * 1.4) * 1.6 || Math.abs(sz - capBuf.sz) >= 1;
          if (!gapBreak) {
            capBuf.lines.push(txt);
            capBuf.y = y;
            continue;
          }
          endCaption();
        }
        if (CAPTION.test(txt)) {
          capBuf = { lines: [txt], c, y, sz };
          continue;
        }
        // bold, body-sized, short and numbered (or a standard name): a section heading
        const nWords = txt.split(/\s+/).length;
        const standalone = !paraBuf.length || endsWithAny(paraBuf.at(-1).trimEnd(), TERMINAL);
        if (
          (bold && sz >= bodySize - 0.5 && sz < bodySize + 3 && !endsWithAny(txt, ',;') &&
            ((nWords <= 12 && SECTION.test(txt)) || (nWords <= 8 && standalone && !endsWithAny(txt, '.:') && /^\p{Lu}/u.test(txt)))) ||
          (standalone && sz >= bodySize - 0.5 && sz < bodySize + 3 && headingText(txt) && (styled || capsHeading(txt))) ||
          (capsHeading(txt) && NUMBERED.test(txt) && sz >= bodySize - 2.5)
        ) {
          flushPara();
          const tag = minor && !bold ? 'h4' : 'h3';
          // a heading wrapped onto a second line is one heading
          if (lastSmall && lastSmall.tag === tag && lastSmall.c === c && y > lastSmall.y && y - lastSmall.y < sz * 2.4 && parts.length - 1 === lastSmall.i && !endsWithAny(lastSmall.text, '.') &&
            !NUMBERED.test(txt) && !SECTION_WORD.test(txt) && !(SECTION_WORD.test(lastSmall.text) && lastSmall.text.split(/\s+/).length <= 2)) {
            lastSmall.text += ' ' + txt;
            lastSmall.y = y;
            parts[lastSmall.i] = `<${tag}>${escRich(headingCase(lastSmall.text))}</${tag}>`;
            prev = null;
            lastHeading = null;
            continue;
          }
          parts.push(`<${tag}>${escRich(headingCase(txt))}</${tag}>`);
          lastSmall = { i: parts.length - 1, tag, text: txt, c, y };
          prev = null;
          lastHeading = null;
          continue;
        }
        // big type is a heading, unless it's running text set large (an abstract or lead)
        const bigText = txt.split(/\s+/).length > 14 || (lastHeading && (lastHeading.text + ' ' + txt).split(/\s+/).length > 24);
        if (sz >= bodySize + 3 && !bigText) {
          flushPara();
          txt = txt.replace(/\s+(?:DOI|doi):?\s*10\.\S+.*$/, ''); // a DOI printed beside the title
          // a heading wrapped onto two lines is one heading
          // (a title runs on after its colon: "Hiring as Cultural Matching: The Case of …")
          if (lastHeading && Math.abs(lastHeading.sz - sz) < 0.6 && lastHeading.c === c && y - lastHeading.y < sz * 2.2 && !endsWithAny(lastHeading.text, lastHeading.tag === 'h1' ? '.' : '.:')) {
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
        if (indented && sameIndent && prose) startsPara = false;
        if (startsWithAny(txt.trimStart(), ['•', '–', '- ', '* '])) startsPara = true;
        if (startsPara) {
          flushPara();
          paraQuote = indented && sz < bodySize - 0.4;
        } else if (!(indented && sameIndent && prose)) paraQuote = paraQuote && indented;
        paraBuf.push(txt);
        prev = { c, y, sz, x1, txt, x0, indented, indent: x0 - (x ?? x0) };
      }
      endCaption();
      // keep an unfinished paragraph open across the page break
      if (paraBuf.length && endsWithAny(paraBuf.at(-1).trimEnd(), TERMINAL)) flushPara();
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
        boxRows.forEach((r, i) => {
          if (r.bold && r.txt.split(/\s+/).length <= 10) {
            out();
            emit(`<h4>${escRich(headingCase(r.txt))}</h4>`);
            return;
          }
          buf.push(r.txt);
          const next = boxRows[i + 1];
          if (r.x1 < right - 40 || !next || next.bold) out();
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
          if (lastY !== null && r.y - lastY > r.sz * 2) out();
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
        let type = blob ? (blob.type || '').split(';')[0] : '';
        // tiny files are spacers/pixels; text/html is a bot-check or error page
        if (!blob || blob.size < 1024 || (type && type !== 'application/octet-stream' && !type.startsWith('image/'))) {
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
    // no title at all: a closing run of paragraphs that mostly start "12 Surname AB" / "[12]"
    if (!refHead) {
      const ps = [...root.children].filter((e) => e.localName === 'p');
      const starts = (e) => /^\[?\d{1,3}[\].]?\s+[\p{Lu}][\p{L}'’-]+/u.test(e.textContent.trim());
      let i = ps.length - 1;
      let hits = 0;
      let first = null;
      for (; i >= 0 && ps.length - i <= 400; i--) {
        if (starts(ps[i])) {
          hits++;
          first = ps[i];
        } else if (ps.length - i > 6 && hits < (ps.length - i) * 0.5) break;
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
            .split(/(?=\[\d{1,3}\]\s)|(?<=\s)(?=\d{1,3}\.?\s+[\p{Lu}][\p{L}'’-]+,?\s+(?:[\p{Lu}]{1,3}[,.\s]|[\p{Lu}]\.))/u)
            .map((x) => x.trim())
            .filter(Boolean)
        );
      }
      // Unnumbered lists: entries run together after a full stop, starting
      // "Surname AB, Surname CD" or "Surname AB. 1999"
      if (out.filter((t) => /^\[?\d{1,3}[\].]?\s/.test(t)).length < Math.max(3, out.length * 0.2)) {
        const AUTHOR_START = /(?<=[\p{L}\d)]\.\s)(?=[\p{Lu}][\p{L}'’-]+(?:[ -][\p{Lu}][\p{L}'’-]+)?\s[\p{Lu}]{1,3}(?:,\s[\p{Lu}][\p{L}'’-]+(?:[ -][\p{Lu}][\p{L}'’-]+)?\s[\p{Lu}]{1,3}[,.]|\.\s(?:1[89]|20)\d\d))/u;
        // social-science style: "Surname, First[, First Surname][ and First Surname]. 1998."
        const NAMED_START = /(?<=\s)(?=[\p{Lu}][\p{L}'’-]+,\s[\p{Lu}][\p{L}'’-]+(?:\s[\p{Lu}]\.)*(?:,\s[\p{Lu}][\p{L}'’.\s-]{1,40}?)*(?:,?\s(?:and|&)\s[\p{Lu}][\p{L}'’.\s-]{1,40}?)?\.\s(?:1[89]|20)\d\d[a-z]?\.)/u;
        out.splice(0, out.length, ...out.flatMap((t) => t.split(AUTHOR_START).flatMap((x) => x.split(NAMED_START)).map((x) => x.trim()).filter(Boolean)));
      }
      // one paragraph per printed line: fold lines that don't start an
      // entry into the entry above (when the list is numbered at all)
      const isStart = (t) => /^\[?\d{1,3}[\].]?\s/.test(t);
      if (out.filter(isStart).length >= Math.max(3, out.length * 0.2)) {
        const merged = [];
        // "3Department of …": an affiliation (marker glued to the word) from a side column
        for (const t of out.filter((x) => !/^\d{1,2}\p{Lu}\p{Ll}+/u.test(x))) {
          if (isStart(t) || !merged.length) merged.push([t]);
          else merged.at(-1).push(t);
        }
        out.splice(0, out.length, ...merged.map((lines) => joinWrapped(lines)));
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
      links += replaceInText(root, /\[(\d{1,3}(?:\s*[-–,;]\s*\d{1,3})*)\]/, (m, doc) => {
        const inner = linkNums(m[1], doc);
        return inner && ['[', ...inner, ']'];
      });
      // superscripts in the title/author block are affiliations, not citations
      const bodyStart = [...root.querySelectorAll('h2, h3, h4')].find((h) => !h.closest('header'));
      for (const sup of root.querySelectorAll('sup')) {
        if (sup.closest('a, .refs, h1, h2, h3, h4, math')) continue;
        if (bodyStart && sup.compareDocumentPosition(bodyStart) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
        const t = sup.textContent.trim();
        if (!/^\d{1,3}(?:\s*[-–,]\s*\d{1,3})*$/.test(t) && !/^\d{1,3}(?:\s+\d{1,3})+$/.test(t)) continue;
        const prevText = sup.previousSibling && sup.previousSibling.nodeType === 3 ? sup.previousSibling.data : '';
        if (/\d\s*$/.test(prevText)) continue; // 10⁶ is a power, not a citation
        const inner = linkNums(t, doc);
        if (!inner) continue;
        sup.replaceChildren(...inner);
        links++;
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

  // PubMed Central full text as JATS XML. NCBI's E-utilities serves it for
  // open-access papers *and* author manuscripts (free to read, not openly
  // licensed), with permissive CORS; Europe PMC's API only covers the
  // open-access subset, so it's the fallback. Europe PMC also maps DOI → PMCID.
  async function fromPubmedCentral(doi, log) {
    log('→ looking for free full text in PubMed Central');
    const q = encodeURIComponent(`DOI:"${doi}"`);
    const s = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${q}&format=json&resultType=lite`).then((r) => r.json());
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
      xml = await parse(await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${pmcid.replace(/^PMC/i, '')}&rettype=xml`));
    } catch {}
    if (!xml) {
      log('  ! NCBI had no full text; trying Europe PMC');
      try {
        xml = await parse(await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`));
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
          const li = ol.appendChild(el('li', ws((r.querySelector('mixed-citation, element-citation, citation') || r).textContent).trim()));
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
      res = await fetch(url, { credentials: 'omit' });
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

  function fromWebPage(page, log) {
    const doc = new DOMParser().parseFromString(page.html, 'text/html');
    const meta = pageMeta(page);
    const baseUrl = page.url || meta.url || location.href; // where the page actually was: relative image links resolve against it
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

    if (src.label === 'PDF') groupPdfFigures(src.root);
    placeFigures(src.root, log);
    linkify(src.root, log);
    const wanted = src.root.querySelectorAll('img, object[data]').length;
    const media = await localizeImages(src.root, src.baseUrl, src.pdfImages || [], log);
    let missingFigures = src.root.querySelectorAll('figure').length && src.label !== 'PDF' ? Math.max(0, wanted - media.length) : 0;
    // a text source that left the figures out entirely (some manuscripts in
    // PubMed Central) while the text refers to them: count those as missing
    if (!missingFigures && src.label !== 'PDF' && src.label !== 'arXiv HTML' && !src.root.querySelector('figure, img')) {
      const nums = new Set([...src.root.textContent.matchAll(/\b(?:Fig(?:ure)?s?\.?)\s*(\d{1,2})\b/gi)].map((m) => m[1]));
      missingFigures = nums.size;
    }
    // Text sources whose figure images are off-limits to apps (PubMed Central
    // manuscripts, Europe PMC): the stored PDF has the pictures, so use it
    // when it actually yields them.
    if (missingFigures && pdf && source === 'auto' && src.label !== 'arXiv HTML') {
      log(`→ ${missingFigures} figure image(s) unavailable from ${src.label}; trying the stored PDF`);
      try {
        const alt = await make(paper, { source: 'pdf', pdf, log });
        if (!alt.images) log('  no images found in the PDF either, so keeping the text version');
        else return { ...alt, source: `PDF (${src.label} had no figure images)` };
      } catch (err) {
        log('  ! ' + err.message);
      }
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

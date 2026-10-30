// Downloads a PDF for PaperReads the way the browser itself would: with your
// cookies and your network, so open-access copies and anything your library
// gives you access to come through. Only PDFs are ever handed back.
const PAPERREADS = [/^https:\/\/olofsigling\.github\.io\/PaperReads\//, /^http:\/\/localhost(:\d+)?\//];
const MAX = 80e6;

const fromPaperReads = (sender) => !sender.tab || PAPERREADS.some((re) => re.test(sender.url || sender.tab.url || ''));

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const isPdf = (buf) => new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength))).includes('%PDF-');

// The publisher's own link to the PDF, from the article page's metadata
// (citation_pdf_url: what Google Scholar reads).
function pdfLinkIn(html, base) {
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metas) {
    if (!/name\s*=\s*["']citation_pdf_url["']/i.test(tag)) continue;
    const c = /content\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (c) {
      try {
        return new URL(c[1].replace(/&amp;/g, '&'), base).href;
      } catch {}
    }
  }
  return null;
}

async function get(url) {
  const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
  if (!res.ok) throw new Error(res.status === 403 || res.status === 401 ? 'no access (the site refused)' : `the site answered ${res.status}`);
  const len = +res.headers.get('content-length') || 0;
  if (len > MAX) throw new Error('too large');
  return { res, buf: await res.arrayBuffer() };
}

function asPdf(buf, res) {
  const last = new URL(res.url).pathname.split('/').filter(Boolean).pop() || 'paper';
  const name = decodeURIComponent(last).replace(/\.pdf$/i, '').slice(0, 80) + '.pdf';
  return { ok: true, name, finalUrl: res.url, b64: b64(buf) };
}

// a PDF link, or an article page that names its PDF
async function pdfFrom(url, hops = 0) {
  const { res, buf } = await get(url);
  if (isPdf(buf)) return asPdf(buf, res);
  const type = res.headers.get('content-type') || '';
  if (!/html/i.test(type) || hops > 1) throw new Error('no PDF there');
  const html = new TextDecoder('utf-8').decode(buf);
  const link = pdfLinkIn(html, res.url);
  if (link && link !== url) return pdfFrom(link, hops + 1);
  if (/captcha|challenge|are you a robot|verify you are human|cf-chl/i.test(html)) throw new Error('the site wants a robot check: open it once in a tab, then try again');
  throw new Error('no access to the PDF');
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!fromPaperReads(sender) || !m) return false;
  let job;
  if (m.kind === 'pdf' && /^https?:\/\//.test(m.url)) job = pdfFrom(m.url);
  else if (m.kind === 'doi' && /^10\.\d{4,9}\//.test(m.doi)) job = pdfFrom(`https://doi.org/${encodeURI(m.doi)}`);
  else return false;
  job.then(reply, (err) => reply({ ok: false, error: String((err && err.message) || err) }));
  return true; // answering later
});

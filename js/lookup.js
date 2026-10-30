// Metadata lookup. Everything here needs network; the rest of the app does not.
// doi.org content negotiation returns CSL-JSON for any DOI (Crossref, DataCite,
// including arXiv's 10.48550 DOIs) and allows cross-origin requests.
const Lookup = (() => {
  const ARXIV_NEW = /(\d{4}\.\d{4,5})(v\d+)?/;
  const ARXIV_OLD = /([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/;
  const DOI_RE = /10\.\d{4,9}\/[^\s"<>]+/;

  function cleanDoi(doi) {
    return decodeURIComponent(doi)
      .replace(/[.,;)\]]+$/, '')
      .replace(/\/(full|abstract|pdf|epdf|html)$/i, '')
      .replace(/\.pdf$/i, '');
  }

  // PubMed / PMC links → DOI via Europe PMC (NCBI's own converter has no CORS).
  async function doiFromPubmed(url) {
    let q = null;
    let m;
    if ((m = /(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed)\/(\d+)/i.exec(url))) q = `EXT_ID:${m[1]} AND SRC:MED`;
    else if ((m = /\b(PMC\d+)\b/i.exec(url))) q = `PMCID:${m[1].toUpperCase()}`;
    if (!q) return null;
    const res = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&resultType=lite`);
    if (!res.ok) return null;
    const hit = ((await res.json()).resultList || {}).result || [];
    return hit[0] && hit[0].doi ? hit[0].doi : null;
  }

  // A PubMed record's details straight from Europe PMC, for papers whose
  // DOI isn't known (yet).
  async function pubmedMeta(url) {
    const m = /(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed)\/(\d+)/i.exec(url) || /^PMID:?\s*(\d+)$/i.exec(url);
    if (!m) return null;
    const res = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`EXT_ID:${m[1]} AND SRC:MED`)}&format=json&resultType=core`);
    if (!res.ok) return null;
    const r = (((await res.json()).resultList || {}).result || [])[0];
    if (!r) return null;
    return {
      title: (r.title || '').replace(/\.$/, ''),
      authors: ((r.authorList && r.authorList.author) || []).map((a) => a.fullName || [a.firstName, a.lastName].filter(Boolean).join(' ')).filter(Boolean),
      year: parseInt(r.pubYear, 10) || null,
      venue: (r.journalInfo && r.journalInfo.journal && r.journalInfo.journal.title) || r.journalTitle || '',
      abstract: stripTags(r.abstractText || ''),
      doi: r.doi || null,
      url: `https://pubmed.ncbi.nlm.nih.gov/${m[1]}/`,
      totalPages: null,
    };
  }

  // A pasted list of papers: links (PubMed, DOI, arXiv, publisher pages),
  // bare DOIs, arXiv IDs, PMIDs. One paper per line when the list has lines
  // (a line can give the same paper twice: "PubMed · arXiv version");
  // otherwise one per identifier.
  function listItems(text) {
    const TOKEN = /https?:\/\/[^\s<>()\[\]]+|\b10\.\d{4,9}\/[^\s"<>()\[\]]+|\barXiv:\s*\d{4}\.\d{4,5}(?:v\d+)?|\bPMID:?\s*\d{5,9}/gi;
    const tokensOf = (t) => [...t.matchAll(TOKEN)].map((m) => m[0].replace(/[.,;:]+$/, '')).filter((x) => !/^https?:\/\/(www\.)?(google|bing)\./i.test(x));
    const lines = String(text || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const withIds = lines.filter((l) => tokensOf(l).length);
    const label = (l) =>
      ((/\[([^\]]+)\]\(/.exec(l) || [])[1] || l.replace(TOKEN, '').replace(/[*_\[\]()·|•-]+/g, ' '))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    if (withIds.length >= 2) return withIds.map((l) => ({ label: label(l), tokens: [...new Set(tokensOf(l))] }));
    return [...new Set(tokensOf(text))].map((t) => ({ label: '', tokens: [t] }));
  }

  // Details for one listed paper. Its tokens may name it several ways: the
  // journal DOI wins for the details, an arXiv ID is kept for the PDF.
  async function resolveItem(item) {
    let doi = null;
    let arxiv = null;
    let pubmed = null;
    for (const t of item.tokens) {
      const ids = parse(/^PMID/i.test(t) ? '' : t);
      if (ids.arxiv) arxiv = arxiv || ids.arxiv;
      if (ids.doi && !/^10\.48550\/arxiv/i.test(ids.doi)) doi = doi || ids.doi;
      if (/pubmed|^PMID/i.test(t)) pubmed = pubmed || t;
    }
    if (!doi && pubmed) doi = await doiFromPubmed(pubmed).catch(() => null);
    let meta = null;
    if (doi) meta = await byDoi(doi).catch(() => null);
    if (!meta && pubmed) meta = await pubmedMeta(pubmed).catch(() => null);
    if (!meta && arxiv) meta = await byDoi(`10.48550/arXiv.${arxiv}`).catch(() => null);
    if (!meta || !meta.title) return null;
    if (arxiv) meta.arxiv = arxiv;
    if (!meta.doi && doi) meta.doi = doi;
    return meta;
  }

  // Page titles from the share sheet often end in " | Site name". Dash
  // suffixes are ambiguous ("Title - a review"), so search() tries both.
  function cleanTitle(t) {
    let s = (t || '').replace(/\s+/g, ' ').trim().replace(/\.pdf$/i, '');
    for (let i = 0; i < 2; i++) {
      const pipe = /^(.{8,}?)\s+\|\s+[^|]{1,80}$/.exec(s);
      if (pipe) s = pipe[1];
    }
    return s.replace(/\s*\[(PDF|HTML)\]\s*$/i, '').trim();
  }
  const dropDashSuffix = (t) => t.replace(/\s+[-–—]\s+[^-–—]{1,80}$/, '');

  // Pull a DOI / arXiv id / URL out of free text (what the share sheet sends).
  function parse(input) {
    const text = (input || '').trim();
    const out = { doi: null, arxiv: null, url: null };
    const urlMatch = text.match(/https?:\/\/\S+/);
    if (urlMatch) out.url = urlMatch[0].replace(/[.,;)\]]+$/, '');

    const arxivHost = /arxiv\.org\/(abs|pdf|html)\/([^\s?#]+)/i.exec(text);
    if (arxivHost) {
      const m = ARXIV_NEW.exec(arxivHost[2]) || ARXIV_OLD.exec(arxivHost[2]);
      if (m) out.arxiv = m[1];
    } else if (/^arxiv:/i.test(text) || (!out.url && ARXIV_NEW.test(text) && !DOI_RE.test(text))) {
      const m = ARXIV_NEW.exec(text) || ARXIV_OLD.exec(text);
      if (m) out.arxiv = m[1];
    }

    const doiMatch = DOI_RE.exec(text);
    if (doiMatch) {
      out.doi = cleanDoi(doiMatch[0]);
      const ax = /^10\.48550\/arxiv\.(.+)$/i.exec(out.doi);
      if (ax) out.arxiv = ax[1];
    }
    if (out.arxiv && !out.doi) out.doi = `10.48550/arXiv.${out.arxiv}`;
    return out;
  }

  function stripTags(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.innerHTML = s.replace(/<jats:title>.*?<\/jats:title>/gi, '');
    return div.textContent.replace(/\s+/g, ' ').trim();
  }

  function authorName(a) {
    if (a.literal) return a.literal;
    return [a.given, a.family].filter(Boolean).join(' ');
  }

  function fromCsl(csl) {
    const parts = (csl.issued && csl.issued['date-parts'] && csl.issued['date-parts'][0]) || [];
    const container = Array.isArray(csl['container-title']) ? csl['container-title'][0] : csl['container-title'];
    let pages = null;
    if (csl['number-of-pages']) pages = parseInt(csl['number-of-pages'], 10) || null;
    else if (typeof csl.page === 'string') {
      const m = /^(\d+)\s*[-–]\s*(\d+)$/.exec(csl.page);
      if (m) pages = Math.max(1, parseInt(m[2], 10) - parseInt(m[1], 10) + 1);
    }
    return {
      // (titles can carry markup: <i>, <sub>, MathML for "Q-learning")
      title: stripTags(Array.isArray(csl.title) ? csl.title[0] : csl.title || '').replace(/\s+([-–’'),.:;])/g, '$1'),
      authors: (csl.author || []).map(authorName).filter(Boolean),
      year: parts[0] || null,
      venue: stripTags(container || csl.publisher || ''), // ("Health &amp; Care")
      abstract: stripTags(csl.abstract),
      doi: csl.DOI || null,
      url: csl.URL || null,
      totalPages: pages,
    };
  }

  async function byDoi(doi) {
    const res = await fetch(`https://doi.org/${encodeURIComponent(doi).replace(/%2F/g, '/')}`, {
      headers: { Accept: 'application/vnd.citationstyles.csl+json' },
    });
    if (!res.ok) throw new Error(`DOI lookup failed (${res.status})`);
    const csl = await res.json();
    // A DOI for part of a paper (abstract, figure): use the paper's DOI instead.
    const parent = doi.replace(/\.[^./]+$/, '');
    if (csl.type === 'component' && parent !== doi && /\/./.test(parent)) {
      try {
        return await byDoi(parent);
      } catch {}
    }
    return fromCsl(csl);
  }

  async function search(query) {
    query = cleanTitle(query);
    const url = `https://api.crossref.org/works?rows=20&select=DOI,title,author,issued,container-title,publisher,is-referenced-by-count,update-to&query.bibliographic=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const json = await res.json();
    // Crossref's relevance ranking lets obscure near-matches beat the famous
    // paper, so re-rank: title similarity first, then citation count.
    const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
    const q = words(query);
    const sim = (t) => {
      const w = words(t);
      let both = 0;
      for (const x of w) if (q.has(x)) both++;
      return both / (q.size + w.size - both || 1);
    };
    const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const variants = new Set([norm(query), norm(dropDashSuffix(query))]);
    // A whole reference ("Smith J, Lee K. Title of paper. J Econ 2019;…")
    // contains the title rather than being it.
    const inRef = (t) => norm(t).split(' ').length >= 4 && norm(query).length > norm(t).length + 15 && ` ${norm(query)} `.includes(` ${norm(t)} `);
    const results = json.message.items
      .filter((it) => it.title && it.title.length)
      .map((it) => ({
        ...fromCsl(it),
        doi: it.DOI,
        score: Math.round(Math.max(sim(it.title[0]), variants.has(norm(it.title[0])) || inRef(it.title[0]) ? 1 : 0) * 10),
        cites: it['is-referenced-by-count'] || 0,
        // corrections/errata often repeat the original title word for word
        notice: !!(it['update-to'] && it['update-to'].length) || /^(correction|erratum|corrigendum|retraction|expression of concern)\b/i.test(it.title[0]),
        exact: variants.has(norm(it.title[0])) || inRef(it.title[0]),
      }))
      .sort((a, b) => b.score - a.score || a.notice - b.notice || b.cites - a.cites)
      .slice(0, 8);
    // Confident when the best hit is an exact title match and not a notice.
    if (results[0] && results[0].exact && !results[0].notice) results[0].confident = true;
    return results;
  }

  // Resolve whatever the user pasted/shared into metadata.
  async function resolve(input) {
    const ids = parse(input);
    if (!ids.doi && ids.url) ids.doi = await doiFromPubmed(ids.url).catch(() => null);
    if (ids.doi) {
      const meta = await byDoi(ids.doi);
      if (ids.arxiv) {
        meta.arxiv = ids.arxiv;
        meta.url = `https://arxiv.org/abs/${ids.arxiv}`;
      } else if (ids.url && !meta.url) meta.url = ids.url;
      return { meta, ids };
    }
    return { meta: null, ids };
  }

  // Does this link point at a PDF? Generic URL shapes, no site list.
  function isPdfUrl(url) {
    return !!url && (/\.pdf($|[?#])/i.test(url) || /\/pdf(\/|$|[?#])/i.test(url) || /[?&](type=printable|pdf=render|download=pdf)/i.test(url));
  }

  // Download a PDF from any site that allows it. Many sites answer with a
  // bot-check page instead, so check the bytes, not the status code.
  async function fetchPdf(url) {
    let res;
    try {
      res = await fetch(url);
    } catch {
      throw new Error('the site doesn’t let apps download its PDFs');
    }
    if (!res.ok) throw new Error(`the site answered ${res.status}`);
    const blob = await res.blob();
    const head = new TextDecoder('latin1').decode(await blob.slice(0, 1024).arrayBuffer());
    if (!head.includes('%PDF-')) throw new Error('the site sent a web page instead of the PDF');
    const name = decodeURIComponent((new URL(res.url || url).pathname.split('/').filter(Boolean).pop() || 'paper').replace(/\.pdf$/i, '')) + '.pdf';
    return new File([blob], name, { type: 'application/pdf' });
  }

  // Work out which paper a PDF is: a DOI in its metadata or on page 1, an
  // arXiv stamp, or failing that its title (metadata or biggest type on page 1).
  async function identifyPdf(blob) {
    const lib = await Epubify.pdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
    try {
      const md = await doc.getMetadata().catch(() => ({ info: {}, metadata: null }));
      const info = md.info || {};
      const xmp = md.metadata && md.metadata.getAll ? Object.values(md.metadata.getAll()).flat().join(' ') : '';
      const page = await doc.getPage(1);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('');
      const findDoi = (t) => {
        // prefer DOIs labelled as such ("doi:", "doi.org/") over ones in citations
        const labelled = [...t.matchAll(/(?:doi(?:\.org)?\s*[:/]\s*|DOI\s+)(10\.\d{4,9}\/[^\s"<>]+)/gi)].map((m) => cleanDoi(m[1]));
        const found = labelled.length ? labelled : [DOI_RE.exec(t)].filter(Boolean).map((m) => cleanDoi(m[0]));
        // a section's DOI extends the paper's (…05224.001 vs …05224): keep the parent
        return found.find((d) => !found.some((o) => o !== d && d.toLowerCase().startsWith(o.toLowerCase() + '.'))) || null;
      };
      const doi = findDoi([info.Subject, info.Keywords, info.doi, xmp].filter(Boolean).join(' ')) || findDoi(text);
      const ax = /arXiv:\s*(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i.exec(text);

      // Title: trust metadata only if it's actually printed on page 1
      // (typesetters often leave labels like "pone.0024658 1..11" there).
      // compare without spaces: small caps come out as "A DAM" in the text layer
      const squash = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');
      let title = (info.Title || '').trim();
      if (title.length < 12 || !squash(text).includes(squash(title).slice(0, 30))) {
        // Biggest type in the top half of page 1, in reading order.
        const vp = page.getViewport({ scale: 1 });
        const items = tc.items
          .filter((it) => it.str.trim())
          .map((it) => {
            const t = lib.Util.transform(vp.transform, it.transform);
            return { str: it.str, size: Math.hypot(t[2], t[3]), x: t[4], y: t[5] };
          })
          .filter((it) => it.y < vp.height * 0.6 && it.str.trim().length > 1);
        const max = Math.max(0, ...items.map((it) => it.size));
        const big = items.filter((it) => it.size > max - 0.6).sort((a, b) => a.y - b.y || a.x - b.x);
        title = big.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
      }
      if (title.length < 8 || title.length > 300) title = '';
      return { doi, arxiv: ax ? ax[1] : null, title };
    } finally {
      doc.destroy();
    }
  }

  // arXiv serves PDFs with permissive CORS, so we can keep a copy offline.
  // Free, legal copies of a paper (open access, preprints, author
  // manuscripts in university repositories), from OpenAlex. The publisher's
  // own copy comes first, then the accepted manuscript, then preprints.
  async function freeCopies({ doi, title }) {
    let w = null;
    try {
      if (doi) {
        const res = await fetch(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`);
        if (res.ok) w = await res.json();
      }
      if (!w && title && title.length > 15) {
        const res = await fetch(`https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=3`);
        const squash = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (res.ok) w = ((await res.json()).results || []).find((x) => squash(x.title) === squash(title)) || null;
      }
    } catch {
      return null; // offline, or OpenAlex unreachable
    }
    if (!w) return { pdfs: [], arxiv: null };
    const rank = { publishedVersion: 0, acceptedVersion: 1, submittedVersion: 2 };
    const label = { publishedVersion: 'published version', acceptedVersion: 'author’s accepted manuscript', submittedVersion: 'preprint' };
    let arxiv = null;
    const seen = new Set();
    const pdfs = [];
    for (const l of w.locations || []) {
      const m = /arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:\.pdf)?$/i.exec(l.landing_page_url || l.pdf_url || '');
      if (m && !arxiv) arxiv = m[1].replace(/v\d+$/, '');
      const url = l.pdf_url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      let host = '';
      try {
        host = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        continue;
      }
      pdfs.push({ url, host, source: (l.source && l.source.display_name) || host, version: label[l.version] || '', rank: rank[l.version] ?? 3 });
    }
    pdfs.sort((a, b) => a.rank - b.rank);
    return { pdfs: pdfs.map(({ rank, ...x }) => x), arxiv };
  }

  // Download the first free copy the app is allowed to fetch. Most hosts
  // don't let web apps download (or answer apps with a robot check), so this
  // often finds copies it can only link to.
  async function fetchFreePdf(p) {
    const found = await freeCopies(p);
    if (!found) throw new Error('couldn’t reach OpenAlex (offline?)');
    if (found.arxiv && !p.arxiv) {
      try {
        return { file: await fetchArxivPdf(found.arxiv), from: 'arXiv', ...found };
      } catch {}
    }
    for (const c of found.pdfs) {
      try {
        return { file: await fetchPdf(c.url), from: c.source, ...found };
      } catch {}
    }
    return { file: null, ...found };
  }

  async function fetchArxivPdf(arxivId) {
    const res = await fetch(`https://arxiv.org/pdf/${arxivId}`);
    if (!res.ok) throw new Error(`PDF download failed (${res.status})`);
    const blob = await res.blob();
    return new File([blob], `${arxivId.replace('/', '_')}.pdf`, { type: 'application/pdf' });
  }

  // Best-effort page count: the page tree root carries /Count N. Works for most
  // PDFs; ones with compressed object streams return null and the user types it.
  async function countPdfPages(blob) {
    try {
      const text = new TextDecoder('latin1').decode(await blob.arrayBuffer());
      let max = 0;
      for (const m of text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)) max = Math.max(max, +m[1]);
      for (const m of text.matchAll(/\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) max = Math.max(max, +m[1]);
      if (max) return max;
      const pages = text.match(/\/Type\s*\/Page\b(?!s)/g);
      return pages ? pages.length : null;
    } catch {
      return null;
    }
  }

  return { parse, resolve, search, byDoi, cleanTitle, isPdfUrl, fetchPdf, identifyPdf, fetchArxivPdf, countPdfPages, freeCopies, fetchFreePdf, listItems, resolveItem };
})();

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

  // Publisher pages that hide the DOI behind bot checks often still encode
  // it in the address. These DOIs are inferred, so callers treat them as a
  // guess and fall back to a title search if they don't resolve.
  function doiFromUrl(url) {
    let m;
    if ((m = /bmj\.com\/content\/[^?#]*?\b(bmj\.[a-z]?\d+)/i.exec(url))) return `10.1136/${m[1].toLowerCase()}`;
    if ((m = /nature\.com\/articles\/([a-z0-9.-]+)/i.exec(url))) return `10.1038/${m[1].replace(/\.pdf$/i, '')}`;
    // Elsevier PII in the formatted style used by The Lancet and Cell Press
    if ((m = /\/(?:PII)?(S\d{4}-\d{3}[\dX]\(\d{2}\)\d{5}-[\dX])/i.exec(url))) return `10.1016/${m[1].toUpperCase()}`;
    return null;
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

  // Page titles from the share sheet carry the site name ("… | The BMJ").
  const SITE_WORDS = /journal|nature|science|bmj|pubmed|pmc|ncbi|springer|wiley|sciencedirect|lancet|jama|plos|frontiers|arxiv|biorxiv|medrxiv|oxford|cambridge|taylor|sage|acs|ieee|acm|cell|pnas|nejm|elsevier|mdpi|researchgate|semantic scholar/i;
  function cleanTitle(t) {
    let s = (t || '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 2; i++) {
      const pipe = /^(.{8,}?)\s+\|\s+[^|]{1,60}$/.exec(s);
      const dash = /^(.{8,}?)\s+[-–—]\s+([^-–—]{1,60})$/.exec(s);
      if (pipe) s = pipe[1];
      else if (dash && SITE_WORDS.test(dash[2])) s = dash[1];
    }
    return s.replace(/\s*\[(PDF|HTML)\]\s*$/i, '').trim();
  }

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
    if (!out.doi && out.url) {
      out.doi = doiFromUrl(out.url);
      out.inferred = !!out.doi;
    }
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
      title: (Array.isArray(csl.title) ? csl.title[0] : csl.title || '').replace(/\s+/g, ' ').trim(),
      authors: (csl.author || []).map(authorName).filter(Boolean),
      year: parts[0] || null,
      venue: container || csl.publisher || '',
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
    return fromCsl(await res.json());
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
    const results = json.message.items
      .filter((it) => it.title && it.title.length)
      .map((it) => ({
        ...fromCsl(it),
        doi: it.DOI,
        score: Math.round(sim(it.title[0]) * 10),
        cites: it['is-referenced-by-count'] || 0,
        // corrections/errata often repeat the original title word for word
        notice: !!(it['update-to'] && it['update-to'].length) || /^(correction|erratum|corrigendum|retraction|expression of concern)\b/i.test(it.title[0]),
        exact: norm(it.title[0]) === norm(query),
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
      let meta;
      try {
        meta = await byDoi(ids.doi);
      } catch (err) {
        if (!ids.inferred) throw err;
        return { meta: null, ids: { ...ids, doi: null } }; // guessed DOI was wrong: let the caller search by title
      }
      if (ids.arxiv) {
        meta.arxiv = ids.arxiv;
        meta.url = `https://arxiv.org/abs/${ids.arxiv}`;
      } else if (ids.url && !meta.url) meta.url = ids.url;
      return { meta, ids };
    }
    return { meta: null, ids };
  }

  // arXiv serves PDFs with permissive CORS, so we can keep a copy offline.
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

  return { parse, resolve, search, byDoi, cleanTitle, fetchArxivPdf, countPdfPages };
})();

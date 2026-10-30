// The PaperReads helper browser extension (laptop): when installed, PDFs
// the app may not download itself are fetched through the browser, with the
// user's own access. See extension/ and Settings → Laptop helper.
const Helper = (() => {
  let version = document.documentElement.dataset.paperreadsHelper || null;
  const waiting = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'paperreads-helper-ready') version = e.data.version || '1';
    if (e.data.type === 'paperreads-helper-reply' && waiting.has(e.data.id)) {
      waiting.get(e.data.id)(e.data);
      waiting.delete(e.data.id);
    }
  });
  const available = () => !!(version || document.documentElement.dataset.paperreadsHelper);
  // the content script can start after this file: ask once more
  const ready = new Promise((resolve) => {
    if (available()) return resolve(true);
    window.postMessage({ type: 'paperreads-helper-ping' }, location.origin);
    setTimeout(() => resolve(available()), 400);
  });

  function call(msg, ms = 90000) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      const t = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('the helper didn’t answer'));
      }, ms);
      waiting.set(id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      window.postMessage({ type: 'paperreads-helper', id, ...msg }, location.origin);
    });
  }
  const toFile = (r) => {
    const bin = atob(r.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], r.name || 'paper.pdf', { type: 'application/pdf' });
  };
  async function pdf(url) {
    const r = await call({ kind: 'pdf', url });
    if (!r.ok) throw new Error(r.error || 'no PDF');
    return toFile(r);
  }
  // the publisher's PDF for a DOI: works where your network or login gives access
  async function byDoi(doi) {
    const r = await call({ kind: 'doi', doi });
    if (!r.ok) throw new Error(r.error || 'no PDF');
    return toFile(r);
  }
  return { available, ready, pdf, byDoi, get version() {
    return version || document.documentElement.dataset.paperreadsHelper || null;
  } };
})();

// Runs on the PaperReads page only: passes its PDF requests to the helper
// and the PDFs back. Nothing else crosses.
(() => {
  const version = chrome.runtime.getManifest().version;
  document.documentElement.dataset.paperreadsHelper = version;
  const announce = () => window.postMessage({ type: 'paperreads-helper-ready', version }, location.origin);
  announce();
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'paperreads-helper-ping') return announce();
    if (m.type !== 'paperreads-helper' || typeof m.id !== 'string') return;
    const request = { kind: m.kind, url: typeof m.url === 'string' ? m.url : '', doi: typeof m.doi === 'string' ? m.doi : '' };
    chrome.runtime
      .sendMessage(request)
      .then((reply) => window.postMessage({ type: 'paperreads-helper-reply', id: m.id, ...reply }, location.origin))
      .catch((err) => window.postMessage({ type: 'paperreads-helper-reply', id: m.id, ok: false, error: String(err && err.message || err) }, location.origin));
  });
})();

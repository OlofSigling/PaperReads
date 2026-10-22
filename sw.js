// Service worker: caches the app shell for offline use and receives shares.
importScripts('js/db.js');

const CACHE = 'paperreads-v29';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/db.js',
  'js/lookup.js',
  'js/app.js',
  'js/epubify.js',
  'js/backup.js',
  'js/sync.js',
  'js/ask.js',
  'js/social.js',
  'vendor/pdf.min.mjs',
  'vendor/pdf.worker.min.mjs',
  'vendor/jszip.min.js',
  'vendor/epub.min.js',
  'vendor/anthropic-sdk.min.mjs',
  'vendor/firebase.min.mjs',
  'vendor/wasm/openjpeg.wasm',
  'vendor/wasm/openjpeg_nowasm_fallback.js',
  'vendor/wasm/qcms_bg.wasm',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Android share sheet → POST multipart to ./share (see manifest share_target).
// A shared file may be a PDF or an EPUB; the Add screen sorts out which.
// Stash what was shared in IndexedDB, then hand off to the Add screen.
async function handleShare(request) {
  const form = await request.formData();
  const file = form.get('file');
  const id = await DB.put('inbox', {
    title: form.get('title') || '',
    text: form.get('text') || '',
    url: form.get('url') || '',
    file: file && file.size ? file : null,
    receivedAt: Date.now(),
  });
  return Response.redirect(`./#/add?inbox=${id}`, 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // APIs go straight to network
  // Stale-while-revalidate for the shell: instant offline, updates on next launch.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const network = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

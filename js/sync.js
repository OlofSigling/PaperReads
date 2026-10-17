// Sync between devices through the user's own Google Drive.
//
// Everything lives in the Drive "app data" folder, which only this app can
// see: one JSON file with every record, plus one file per PDF, EPUB and
// cover. A sync merges that state into this device and writes the result
// back, so each device only ever needs to talk to Drive, never to the other
// device. Per record, the newer edit wins; deletions travel as tombstones.
const Sync = (() => {
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const API = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const DATA_NAME = 'paperreads-sync.json';
  const FORMAT = 'paperreads-sync';
  const DATA_STORES = ['papers', 'progress', 'highlights', 'links', 'collections', 'settings'];
  const ROW_STORES = ['progress', 'highlights', 'links'];
  const FILE_STORES = { pdfs: 'pdf', epubs: 'epub' };
  // Rows made before sync existed get an id derived from their content, so
  // two devices restored from the same backup agree on it.
  const LEGACY = {
    progress: (r) => `${r.paperId}|${r.date}|${r.startPage ?? ''}|${r.ts}`,
    highlights: (r) => `${r.paperId}|${r.createdAt}|${r.quote}`,
    links: (r) => `${r.fromId}|${r.toId}|${r.type}`,
  };
  const TOMBSTONE_DAYS = 180;
  const TOKEN_KEY = 'paperreads.gdrive-token';

  const listeners = new Set();
  let state = { busy: false, error: null, last: null, needsSignIn: false };
  const set = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn(state));
  };

  // ---------------------------------------------------------------- auth
  // Google Identity Services gives a 1-hour access token. Asking for one may
  // open a popup, which browsers only allow right after a tap; with a token
  // still valid, syncs run on their own.
  let token = null;
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (t && t.exp > Date.now() + 60000) token = t;
  } catch {}
  const validToken = () => (token && token.exp > Date.now() + 60000 ? token.value : null);
  function forgetToken() {
    token = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {}
  }

  let gisPromise = null;
  function loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (!gisPromise)
      gisPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.onload = resolve;
        s.onerror = () => {
          gisPromise = null;
          reject(new Error('couldn’t load Google sign-in (offline?)'));
        };
        document.head.appendChild(s);
      });
    return gisPromise;
  }

  async function signIn() {
    const clientId = await DB.setting('googleClientId', '');
    if (!clientId) throw new Error('add your Google client ID in Settings first');
    await loadGis();
    const connected = await DB.setting('syncConnected', false);
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: (r) => {
          if (r.error) return reject(new Error(r.error_description || r.error));
          token = { value: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
          try {
            localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
          } catch {}
          DB.setSetting('syncConnected', true);
          resolve(token.value);
        },
        error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'sign-in was cancelled' : e.message || e.type)),
      });
      client.requestAccessToken({ prompt: connected ? '' : 'consent' });
    });
  }

  // ---------------------------------------------------------------- Drive
  class AuthError extends Error {}
  async function call(method, url, { body, headers = {}, as = 'json' } = {}) {
    const res = await fetch(url, { method, body, headers: { Authorization: `Bearer ${validToken()}`, ...headers } });
    if (res.status === 401) {
      forgetToken();
      throw new AuthError('Google sign-in expired');
    }
    if (!res.ok) {
      let msg = '';
      try {
        msg = (await res.json()).error.message;
      } catch {}
      throw new Error(`Google Drive answered ${res.status}${msg ? `: ${msg}` : ''}`);
    }
    if (as === 'response') return res;
    if (res.status === 204) return null;
    return as === 'blob' ? res.blob() : res.json();
  }

  async function listFiles() {
    const out = [];
    let page = '';
    do {
      const r = await call('GET', `${API}?spaces=appDataFolder&pageSize=1000&fields=nextPageToken,files(id,name,appProperties)${page ? `&pageToken=${page}` : ''}`);
      out.push(...r.files);
      page = r.nextPageToken || '';
    } while (page);
    return new Map(out.map((f) => [f.name, f]));
  }

  // Multipart upload: one request, metadata and content together.
  async function upload(existing, name, blob, props = {}) {
    const meta = existing ? { appProperties: props } : { name, parents: ['appDataFolder'], appProperties: props };
    const boundary = 'paperreads' + Math.random().toString(36).slice(2);
    const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`, blob, `\r\n--${boundary}--`]);
    return call(existing ? 'PATCH' : 'POST', `${UPLOAD}${existing ? '/' + existing.id : ''}?uploadType=multipart&fields=id,name,appProperties`, {
      body,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    });
  }
  const download = (file, as) => call('GET', `${API}/${file.id}?alt=media`, { as });
  const remove = (file) => call('DELETE', `${API}/${file.id}`);

  // ---------------------------------------------------------------- merge
  const time = (store, r) => (store === 'papers' ? r.updatedAt || 0 : r.mtime || r.ts || r.createdAt || r.addedAt || 0);

  async function giveLegacyRowsIds() {
    for (const s of ROW_STORES) {
      const rows = (await DB.all(s)).filter((r) => !r.sid);
      rows.forEach((r) => (r.sid = 'k:' + LEGACY[s](r)));
      if (rows.length) await DB.quietly(() => DB.putMany(s, rows));
    }
  }

  async function localStores() {
    const out = {};
    for (const s of DATA_STORES) out[s] = (await DB.all(s)).filter((r) => DB.isSynced(s, r));
    return out;
  }

  // Bring the remote state into this device. Returns how many records changed.
  async function mergeIn(remote, tomb) {
    let changes = 0;
    for (const s of DATA_STORES) {
      const local = new Map((await DB.all(s)).filter((r) => DB.isSynced(s, r)).map((r) => [DB.syncKey(s, r), r]));
      const puts = [];
      for (const r of remote.stores[s] || []) {
        const k = DB.syncKey(s, r);
        if (k == null || (tomb[`${s}:${k}`] || 0) >= time(s, r)) continue;
        const mine = local.get(k);
        if (mine && time(s, mine) >= time(s, r)) continue;
        const row = { ...r };
        // auto-numbered ids differ per device: keep this device's
        if (ROW_STORES.includes(s)) {
          if (mine) row.id = mine.id;
          else delete row.id;
        }
        puts.push(row);
      }
      const dels = [...local.entries()].filter(([k, r]) => (tomb[`${s}:${k}`] || 0) >= time(s, r)).map(([, r]) => r);
      await DB.quietly(async () => {
        if (puts.length) await DB.putMany(s, puts);
        for (const r of dels) await DB.del(s, s === 'settings' ? r.key : r.id);
      });
      changes += puts.length + dels.length;
    }
    return changes;
  }

  // ---------------------------------------------------------------- run
  let running = null;
  let again = false;
  function run(opts) {
    if (running) {
      again = true;
      return running;
    }
    running = doRun(opts).finally(() => {
      running = null;
      if (again) {
        again = false;
        schedule(2000);
      }
    });
    return running;
  }

  async function doRun({ interactive = false } = {}) {
    if (!(await DB.setting('googleClientId', ''))) return { skipped: 'not set up' };
    if (!navigator.onLine) return { skipped: 'offline' };
    if (!validToken()) {
      if (!interactive) {
        set({ needsSignIn: true });
        return { skipped: 'needs sign-in' };
      }
      await signIn();
    }
    set({ busy: true, error: null, needsSignIn: false });
    try {
      const result = await syncOnce();
      const last = Date.now();
      await DB.setSetting('syncLast', last);
      set({ busy: false, last });
      if (result.changes) Sync.onApplied && Sync.onApplied(result);
      return result;
    } catch (err) {
      if (err instanceof AuthError) set({ busy: false, needsSignIn: true, error: null });
      else set({ busy: false, error: err.message });
      throw err;
    }
  }

  async function syncOnce() {
    const withFiles = await DB.setting('syncFiles', true);
    await giveLegacyRowsIds();
    const remoteFiles = await listFiles();
    const dataFile = remoteFiles.get(DATA_NAME);
    let remote = { stores: {}, tombstones: {}, files: {} };
    if (dataFile) {
      const r = await download(dataFile, 'json');
      if (r && r.format === FORMAT) remote = r;
    }

    // tombstones from both sides; forget very old ones
    const tomb = { ...(await DB.setting('tombstones', {})) };
    for (const [k, t] of Object.entries(remote.tombstones || {})) tomb[k] = Math.max(tomb[k] || 0, t);
    const cutoff = Date.now() - TOMBSTONE_DAYS * 864e5;
    for (const k of Object.keys(tomb)) if (tomb[k] < cutoff) delete tomb[k];
    await DB.quietly(() => DB.setSetting('tombstones', tomb));

    let changes = await mergeIn(remote, tomb);

    // files: newest copy wins; download what this device lacks
    const paperIds = new Set((await DB.all('papers')).map((p) => p.id));
    const files = {};
    let downloaded = 0;
    let uploaded = 0;
    for (const [store, kind] of Object.entries(FILE_STORES)) {
      const local = new Map((await DB.all(store)).map((r) => [r.paperId, r]));
      // remote entries
      for (const [key, e] of Object.entries(remote.files || {})) {
        if (!key.startsWith(kind + ':')) continue;
        const id = key.slice(kind.length + 1);
        if (!paperIds.has(id) || (tomb[`${store}:${id}`] || 0) >= e.mtime) continue;
        files[key] = e;
        const mine = local.get(id);
        if (mine && time(store, mine) >= e.mtime) continue;
        const blobFile = remoteFiles.get(`${kind}-${id}`);
        if (!withFiles || !blobFile) continue;
        const blob = await download(blobFile, 'blob');
        const type = kind === 'pdf' ? 'application/pdf' : 'application/epub+zip';
        const rec = { paperId: id, blob: new File([blob], e.name, { type }), name: e.name, size: blob.size, addedAt: e.addedAt, mtime: e.mtime };
        if (kind === 'epub') {
          const coverFile = e.cover && remoteFiles.get(`cover-${id}`);
          Object.assign(rec, { source: e.source, missingFigures: e.missingFigures || 0, cover: coverFile ? await download(coverFile, 'blob') : null });
        }
        await DB.quietly(() => DB.put(store, rec));
        local.set(id, rec);
        downloaded++;
      }
      // files deleted elsewhere
      for (const [id, r] of local) {
        if ((tomb[`${store}:${id}`] || 0) >= time(store, r) || !paperIds.has(id)) {
          await DB.quietly(() => DB.del(store, id));
          local.delete(id);
          changes++;
        }
      }
      // this device's files that Drive lacks or has older
      for (const [id, r] of local) {
        const key = `${kind}:${id}`;
        const t = time(store, r);
        const have = files[key];
        const entry = { name: r.name, size: r.size, addedAt: r.addedAt, mtime: t };
        if (kind === 'epub') Object.assign(entry, { source: r.source || '', missingFigures: r.missingFigures || 0, cover: !!r.cover });
        if (have && have.mtime >= t && remoteFiles.has(`${kind}-${id}`)) continue;
        if (!withFiles) continue;
        await upload(remoteFiles.get(`${kind}-${id}`), `${kind}-${id}`, r.blob, { mtime: String(t) });
        if (r.cover) await upload(remoteFiles.get(`cover-${id}`), `cover-${id}`, r.cover, { mtime: String(t) });
        files[key] = entry;
        uploaded++;
      }
    }
    changes += downloaded;

    // keep each paper's hasPdf/hasEpub honest with what's stored here
    const pdfIds = new Set((await DB.all('pdfs')).map((r) => r.paperId));
    const epubIds = new Set((await DB.all('epubs')).map((r) => r.paperId));
    const fixed = (await DB.all('papers')).filter((p) => (!!p.hasPdf !== pdfIds.has(p.id) || !!p.hasEpub !== epubIds.has(p.id)) && (withFiles || pdfIds.has(p.id) || epubIds.has(p.id)));
    fixed.forEach((p) => {
      p.hasPdf = pdfIds.has(p.id);
      p.hasEpub = epubIds.has(p.id);
    });
    if (fixed.length) await DB.quietly(() => DB.putMany('papers', fixed));

    // write the merged state back
    const data = { format: FORMAT, version: 1, savedAt: new Date().toISOString(), stores: await localStores(), tombstones: tomb, files };
    await upload(dataFile, DATA_NAME, new Blob([JSON.stringify(data)], { type: 'application/json' }));

    // drop Drive copies of files that no longer exist anywhere
    for (const [name, f] of remoteFiles) {
      const m = /^(pdf|epub|cover)-(.+)$/.exec(name);
      if (!m) continue;
      const key = `${m[1] === 'cover' ? 'epub' : m[1]}:${m[2]}`;
      if (!files[key] || (m[1] === 'cover' && !files[key].cover)) await remove(f).catch(() => {});
    }
    return { changes, downloaded, uploaded };
  }

  // ---------------------------------------------------------------- triggers
  let timer = null;
  function schedule(ms = 15000) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (validToken()) run({}).catch(() => {});
    }, ms);
  }

  let started = false;
  async function start() {
    if (!(await DB.setting('googleClientId', ''))) return;
    set({ last: await DB.setting('syncLast', null) });
    DB.onChange = () => schedule();
    if (started) return;
    started = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && timer) {
        clearTimeout(timer);
        timer = null;
        if (validToken()) run({}).catch(() => {});
      } else if (document.visibilityState === 'visible') schedule(500);
    });
    window.addEventListener('online', () => schedule(1000));
    if (!running) run({}).catch(() => {});
  }

  async function disconnect() {
    clearTimeout(timer);
    DB.onChange = null;
    const t = validToken();
    if (t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t, () => {});
    forgetToken();
    await DB.setSetting('syncConnected', false);
    await DB.setSetting('googleClientId', '');
    set({ needsSignIn: false, error: null });
  }

  return {
    start,
    run,
    disconnect,
    loadGis,
    get state() {
      return state;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onApplied: null,
  };
})();

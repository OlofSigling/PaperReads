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
  // Access tokens last an hour. With the client secret, sign-in is Google's
  // code flow (a full-page visit to Google, back to oauth.html), which also
  // gives a refresh token: from then on new access tokens come silently, so
  // sync keeps running without asking. Without the secret, Google Identity
  // Services hands out 1-hour tokens only, renewed with a tap.
  const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN_URL = 'https://oauth2.googleapis.com/token';
  const RETURN_KEY = 'paperreads.oauth-return'; // written by oauth.html
  const PKCE_KEY = 'paperreads.oauth-pkce';
  const redirectUri = () => new URL('oauth.html', document.baseURI).href;
  const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

  function keepToken(j) {
    token = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
    } catch {}
  }

  async function tokenRequest(params) {
    const [clientId, secret] = await Promise.all([DB.setting('googleClientId', ''), DB.setting('googleClientSecret', '')]);
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: secret, ...params }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(j.error_description || j.error || `Google answered ${res.status}`);
      err.code = j.error;
      throw err;
    }
    return j;
  }

  // Off to Google's sign-in page; it comes back to oauth.html.
  async function startCodeFlow() {
    const clientId = await DB.setting('googleClientId', '');
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    localStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state: nonce, back: location.hash || '#/' }));
    const u = new URL(AUTH_URL);
    const q = { client_id: clientId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state: nonce, code_challenge: challenge, code_challenge_method: 'S256' };
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    location.href = u.href;
    return new Promise(() => {}); // this page is going away
  }

  // Back from Google: trade the code for tokens. Returns true if it did.
  async function finishCodeFlow() {
    let ret = null;
    let pk = null;
    try {
      ret = JSON.parse(localStorage.getItem(RETURN_KEY) || 'null');
      pk = JSON.parse(localStorage.getItem(PKCE_KEY) || 'null');
      localStorage.removeItem(RETURN_KEY);
      localStorage.removeItem(PKCE_KEY);
    } catch {}
    if (!ret) return false;
    if (ret.error) throw new Error(ret.error === 'access_denied' ? 'sign-in was cancelled' : `Google said: ${ret.error}`);
    if (!pk || ret.state !== pk.state || !ret.code) throw new Error('the sign-in reply didn’t match; try again');
    const j = await tokenRequest({ code: ret.code, code_verifier: pk.verifier, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
    keepToken(j);
    if (j.refresh_token) await DB.setSetting('googleRefreshToken', j.refresh_token);
    await DB.setSetting('syncConnected', true);
    return true;
  }

  // A fresh access token without asking, when a refresh token is stored.
  async function refresh() {
    const rt = await DB.setting('googleRefreshToken', '');
    if (!rt || !navigator.onLine) return null;
    try {
      keepToken(await tokenRequest({ refresh_token: rt, grant_type: 'refresh_token' }));
      return token.value;
    } catch (err) {
      // revoked, or expired (a Google project in "Testing" mode: after 7 days)
      if (err.code === 'invalid_grant') {
        await DB.setSetting('googleRefreshToken', '');
        set({ error: 'Google sign-in ended; tap Sync to sign in again' });
      }
      return null;
    }
  }

  async function ensureToken(interactive) {
    if (validToken()) return validToken();
    if (await refresh()) return validToken();
    if (!interactive) return null;
    if (await DB.setting('googleClientSecret', '')) return startCodeFlow();
    return signIn();
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
    let res = await fetch(url, { method, body, headers: { Authorization: `Bearer ${validToken()}`, ...headers } });
    if (res.status === 401) {
      forgetToken();
      // renew once, silently if we can
      if (!(await refresh())) throw new AuthError('Google sign-in expired');
      res = await fetch(url, { method, body, headers: { Authorization: `Bearer ${validToken()}`, ...headers } });
      if (res.status === 401) throw new AuthError('Google sign-in expired');
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
    // Google's one-request upload is for small files; big PDFs go in two steps
    if (blob.size > 4.5e6) {
      const res = await call(existing ? 'PATCH' : 'POST', `${UPLOAD}${existing ? '/' + existing.id : ''}?uploadType=resumable&fields=id,name,appProperties`, {
        body: JSON.stringify(meta),
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': blob.type || 'application/octet-stream' },
        as: 'response',
      });
      const at = res.headers.get('Location');
      if (at) {
        const put = await fetch(at, { method: 'PUT', body: blob });
        if (!put.ok) throw new Error(`Google Drive answered ${put.status} to an upload`);
        return put.json();
      }
    }
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
  // Papers merge field by field, each side's field dated by its p.ft entry
  // (records from before field dates fall back to the paper's updatedAt).
  function mergePaper(mine, theirs) {
    // (with field dates, a field never changed is oldest; without, the paper's date)
    const at = (r, k) => (r.ft ? r.ft[k] || 0 : r.updatedAt || 0);
    const out = {};
    const ft = {};
    for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      if (k === 'ft' || k === 'updatedAt') continue;
      const src = at(theirs, k) > at(mine, k) ? theirs : mine;
      if (k in src) out[k] = src[k];
      if (src.ft && src.ft[k]) ft[k] = src.ft[k];
    }
    out.ft = ft;
    out.updatedAt = Math.max(mine.updatedAt || 0, theirs.updatedAt || 0);
    return out;
  }
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
  let remotePositions = new Map();
  async function mergeIn(remote, tomb) {
    let changes = 0;
    remotePositions = new Map();
    for (const s of DATA_STORES) {
      const local = new Map((await DB.all(s)).filter((r) => DB.isSynced(s, r)).map((r) => [DB.syncKey(s, r), r]));
      const puts = [];
      for (const r of remote.stores[s] || []) {
        const k = DB.syncKey(s, r);
        if (k == null || (tomb[`${s}:${k}`] || 0) >= time(s, r)) continue;
        const mine = local.get(k);
        if (s === 'papers') {
          // remember where the other device was reading, for the reader's "jump there" offer
          if (r.epubCfi && (!mine || r.epubCfi !== mine.epubCfi)) remotePositions.set(r.id, { cfi: r.epubCfi, at: (r.ft && r.ft.epubCfi) || r.updatedAt || 0 });
          if (mine) {
            const merged = mergePaper(mine, r);
            if (JSON.stringify(merged) !== JSON.stringify(mine)) puts.push(merged);
            continue;
          }
        }
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
    if (!(await ensureToken(interactive))) {
      set({ needsSignIn: true });
      return { skipped: 'needs sign-in' };
    }
    set({ busy: true, error: null, needsSignIn: false });
    try {
      const result = await syncOnce();
      const last = Date.now();
      await DB.setSetting('syncLast', last);
      set({ busy: false, last, error: result.failed ? `${result.failed} file(s) couldn’t be synced; will retry next time` : null });
      Sync.onApplied && Sync.onApplied(result);
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
    let failed = 0;
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
        let blob;
        try {
          blob = await download(blobFile, 'blob');
        } catch (err) {
          if (err instanceof AuthError) throw err;
          failed++; // one file shouldn't stop the rest; next sync retries it
          continue;
        }
        const type = kind === 'pdf' ? 'application/pdf' : 'application/epub+zip';
        const rec = { paperId: id, blob: new File([blob], e.name, { type }), name: e.name, size: blob.size, addedAt: e.addedAt, mtime: e.mtime };
        if (kind === 'epub') {
          const coverFile = e.cover && remoteFiles.get(`cover-${id}`);
          Object.assign(rec, { source: e.source, missingFigures: e.missingFigures || 0, cover: coverFile ? await download(coverFile, 'blob').catch(() => null) : null });
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
        try {
          await upload(remoteFiles.get(`${kind}-${id}`), `${kind}-${id}`, r.blob, { mtime: String(t) });
          if (r.cover) await upload(remoteFiles.get(`cover-${id}`), `cover-${id}`, r.cover, { mtime: String(t) }).catch(() => (entry.cover = false));
          files[key] = entry;
          uploaded++;
        } catch (err) {
          if (err instanceof AuthError) throw err;
          failed++; // keep whatever Drive had; next sync retries
        }
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
    return { changes, downloaded, uploaded, failed, positions: remotePositions };
  }

  // ---------------------------------------------------------------- history
  // Drive keeps earlier versions of the sync file (about 30 days, up to 100
  // versions). Papers in those versions that this device no longer has can
  // be brought back: their details, notes, ratings, highlights and log
  // (not their PDFs and EPUBs, which sync removed from Drive).
  async function deletedInHistory(onProgress = () => {}) {
    if (!(await ensureToken(true))) throw new Error('Sign in to Google first');
    const dataFile = (await listFiles()).get(DATA_NAME);
    if (!dataFile) return [];
    const revs = [];
    let page = '';
    do {
      const r = await call('GET', `${API}/${dataFile.id}/revisions?pageSize=200&fields=nextPageToken,revisions(id,modifiedTime)${page ? `&pageToken=${page}` : ''}`);
      revs.push(...(r.revisions || []));
      page = r.nextPageToken || '';
    } while (page);
    revs.sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : -1)); // newest first
    const have = new Set((await DB.all('papers')).map((p) => p.id));
    const tomb = await DB.setting('tombstones', {});
    const found = new Map();
    for (const [i, rev] of revs.entries()) {
      onProgress(i + 1, revs.length);
      let data;
      try {
        data = await call('GET', `${API}/${dataFile.id}/revisions/${rev.id}?alt=media`);
      } catch (err) {
        if (err instanceof AuthError) throw err;
        continue;
      }
      if (!data || data.format !== FORMAT) continue;
      const st = data.stores || {};
      for (const p of st.papers || []) {
        if (have.has(p.id) || found.has(p.id)) continue; // newest version first: the first one seen is its last state
        found.set(p.id, {
          paper: p,
          rows: {
            progress: (st.progress || []).filter((r) => r.paperId === p.id),
            highlights: (st.highlights || []).filter((r) => r.paperId === p.id),
            links: (st.links || []).filter((r) => r.fromId === p.id || r.toId === p.id),
          },
          deletedAt: tomb[`papers:${p.id}`] || null,
          seenAt: Date.parse(rev.modifiedTime),
        });
      }
    }
    return [...found.values()].sort((a, b) => (b.deletedAt || b.seenAt) - (a.deletedAt || a.seenAt));
  }

  // ---------------------------------------------------------------- triggers
  let timer = null;
  function schedule(ms = 15000) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run({}).catch(() => {});
    }, ms);
  }

  let started = false;
  async function start() {
    if (!(await DB.setting('googleClientId', ''))) return;
    set({ last: await DB.setting('syncLast', null) });
    try {
      if (await finishCodeFlow()) Sync.onSignedIn && Sync.onSignedIn();
    } catch (err) {
      set({ error: `Sign-in failed: ${err.message}` });
    }
    DB.onChange = () => schedule();
    if (started) return;
    started = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && timer) {
        clearTimeout(timer);
        timer = null;
        run({}).catch(() => {});
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
    const rt = await DB.setting('googleRefreshToken', '');
    if (rt) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(rt)}`, { method: 'POST' }).catch(() => {});
    await DB.setSetting('googleRefreshToken', '');
    await DB.setSetting('googleClientSecret', '');
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
    onSignedIn: null,
    redirectUri,
    deletedInHistory,
    async staysSignedIn() {
      return !!(await DB.setting('googleRefreshToken', ''));
    },
  };
})();

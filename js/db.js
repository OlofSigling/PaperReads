// Tiny promise wrapper around IndexedDB. Loaded as a classic script so the
// service worker (importScripts) and the page share the same schema.
(function (global) {
  const DB_NAME = 'paperreads';
  const DB_VERSION = 2;

  const STORES = {
    papers: { keyPath: 'id', indexes: ['status', 'updatedAt'] },
    progress: { keyPath: 'id', autoIncrement: true, indexes: ['paperId', 'date'] },
    highlights: { keyPath: 'id', autoIncrement: true, indexes: ['paperId'] },
    links: { keyPath: 'id', autoIncrement: true, indexes: ['fromId', 'toId'] },
    collections: { keyPath: 'id' },
    pdfs: { keyPath: 'paperId' },
    epubs: { keyPath: 'paperId' },
    settings: { keyPath: 'key' },
    inbox: { keyPath: 'id', autoIncrement: true },
  };

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const [name, def] of Object.entries(STORES)) {
          if (db.objectStoreNames.contains(name)) continue;
          const store = db.createObjectStore(name, { keyPath: def.keyPath, autoIncrement: !!def.autoIncrement });
          for (const idx of def.indexes || []) store.createIndex(idx, idx);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Let a newer version (e.g. after an app update) upgrade the schema.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function tx(store, mode, fn) {
    const db = await open();
    const t = db.transaction(store, mode);
    const result = await fn(t.objectStore(store));
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
    return result;
  }

  // ---- sync bookkeeping (see js/sync.js) ----
  // Auto-numbered rows get a random sid that is the same on every device;
  // synced rows get mtime on each write; deletes leave a tombstone so they
  // can travel to other devices.
  const ROW_STORES = new Set(['progress', 'highlights', 'links']);
  const SYNCED = new Set(['papers', 'progress', 'highlights', 'links', 'collections', 'pdfs', 'epubs', 'settings']);
  const SYNCED_SETTING = /^goal:/;
  const newSid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const syncKey = (store, r) => (ROW_STORES.has(store) ? r.sid : r[STORES[store].keyPath]);
  const isSynced = (store, r) => SYNCED.has(store) && (store !== 'settings' || SYNCED_SETTING.test(r.key));
  let quiet = 0; // >0 while sync itself writes: no stamping, no change events
  function stamp(store, r) {
    if (!r || typeof r !== 'object' || quiet || !isSynced(store, r)) return;
    if (ROW_STORES.has(store) && !r.sid) r.sid = newSid();
    if (store !== 'papers') r.mtime = Date.now(); // papers carry updatedAt
  }
  function changed(store, rows) {
    if (!quiet && DB.onChange && rows.some((r) => r && isSynced(store, r))) DB.onChange(store);
  }
  async function bury(store, rows) {
    rows = rows.filter((r) => r && isSynced(store, r));
    if (quiet || !rows.length) return;
    const t = (await DB.get('settings', 'tombstones'))?.value || {};
    for (const r of rows) if (syncKey(store, r) != null) t[`${store}:${syncKey(store, r)}`] = Date.now();
    await tx('settings', 'readwrite', (s) => wrap(s.put({ key: 'tombstones', value: t })));
    changed(store, rows);
  }

  const DB = {
    open,
    get: (store, key) => tx(store, 'readonly', (s) => wrap(s.get(key))),
    all: (store) => tx(store, 'readonly', (s) => wrap(s.getAll())),
    byIndex: (store, index, value) => tx(store, 'readonly', (s) => wrap(s.index(index).getAll(value))),
    async put(store, value) {
      stamp(store, value);
      const key = await tx(store, 'readwrite', (s) => wrap(s.put(value)));
      changed(store, [value]);
      return key;
    },
    async del(store, key) {
      const row = SYNCED.has(store) ? await DB.get(store, key) : null;
      await tx(store, 'readwrite', (s) => wrap(s.delete(key)));
      if (row) await bury(store, [row]);
    },
    clear: (store) => tx(store, 'readwrite', (s) => wrap(s.clear())),
    async putMany(store, values) {
      values.forEach((v) => stamp(store, v));
      const keys = await tx(store, 'readwrite', (s) => Promise.all(values.map((v) => wrap(s.put(v)))));
      changed(store, values);
      return keys;
    },
    async delWhere(store, index, value) {
      const rows = await DB.byIndex(store, index, value);
      const key = STORES[store].keyPath;
      await tx(store, 'readwrite', (s) => Promise.all(rows.map((r) => wrap(s.delete(r[key])))));
      await bury(store, rows);
    },
    // sync's own writes: no stamps, tombstones or change events
    async quietly(fn) {
      quiet++;
      try {
        return await fn();
      } finally {
        quiet--;
      }
    },
    syncKey,
    isSynced,
    newSid,
    onChange: null,
    async setting(key, fallback) {
      const row = await DB.get('settings', key);
      return row ? row.value : fallback;
    },
    setSetting: (key, value) => DB.put('settings', { key, value }),
  };

  global.DB = DB;
})(self);

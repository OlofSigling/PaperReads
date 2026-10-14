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

  const DB = {
    open,
    get: (store, key) => tx(store, 'readonly', (s) => wrap(s.get(key))),
    all: (store) => tx(store, 'readonly', (s) => wrap(s.getAll())),
    byIndex: (store, index, value) => tx(store, 'readonly', (s) => wrap(s.index(index).getAll(value))),
    put: (store, value) => tx(store, 'readwrite', (s) => wrap(s.put(value))),
    del: (store, key) => tx(store, 'readwrite', (s) => wrap(s.delete(key))),
    putMany: (store, values) => tx(store, 'readwrite', (s) => Promise.all(values.map((v) => wrap(s.put(v))))),
    async delWhere(store, index, value) {
      const rows = await DB.byIndex(store, index, value);
      const key = STORES[store].keyPath;
      await tx(store, 'readwrite', (s) => Promise.all(rows.map((r) => wrap(s.delete(r[key])))));
    },
    async setting(key, fallback) {
      const row = await DB.get('settings', key);
      return row ? row.value : fallback;
    },
    setSetting: (key, value) => DB.put('settings', { key, value }),
  };

  global.DB = DB;
})(self);

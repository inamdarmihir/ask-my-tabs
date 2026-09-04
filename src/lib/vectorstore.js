// Flat, brute-force vector store over IndexedDB.
//
// A "real" vector database (Voy, Orama, an HNSW index) buys you sub-linear search at scale.
// A research session has a handful of open tabs and a few hundred chunks, tops -- brute-force
// cosine similarity over a plain array is microseconds at that size and has zero WASM packaging
// or index-tuning to get wrong. IndexedDB is only here so the working set survives the offscreen
// document being torn down between sessions, not for query performance.

const DB_NAME = "ask-my-tabs";
const STORE = "chunks";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("tabId", "tabId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getTabContentHash(tabId) {
  const all = await withStore("readonly", (store) => {
    return new Promise((resolve, reject) => {
      const idx = store.index("tabId");
      const req = idx.getAll(IDBKeyRange.only(tabId));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
  const rows = await all;
  return rows[0]?.contentHash ?? null;
}

export async function deleteTab(tabId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const idx = store.index("tabId");
    const req = idx.getAllKeys(IDBKeyRange.only(tabId));
    req.onsuccess = () => {
      for (const key of req.result) store.delete(key);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function putChunks(records) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const r of records) store.put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllChunks() {
  return withStore("readonly", (store) => {
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }).then((p) => p);
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // embeddings are pre-normalized, so dot product == cosine similarity
}

// Brute-force top-k search, optionally restricted to a set of tabIds (the current working set).
export async function search(queryEmbedding, { tabIds = null, topK = 5 } = {}) {
  const all = await getAllChunks();
  const pool = tabIds ? all.filter((c) => tabIds.includes(c.tabId)) : all;
  const scored = pool.map((c) => ({ ...c, score: cosine(queryEmbedding, c.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

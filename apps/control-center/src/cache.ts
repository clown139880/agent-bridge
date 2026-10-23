// The last few conversations survive a reload or a WebView the system reclaimed.
// IndexedDB rather than sessionStorage: the latter is gone once Android kills the app
// process, is synchronous, and its ~5 MB string quota is easily exceeded by tool output.
// Read only after /access succeeded, and wiped when the server rejects the login.
import type { DetailCache, DetailStore } from "./state";

const DB = "control-center", STORE = "details", KEY = "recent", MAX_AGE = 3 * 24 * 3600_000;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

/** Never blocks startup for long: a slow or unavailable IndexedDB means an empty cache. */
export async function openDetailStore(timeoutMs = 400): Promise<DetailStore> {
  let entries: DetailCache[] = [];
  try {
    const stored = await Promise.race([transact<DetailCache[] | undefined>("readonly", s => s.get(KEY)),
      new Promise<undefined>(r => setTimeout(r, timeoutMs))]);
    entries = Array.isArray(stored) ? stored.filter(e => e?.session?.sessionId && Date.now() - e.savedAt < MAX_AGE) : [];
  } catch { /* private mode or blocked storage */ }
  let queued: DetailCache[] | undefined, writing = false;
  const flush = async () => {
    writing = true;
    while (queued) { const value = queued; queued = undefined; await transact("readwrite", s => s.put(value, KEY)).catch(() => {}); }
    writing = false;
  };
  return { entries, save(value) { queued = value; if (!writing) void flush(); } };
}

export function clearDetailStore() { void transact("readwrite", s => s.delete(KEY)).catch(() => {}); }

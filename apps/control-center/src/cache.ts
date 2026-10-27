// The last few conversations survive a reload or a WebView the system reclaimed.
// IndexedDB rather than sessionStorage: the latter is gone once Android kills the app
// process, is synchronous, and its ~5 MB string quota is easily exceeded by tool output.
// Read only after /access succeeded, and wiped when the server rejects the login.
import type { DetailCache, DetailStore } from "./state";

const DB = "control-center", STORE = "details", KEY = "recent", READS = "reads", MAX_AGE = 3 * 24 * 3600_000;

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
  let entries: DetailCache[] = [], reads: Record<string, number> = {};
  const timeout = new Promise<undefined>(r => setTimeout(r, timeoutMs));
  try {
    const [stored, read] = await Promise.race([Promise.all([transact<DetailCache[] | undefined>("readonly", s => s.get(KEY)),
      transact<Record<string, number> | undefined>("readonly", s => s.get(READS))]), timeout.then(() => [undefined, undefined] as const)]);
    // Details cached before 0.7.25 hold raw events instead of a view; they are dropped, not migrated.
    entries = Array.isArray(stored) ? stored.filter(e => e?.session?.sessionId && Array.isArray(e.view?.entries) && Date.now() - e.savedAt < MAX_AGE) : [];
    if (read && typeof read === "object") reads = Object.fromEntries(Object.entries(read).filter(([, n]) => typeof n === "number"));
  } catch { /* private mode or blocked storage */ }
  // Last write wins per key; writes never overlap.
  const queued = new Map<string, unknown>();
  let writing = false;
  const flush = async () => {
    writing = true;
    while (queued.size) {
      const [key, value] = queued.entries().next().value!; queued.delete(key);
      await transact("readwrite", s => s.put(value, key)).catch(() => {});
    }
    writing = false;
  };
  const put = (key: string, value: unknown) => { queued.set(key, value); if (!writing) void flush(); };
  return { entries, reads, save: value => put(KEY, value), saveReads: value => put(READS, value) };
}

export function clearDetailStore() { void transact("readwrite", s => s.clear()).catch(() => {}); }

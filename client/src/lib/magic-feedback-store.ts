// =============================================================================
// Magic feedback — where a recording waits out a real page load.
//
// IndexedDB database `magic-feedback`, object store `session`, ONE record per
// browser tab under the id kept in sessionStorage["mf-tab"], so two tabs never
// resume each other's recording. Every access is wrapped: when storage is
// unavailable (private mode, blocked site data) these resolve to nothing and
// the widget simply works in memory, as it did before.
// =============================================================================
import type { SessionRecord } from "./magic-feedback";

const DB_NAME = "magic-feedback";
const STORE = "session";
const TAB_KEY = "mf-tab";

let tabIdCache: string | null | undefined;

/** This tab's id, made once and kept for the life of the tab; null without sessionStorage. */
export function tabId(): string | null {
  if (tabIdCache !== undefined) return tabIdCache;
  try {
    let id = sessionStorage.getItem(TAB_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : Date.now().toString(36) + Math.random().toString(36).slice(2);
      sessionStorage.setItem(TAB_KEY, id);
    }
    tabIdCache = id;
  } catch {
    tabIdCache = null;
  }
  return tabIdCache;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>(resolve => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE))
          req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore, key: string) => IDBRequest<T>
): Promise<T | null> {
  const key = tabId();
  if (!key) return Promise.resolve(null);
  return openDb().then(
    db =>
      new Promise<T | null>(resolve => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE, mode);
          const req = op(tx.objectStore(STORE), key);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      })
  );
}

/** Whatever this tab left behind, unvalidated (readRecord in magic-feedback.ts judges it). */
export function loadSession(): Promise<unknown> {
  return run<unknown>("readonly", (s, k) => s.get(k));
}

export async function saveSession(rec: SessionRecord): Promise<void> {
  await run("readwrite", (s, k) => s.put(rec, k));
}

export async function clearSession(): Promise<void> {
  await run("readwrite", (s, k) => s.delete(k));
}

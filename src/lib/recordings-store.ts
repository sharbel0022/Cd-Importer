import type { Bitrate } from "./types";

export const MAX_RECORDINGS = 20;
export const MAX_STORAGE_BYTES = 100 * 1024 * 1024;
const DATABASE = "ton-recordings";
const STORE = "recordings";

export interface StoredRecording {
  id: string;
  title: string;
  filename: string;
  createdAt: number;
  duration: number;
  bitrate: Bitrate;
  blob: Blob;
}

function storageError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "QuotaExceededError") return new Error("Webbläsarens lagringsutrymme är fullt. Ta bort en inspelning eller ladda ner MP3-filen direkt.");
  if (error instanceof Error && !(error instanceof DOMException)) return error;
  return new Error("Inspelningen kunde inte lagras i webbläsaren. Tillåt lokal lagring eller ladda ner MP3-filen direkt.");
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("Webbläsaren saknar lokal lagring för inspelningar. Du kan ändå ladda ner din MP3.")); return; }
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DATABASE, 1); }
    catch (error) { reject(storageError(error)); return; }
    let settled = false;
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" }); };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => { settled = true; reject(storageError(request.error)); };
    request.onblocked = () => { settled = true; reject(new Error("Lagringen är låst av en annan flik. Stäng andra flikar med appen och försök igen.")); };
  });
}

export function isStoredRecording(value: unknown): value is StoredRecording {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<StoredRecording>;
  return typeof item.id === "string" && item.id.length > 0 && typeof item.title === "string" && item.title.length > 0 && item.title.length <= 150 &&
    typeof item.filename === "string" && item.filename.endsWith(".mp3") &&
    typeof item.createdAt === "number" && Number.isFinite(item.createdAt) && item.createdAt > 0 &&
    typeof item.duration === "number" && Number.isFinite(item.duration) && item.duration >= 0 &&
    [128, 192, 256, 320].includes(item.bitrate ?? 0) && item.blob instanceof Blob && item.blob.size > 0 && item.blob.type === "audio/mpeg";
}

export async function listRecordings(): Promise<StoredRecording[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = database.transaction(STORE, "readonly"); }
    catch (error) { database.close(); reject(storageError(error)); return; }
    const request = transaction.objectStore(STORE).getAll();
    transaction.oncomplete = () => { database.close(); resolve((request.result as unknown[]).filter(isStoredRecording).sort((a, b) => b.createdAt - a.createdAt)); };
    transaction.onabort = () => { database.close(); reject(storageError(transaction.error)); };
    transaction.onerror = () => { /* The abort handler reports failed transactions. */ };
  });
}

/** Count and size checks share the write transaction, including across tabs. */
export async function saveRecording(recording: StoredRecording): Promise<void> {
  if (!isStoredRecording(recording)) throw new Error("MP3-inspelningen saknar giltig information och kunde inte sparas.");
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = database.transaction(STORE, "readwrite"); }
    catch (error) { database.close(); reject(storageError(error)); return; }
    let failure: Error | undefined;
    const store = transaction.objectStore(STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const existing = (request.result as unknown[]).filter(isStoredRecording).filter((item) => item.id !== recording.id);
      if (existing.length >= MAX_RECORDINGS) failure = new Error(`Du kan spara högst ${MAX_RECORDINGS} inspelningar. Ta bort en inspelning eller ladda ner MP3-filen direkt.`);
      else if (existing.reduce((total, item) => total + item.blob.size, recording.blob.size) > MAX_STORAGE_BYTES) failure = new Error("Dina sparade inspelningar får vara högst 100 MB tillsammans. Ta bort en inspelning eller ladda ner MP3-filen direkt.");
      if (failure) transaction.abort();
      else store.put(recording);
    };
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onabort = () => { database.close(); reject(failure ?? storageError(transaction.error)); };
    transaction.onerror = () => { /* The abort handler reports failed transactions. */ };
  });
}

export async function deleteRecording(id: string): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = database.transaction(STORE, "readwrite"); }
    catch (error) { database.close(); reject(storageError(error)); return; }
    transaction.objectStore(STORE).delete(id);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onabort = () => { database.close(); reject(storageError(transaction.error)); };
    transaction.onerror = () => { /* The abort handler reports failed transactions. */ };
  });
}

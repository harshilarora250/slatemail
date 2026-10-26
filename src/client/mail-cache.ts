import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { MailDraft, MailThread } from "@/domain/mail";

export type MailOperationAction = "read" | "unread" | "star" | "unstar" | "archive" | "trash";
export interface PendingMailOperation {
  id: string;
  threadId: string;
  action: MailOperationAction;
  createdAt: number;
}

interface SlateMailDB extends DBSchema {
  threads: {
    key: string;
    value: MailThread & { cachedAt: number };
    indexes: { "by-cached-at": number };
  };
  drafts: {
    key: string;
    value: MailDraft;
    indexes: { "by-updated-at": number };
  };
  metadata: { key: string; value: string | number };
  operations: { key: string; value: PendingMailOperation; indexes: { "by-created-at": number } };
}

let database: Promise<IDBPDatabase<SlateMailDB>> | undefined;
const MAX_CACHED_THREADS = 200;
const MAX_CACHED_THREAD_MESSAGES = 50;
const MAX_CACHED_BODY_CHARACTERS = 256_000;

function boundThread(thread: MailThread): MailThread {
  const messages = thread.messages.slice(-MAX_CACHED_THREAD_MESSAGES);
  let remaining = MAX_CACHED_BODY_CHARACTERS;
  const boundedFromNewest = [...messages].reverse().map((message) => {
    let textBody: string | undefined;
    let safeHtmlBody: string | undefined;
    if (remaining > 0 && message.textBody) {
      textBody = message.textBody.slice(0, remaining);
      remaining -= textBody.length;
    }
    if (remaining > 0 && message.safeHtmlBody && message.safeHtmlBody.length <= remaining) {
      safeHtmlBody = message.safeHtmlBody;
      remaining -= safeHtmlBody.length;
    }
    return { ...message, textBody, safeHtmlBody };
  }).reverse();
  return { ...thread, messages: boundedFromNewest };
}

function getDatabase(): Promise<IDBPDatabase<SlateMailDB>> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("The local mail cache is available only in a browser."));
  }
  database ??= openDB<SlateMailDB>("slatemail-cache-v1", 3, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const threads = db.createObjectStore("threads", { keyPath: "id" });
        threads.createIndex("by-cached-at", "cachedAt");
        const drafts = db.createObjectStore("drafts", { keyPath: "id" });
        drafts.createIndex("by-updated-at", "updatedAt");
        db.createObjectStore("metadata");
      }
      if (oldVersion < 2) {
        const operations = db.createObjectStore("operations", { keyPath: "id" });
        operations.createIndex("by-created-at", "createdAt");
      }
      if (oldVersion < 3) {
        const legacyDatabase = db as unknown as IDBDatabase;
        if (legacyDatabase.objectStoreNames.contains("messages")) legacyDatabase.deleteObjectStore("messages");
      }
    },
  });
  return database;
}

export async function cacheThreads(threads: MailThread[], maxThreads = MAX_CACHED_THREADS): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction("threads", "readwrite");
  const cachedAt = Date.now();
  for (const thread of threads) {
    const previous = await tx.store.get(thread.id);
    const oldMessages = new Map((previous?.messages ?? []).map((message) => [message.id, message]));
    const merged: MailThread = {
      ...thread,
      messages: thread.messages.map((message) => {
        const cached = oldMessages.get(message.id);
        return cached ? {
          ...cached,
          ...message,
          textBody: message.textBody ?? cached.textBody,
          safeHtmlBody: message.safeHtmlBody ?? cached.safeHtmlBody,
          attachments: message.attachments.length ? message.attachments : cached.attachments,
        } : message;
      }),
    };
    await tx.store.put({ ...boundThread(merged), cachedAt });
  }
  const all = await tx.store.index("by-cached-at").getAllKeys();
  if (all.length > maxThreads) {
    for (const key of all.slice(0, all.length - maxThreads)) await tx.store.delete(key);
  }
  await tx.done;
}

export async function getCachedThreads(): Promise<MailThread[]> {
  const db = await getDatabase();
  const cached = await db.getAll("threads");
  return cached.sort((a, b) => b.messages[0]?.date.localeCompare(a.messages[0]?.date ?? "") ?? 0);
}

export async function cacheThread(thread: MailThread): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction("threads", "readwrite");
  await tx.objectStore("threads").put({ ...boundThread(thread), cachedAt: Date.now() });
  await tx.done;
}

export async function getCachedThread(id: string): Promise<MailThread | undefined> {
  const db = await getDatabase();
  return db.get("threads", id);
}

export async function saveDraft(draft: MailDraft): Promise<void> {
  const db = await getDatabase();
  await db.put("drafts", draft);
}

export async function getDrafts(): Promise<MailDraft[]> {
  const db = await getDatabase();
  return (await db.getAll("drafts")).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function removeDraft(id: string): Promise<void> {
  const db = await getDatabase();
  await db.delete("drafts", id);
}

export async function queueMailOperation(operation: Omit<PendingMailOperation, "id" | "createdAt">): Promise<void> {
  const db = await getDatabase();
  await db.put("operations", { ...operation, id: crypto.randomUUID(), createdAt: Date.now() });
}

export async function getPendingMailOperations(): Promise<PendingMailOperation[]> {
  const db = await getDatabase();
  return db.getAllFromIndex("operations", "by-created-at");
}

export async function removeMailOperation(id: string): Promise<void> {
  const db = await getDatabase();
  await db.delete("operations", id);
}

export async function clearMailCache(): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction(["threads", "metadata", "operations"], "readwrite");
  await Promise.all([
    tx.objectStore("threads").clear(),
    tx.objectStore("metadata").clear(),
    tx.objectStore("operations").clear(),
  ]);
  await tx.done;
}

export async function clearCachedMessages(): Promise<void> {
  const db = await getDatabase();
  await db.clear("threads");
}

export async function clearAllLocalData(): Promise<void> {
  const db = await getDatabase();
  await db.clear("threads");
  await db.clear("drafts");
  await db.clear("metadata");
  await db.clear("operations");
}

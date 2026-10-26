import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getThread, getProfile, listHistory } from "@/providers/gmail/gmail-provider";
import database from "@/server/db";
import { getSessionAccount, verifySameOrigin } from "@/server/session";
import { failure, invalidSession, readJson } from "@/server/http";
import { historyCursorExpired, requiresHistoryRebuild } from "@/domain/sync-policy";

export const runtime = "nodejs";

const activeSyncs = new Set<string>();

function isExpiredHistory(error: unknown): boolean {
  return historyCursorExpired((error as { response?: { status?: number } } | null)?.response?.status);
}

export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request)) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  const lockKey = account.sub;
  if (activeSyncs.has(lockKey)) return NextResponse.json({ syncing: true }, { status: 202, headers: { "Retry-After": "10" } });
  activeSyncs.add(lockKey);

  try {
    z.object({ mailbox: z.string().max(120).optional() }).parse(await readJson(request));
    const current = database.prepare("SELECT history_id FROM sync_state WHERE account_sub = ?")
      .get(account.sub) as { history_id: string | null } | undefined;
    const profile = await getProfile(account);
    if (!current?.history_id) {
      database.prepare(`INSERT INTO sync_state(account_sub, history_id, last_synced_at) VALUES (?, ?, ?)
        ON CONFLICT(account_sub) DO UPDATE SET history_id = excluded.history_id, last_synced_at = excluded.last_synced_at`)
        .run(account.sub, profile.historyId, Date.now());
      return NextResponse.json({ initialized: true, lastSyncedAt: Date.now() });
    }

    let history: Awaited<ReturnType<typeof listHistory>>;
    try {
      history = await listHistory(account, current.history_id);
    } catch (error) {
      if (!isExpiredHistory(error)) throw error;
      database.prepare("UPDATE sync_state SET history_id = ?, last_synced_at = ? WHERE account_sub = ?")
        .run(profile.historyId, Date.now(), account.sub);
      return NextResponse.json({ resetRequired: true, lastSyncedAt: Date.now() });
    }

    const threadIds = new Set<string>();
    const changedMessageIds = new Set<string>();
    const deletedMessageIds = new Set<string>();
    for (const entry of history.history ?? []) {
      const messages = [
        ...(entry.messagesAdded ?? []).flatMap((item) => item.message ? [item.message] : []),
        ...(entry.messagesDeleted ?? []).flatMap((item) => item.message ? [item.message] : []),
        ...(entry.labelsAdded ?? []).flatMap((item) => item.message ? [item.message] : []),
        ...(entry.labelsRemoved ?? []).flatMap((item) => item.message ? [item.message] : []),
      ];
      for (const event of messages) {
        if (event.threadId) threadIds.add(event.threadId);
        if (event.id) changedMessageIds.add(event.id);
      }
      for (const event of entry.messagesDeleted ?? []) if (event.message?.id) deletedMessageIds.add(event.message.id);
    }

    if (requiresHistoryRebuild(threadIds.size)) {
      database.prepare("UPDATE sync_state SET history_id = ?, last_synced_at = ? WHERE account_sub = ?")
        .run(profile.historyId, Date.now(), account.sub);
      return NextResponse.json({ resetRequired: true, lastSyncedAt: Date.now() });
    }

    const refreshed = await Promise.all([...threadIds].map(async (threadId) => {
      try { return await getThread(account, threadId); }
      catch (error) { if (isExpiredHistory(error)) return null; throw error; }
    }));
    const nextHistoryId = history.historyId ?? profile.historyId;
    const now = Date.now();
    database.prepare(`INSERT INTO sync_state(account_sub, history_id, last_synced_at) VALUES (?, ?, ?)
      ON CONFLICT(account_sub) DO UPDATE SET history_id = excluded.history_id, last_synced_at = excluded.last_synced_at`)
      .run(account.sub, nextHistoryId, now);
    return NextResponse.json({
      threads: refreshed.filter((thread): thread is NonNullable<typeof thread> => thread !== null),
      deletedMessageIds: [...deletedMessageIds],
      changedMessageIds: [...changedMessageIds],
      lastSyncedAt: now,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error, "Gmail sync failed. Your local cache has not been cleared.");
  } finally {
    activeSyncs.delete(lockKey);
  }
}

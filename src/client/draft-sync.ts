"use client";

import { getDrafts, saveDraft } from "@/client/mail-cache";

let syncing = false;

export async function syncPendingDrafts(excludedId?: string): Promise<void> {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  try {
    const drafts = await getDrafts();
    for (const draft of drafts) {
      if (draft.id === excludedId || draft.revision === 0 || !["local", "pending"].includes(draft.status)) continue;
      const response = await fetch("/api/mail/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          localDraftId: draft.id,
          draftId: draft.remoteId,
          expectedVersion: draft.remoteVersion,
          threadId: draft.threadId,
          inReplyTo: draft.inReplyTo,
          references: draft.references,
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          body: draft.body,
          attachments: draft.attachments ?? [],
        }),
      });
      const value = await response.json() as { error?: string; id?: string; version?: string; remoteVersion?: string };
      if (response.status === 409) {
        await saveDraft({ ...draft, status: "conflict", conflictingRemoteVersion: value.remoteVersion });
        continue;
      }
      if (!response.ok || !value.id) break;
      await saveDraft({ ...draft, remoteId: value.id, remoteVersion: value.version, conflictingRemoteVersion: undefined, status: "synced" });
    }
  } catch { /* Keep local versions and retry on a later connection/sync event. */ }
  finally { syncing = false; }
}

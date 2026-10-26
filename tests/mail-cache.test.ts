// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  cacheThread, cacheThreads, clearAllLocalData, getCachedThread, getDrafts,
  getPendingMailOperations, queueMailOperation, removeMailOperation, saveDraft,
} from "@/client/mail-cache";
import type { MailDraft, MailThread } from "@/domain/mail";

describe("IndexedDB cache and offline recovery", () => {
  it("keeps opened bodies during summary refresh and persists local drafts and queued actions", async () => {
    const summary: MailThread = {
      id: "thread-one", snippet: "A preview", messages: [{
        id: "message-one", threadId: "thread-one", from: { name: "Ada", email: "ada@example.test" }, to: [], cc: [],
        subject: "Hello", snippet: "A preview", date: new Date(0).toISOString(), unread: true, starred: false,
        labels: ["INBOX"], hasAttachments: false, attachments: [],
      }],
    };
    await cacheThreads([summary]);
    await cacheThread({ ...summary, messages: [{ ...summary.messages[0]!, textBody: "Cached message body" }] });
    await cacheThreads([{ ...summary, snippet: "Updated preview" }]);
    expect((await getCachedThread(summary.id))?.messages[0]?.textBody).toBe("Cached message body");

    const draft: MailDraft = {
      id: "local-draft-1", to: "", cc: "", bcc: "", subject: "", body: "Recover me",
      updatedAt: Date.now(), revision: 1, status: "pending",
    };
    await saveDraft(draft);
    expect(await getDrafts()).toMatchObject([{ id: draft.id, body: "Recover me", status: "pending" }]);

    await queueMailOperation({ threadId: summary.id, action: "archive" });
    const [operation] = await getPendingMailOperations();
    expect(operation).toMatchObject({ threadId: summary.id, action: "archive" });
    await removeMailOperation(operation!.id);
    expect(await getPendingMailOperations()).toHaveLength(0);
    await clearAllLocalData();
  });
});

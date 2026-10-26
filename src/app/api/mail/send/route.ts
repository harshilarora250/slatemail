import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildRawMessage, sendDraft, sendRawMessage } from "@/providers/gmail/gmail-provider";
import database from "@/server/db";
import { getSessionAccount, verifySameOrigin } from "@/server/session";
import { failure, invalidSession, readJson } from "@/server/http";
import { sendAttemptDisposition } from "@/domain/send-attempt";
import { allowRequests } from "@/server/rate-limit";

export const runtime = "nodejs";

const sendSchema = z.object({
  attemptId: z.string().uuid(),
  draftId: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_-]+$/),
  remoteDraftId: z.string().max(256).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  to: z.string().min(1).max(2048),
  cc: z.string().max(2048).optional(),
  bcc: z.string().max(2048).optional(),
  subject: z.string().max(998),
  body: z.string().max(2_000_000),
  threadId: z.string().max(256).optional(),
  inReplyTo: z.string().max(998).optional(),
  references: z.string().max(4096).optional(),
  attachments: z.array(z.object({
    name: z.string().min(1).max(180),
    mimeType: z.string().max(120),
    data: z.string().max(27_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/),
    size: z.number().int().min(0).max(20_000_000),
  })).max(10).default([]),
}).superRefine((message, context) => {
  if (message.attachments.reduce((total, attachment) => total + attachment.size, 0) > 20_000_000) {
    context.addIssue({ code: "custom", message: "Attachments exceed the 20 MB total limit." });
  }
  for (const [index, attachment] of message.attachments.entries()) {
    if (attachment.data.length !== Math.ceil(attachment.size / 3) * 4) {
      context.addIssue({ code: "custom", path: ["attachments", index, "data"], message: "Attachment data is malformed." });
    }
  }
  if (message.attachments.reduce((total, attachment) => total + attachment.data.length, 0) > 27_000_000) {
    context.addIssue({ code: "custom", message: "Encoded attachments exceed the 20 MB total limit." });
  }
});

export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request)) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  if (!allowRequests(`mail-send:${account.sub}`, 20, 60_000)) return NextResponse.json({ error: "Send rate limit reached. Wait a minute before sending more mail." }, { status: 429 });
  try {
    const input = sendSchema.parse(await readJson(request, 30_000_000));
    if (input.remoteDraftId) {
      const mapping = database.prepare("SELECT gmail_draft_id, status FROM draft_sync WHERE account_sub = ? AND local_draft_id = ?")
        .get(account.sub, input.draftId) as { gmail_draft_id: string | null; status: string } | undefined;
      const mapped = mapping?.gmail_draft_id === input.remoteDraftId && mapping.status === "synced";
      const explicitlyOpenedGmailDraft = input.draftId === `remote-${input.remoteDraftId}`;
      if (!mapped && !explicitlyOpenedGmailDraft) {
        return NextResponse.json({ error: "The Gmail draft reference could not be verified. Reopen the draft before sending." }, { status: 409 });
      }
    }
    const existing = database.prepare("SELECT status, gmail_message_id FROM send_attempts WHERE account_sub = ? AND attempt_id = ?")
      .get(account.sub, input.attemptId) as { status: string; gmail_message_id: string | null } | undefined;
    const disposition = sendAttemptDisposition(existing?.status);
    if (disposition === "already-sent") return NextResponse.json({ sent: true, messageId: existing?.gmail_message_id, duplicateRequest: true });
    if (disposition === "uncertain") {
      return NextResponse.json({ error: "The previous send result is uncertain. Check Gmail Sent before trying again." }, { status: 409 });
    }

    const now = Date.now();
    database.prepare(`
      INSERT INTO send_attempts(account_sub, attempt_id, draft_id, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(account_sub, attempt_id) DO UPDATE SET status = 'pending', updated_at = excluded.updated_at
    `).run(account.sub, input.attemptId, input.draftId, now, now);

    try {
      const result = input.remoteDraftId
        ? await sendDraft(account, input.remoteDraftId)
        : await sendRawMessage(account, buildRawMessage(input), input.threadId);
      database.prepare("UPDATE send_attempts SET status = 'sent', gmail_message_id = ?, updated_at = ? WHERE account_sub = ? AND attempt_id = ?")
        .run(result.id, Date.now(), account.sub, input.attemptId);
      database.prepare("DELETE FROM draft_sync WHERE account_sub = ? AND local_draft_id = ?").run(account.sub, input.draftId);
      return NextResponse.json({ sent: true, messageId: result.id, threadId: result.threadId });
    } catch (error) {
      const status = (error as { response?: { status?: number } } | null)?.response?.status;
      const definitiveFailure = typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
      database.prepare("UPDATE send_attempts SET status = ?, updated_at = ? WHERE account_sub = ? AND attempt_id = ?")
        .run(definitiveFailure ? "failed" : "uncertain", Date.now(), account.sub, input.attemptId);
      throw error;
    }
  } catch (error) {
    return failure(error, "Gmail did not confirm that this message was sent. Your draft is preserved.");
  }
}

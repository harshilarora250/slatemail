import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createOrUpdateDraft, deleteDraft, getDraftCount, getDraftForEdit, listDrafts } from "@/providers/gmail/gmail-provider";
import database from "@/server/db";
import { getSessionAccount, verifySameOrigin } from "@/server/session";
import { failure, invalidSession, readJson } from "@/server/http";

export const runtime = "nodejs";

const draftSchema = z.object({
  localDraftId: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_-]+$/),
  draftId: z.string().max(256).optional(),
  to: z.string().max(2048).default(""),
  cc: z.string().max(2048).optional(),
  bcc: z.string().max(2048).optional(),
  subject: z.string().max(998).default(""),
  body: z.string().max(2_000_000),
  threadId: z.string().max(256).optional(),
  inReplyTo: z.string().max(998).optional(),
  references: z.string().max(4096).optional(),
  expectedVersion: z.string().max(256).optional(),
  attachments: z.array(z.object({
    name: z.string().min(1).max(180),
    mimeType: z.string().max(120),
    data: z.string().max(27_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/),
    size: z.number().int().min(0).max(20_000_000),
  })).max(10).default([]),
}).superRefine((draft, context) => {
  if (draft.attachments.reduce((total, attachment) => total + attachment.size, 0) > 20_000_000) {
    context.addIssue({ code: "custom", message: "Attachments exceed the 20 MB total limit." });
  }
  for (const [index, attachment] of draft.attachments.entries()) {
    if (attachment.data.length !== Math.ceil(attachment.size / 3) * 4) {
      context.addIssue({ code: "custom", path: ["attachments", index, "data"], message: "Attachment data is malformed." });
    }
  }
  if (draft.attachments.reduce((total, attachment) => total + attachment.data.length, 0) > 27_000_000) {
    context.addIssue({ code: "custom", message: "Encoded attachments exceed the 20 MB total limit." });
  }
});

function contentMatches(remote: Awaited<ReturnType<typeof listDrafts>>[number], input: z.infer<typeof draftSchema>): boolean {
  const normalize = (value: string | undefined) => (value ?? "").trim();
  const remoteAttachments = [...remote.attachments].map((file) => `${file.filename}:${file.size}`).sort();
  const localAttachments = input.attachments.map((file) => `${file.name}:${file.size}`).sort();
  return normalize(remote.to) === normalize(input.to)
    && normalize(remote.cc) === normalize(input.cc)
    && normalize(remote.bcc) === normalize(input.bcc)
    && normalize(remote.subject) === normalize(input.subject)
    && normalize(remote.body) === normalize(input.body)
    && remoteAttachments.join("|") === localAttachments.join("|");
}

function conflict(remoteVersion?: string) {
  return NextResponse.json({ error: "A newer Gmail draft exists. Your local copy was preserved.", remoteVersion }, { status: 409 });
}

export async function GET(request: NextRequest) {
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  try {
    if (request.nextUrl.searchParams.get("countOnly") === "1") {
      return NextResponse.json({ count: await getDraftCount(account) }, { headers: { "Cache-Control": "no-store" } });
    }
    const draftId = request.nextUrl.searchParams.get("draftId");
    if (draftId) {
      if (!/^[a-zA-Z0-9_-]{1,256}$/.test(draftId)) return NextResponse.json({ error: "Invalid draft identifier." }, { status: 400 });
      return NextResponse.json(await getDraftForEdit(account, draftId), { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ drafts: await listDrafts(account) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error, "Unable to load Gmail drafts.");
  }
}

export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request)) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  let localDraftId: string | undefined;
  try {
    const input = draftSchema.parse(await readJson(request, 30_000_000));
    localDraftId = input.localDraftId;
    const mapping = database.prepare("SELECT gmail_draft_id, remote_version, status FROM draft_sync WHERE account_sub = ? AND local_draft_id = ?")
      .get(account.sub, input.localDraftId) as { gmail_draft_id: string | null; remote_version: string | null; status: string } | undefined;
    let gmailDraftId = mapping?.gmail_draft_id ?? input.draftId;

    if (mapping?.status === "pending" || mapping?.status === "uncertain") {
      const remoteDrafts = await listDrafts(account);
      const remote = remoteDrafts.find((draft) => draft.clientDraftId === input.localDraftId || (gmailDraftId && draft.id === gmailDraftId));
      if (!remote) return conflict();
      if (contentMatches(remote, input)) {
        database.prepare("UPDATE draft_sync SET gmail_draft_id = ?, remote_version = ?, status = 'synced', updated_at = ? WHERE account_sub = ? AND local_draft_id = ?")
          .run(remote.id, remote.version, Date.now(), account.sub, input.localDraftId);
        return NextResponse.json({ id: remote.id, version: remote.version, reconciled: true }, { headers: { "Cache-Control": "no-store" } });
      }
      if (mapping.remote_version && mapping.remote_version !== remote.version) return conflict(remote.version);
      gmailDraftId = remote.id;
    }

    if (mapping?.gmail_draft_id && input.draftId && mapping.gmail_draft_id !== input.draftId) return conflict(mapping.remote_version ?? undefined);
    const now = Date.now();
    database.prepare(`INSERT INTO draft_sync(account_sub, local_draft_id, gmail_draft_id, remote_version, status, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(account_sub, local_draft_id) DO UPDATE SET gmail_draft_id = excluded.gmail_draft_id,
        remote_version = excluded.remote_version, status = 'pending', updated_at = excluded.updated_at`)
      .run(account.sub, input.localDraftId, gmailDraftId ?? null, input.expectedVersion ?? mapping?.remote_version ?? null, now);
    const result = await createOrUpdateDraft(account, { ...input, draftId: gmailDraftId });
    database.prepare("UPDATE draft_sync SET gmail_draft_id = ?, remote_version = ?, status = 'synced', updated_at = ? WHERE account_sub = ? AND local_draft_id = ?")
      .run(result.id, result.version ?? null, Date.now(), account.sub, input.localDraftId);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    if (status === 409) {
      const remoteVersion = (error as { remoteVersion?: string }).remoteVersion;
      if (localDraftId) {
        database.prepare("UPDATE draft_sync SET remote_version = ?, status = 'conflict', updated_at = ? WHERE account_sub = ? AND local_draft_id = ?")
          .run(remoteVersion ?? null, Date.now(), account.sub, localDraftId);
      }
      return conflict(remoteVersion);
    }
    if (localDraftId) {
      const definitiveFailure = typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
      database.prepare("UPDATE draft_sync SET status = ?, updated_at = ? WHERE account_sub = ? AND local_draft_id = ?")
        .run(definitiveFailure ? "failed" : "uncertain", Date.now(), account.sub, localDraftId);
    }
    return failure(error, "Gmail did not confirm that the draft was saved.");
  }
}

export async function DELETE(request: NextRequest) {
  if (!verifySameOrigin(request)) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  try {
    const input = z.object({ draftId: z.string().min(1).max(256) }).parse(await readJson(request));
    await deleteDraft(account, input.draftId);
    database.prepare("DELETE FROM draft_sync WHERE account_sub = ? AND gmail_draft_id = ?").run(account.sub, input.draftId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return failure(error, "Gmail did not confirm that the draft was deleted.");
  }
}

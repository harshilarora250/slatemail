import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getThread, modifyThread, trashThread } from "@/providers/gmail/gmail-provider";
import { getSessionAccount, verifySameOrigin } from "@/server/session";
import { failure, invalidSession, readJson } from "@/server/http";

export const runtime = "nodejs";

const actionSchema = z.object({ action: z.enum(["read", "unread", "star", "unstar", "archive", "trash"]) });

export async function GET(request: NextRequest, context: { params: Promise<{ threadId: string }> }) {
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  const { threadId } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(threadId)) return NextResponse.json({ error: "Invalid thread identifier." }, { status: 400 });
  try {
    return NextResponse.json(await getThread(account, threadId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error, "Unable to open this conversation.");
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ threadId: string }> }) {
  if (!verifySameOrigin(request)) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  const { threadId } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(threadId)) return NextResponse.json({ error: "Invalid thread identifier." }, { status: 400 });
  try {
    const { action } = actionSchema.parse(await readJson(request));
    if (action === "trash") await trashThread(account, threadId);
    else await modifyThread(account, threadId, action);
    return NextResponse.json({ success: true, action, threadId });
  } catch (error) {
    return failure(error, "Gmail did not confirm that mailbox change.");
  }
}

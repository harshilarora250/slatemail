import { NextRequest, NextResponse } from "next/server";
import { downloadAttachment, getThread } from "@/providers/gmail/gmail-provider";
import { getSessionAccount } from "@/server/session";
import { failure, invalidSession } from "@/server/http";

export const runtime = "nodejs";

function safeFilename(value: string): string {
  return value.replace(/[\r\n"\\/]/g, "_").replace(/[^\x20-\x7e]/g, "_").slice(0, 180) || "attachment";
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ threadId: string; attachmentId: string }> },
) {
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  const { threadId, attachmentId } = await context.params;
  const messageId = request.nextUrl.searchParams.get("messageId") ?? "";
  if (![threadId, attachmentId, messageId].every((value) => /^[a-zA-Z0-9_-]{1,256}$/.test(value))) {
    return NextResponse.json({ error: "Invalid attachment reference." }, { status: 400 });
  }
  try {
    const thread = await getThread(account, threadId);
    const message = thread.messages.find((item) => item.id === messageId);
    const attachment = message?.attachments.find((item) => item.id === attachmentId);
    if (!message || !attachment) return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
    if (attachment.size > 25 * 1024 * 1024) return NextResponse.json({ error: "Attachment exceeds the 25 MB download limit." }, { status: 413 });
    const data = await downloadAttachment(account, messageId, attachmentId);
    if (data.byteLength > 25 * 1024 * 1024) return NextResponse.json({ error: "Attachment exceeds the 25 MB download limit." }, { status: 413 });
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeFilename(attachment.filename)}"`,
        "Content-Length": String(data.byteLength),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return failure(error, "Unable to download this attachment.");
  }
}

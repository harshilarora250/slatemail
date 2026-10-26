import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listThreads } from "@/providers/gmail/gmail-provider";
import { getSessionAccount } from "@/server/session";
import { failure, invalidSession } from "@/server/http";

export const runtime = "nodejs";

const querySchema = z.object({
  mailbox: z.string().max(120).default("INBOX"),
  q: z.string().max(512).default(""),
  pageToken: z.string().max(4096).optional(),
  maxResults: z.coerce.number().int().min(1).max(50).default(30),
});

export async function GET(request: NextRequest) {
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  try {
    const input = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    return NextResponse.json(await listThreads(account, {
      mailbox: input.mailbox,
      query: input.q,
      pageToken: input.pageToken,
      maxResults: input.maxResults,
    }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error, "Unable to load this Gmail folder.");
  }
}

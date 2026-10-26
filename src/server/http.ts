import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class RequestTooLargeError extends Error {
  readonly response = { status: 413 };
  constructor() { super("Request payload exceeds the configured limit."); }
}

export class InvalidJsonError extends Error {
  readonly response = { status: 400 };
  constructor() { super("Request body is not valid JSON."); }
}

export async function readJson(request: Request, maxBytes = 256_000): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new RequestTooLargeError();
  if (!request.body) throw new InvalidJsonError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestTooLargeError();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(data)) as unknown; }
  catch { throw new InvalidJsonError(); }
}

export function failure(error: unknown, fallback = "The request could not be completed."): NextResponse {
  if (error instanceof ZodError) return NextResponse.json({ error: "Please check the provided information." }, { status: 400 });
  if (error instanceof InvalidJsonError) return NextResponse.json({ error: error.message }, { status: 400 });
  const status = (error as { code?: number; response?: { status?: number } } | null)?.response?.status;
  if (status === 400) return NextResponse.json({ error: "Gmail rejected the request. Check the message details or mailbox query and try again." }, { status: 400 });
  if (status === 409) return NextResponse.json({ error: "This draft changed in Gmail. Your local version has been kept; compare and resolve the conflict before syncing." }, { status: 409 });
  if (status === 413) return NextResponse.json({ error: error instanceof Error && error.message === "Attachment data exceeds this operation's size limit." ? error.message : "Request or attachment data exceeds this operation's size limit." }, { status: 413 });
  if (status === 401 || status === 403) return NextResponse.json({ error: "Gmail access expired or was revoked. Reconnect your account to continue." }, { status: 401 });
  if (status === 404) return NextResponse.json({ error: "That message or draft is no longer available in Gmail." }, { status: 404 });
  if (status === 429) return NextResponse.json({ error: "Gmail is temporarily rate limiting requests. SlateMail will retry shortly." }, { status: 429, headers: { "Retry-After": "30" } });
  if (status && status >= 500) return NextResponse.json({ error: "Gmail is temporarily unavailable. Your local changes are preserved." }, { status: 503 });
  if (error instanceof Error && error.message.includes("not configured")) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export function invalidSession() {
  return NextResponse.json({ error: "Connect a Gmail account to continue." }, { status: 401 });
}

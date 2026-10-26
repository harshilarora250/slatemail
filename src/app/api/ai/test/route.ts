import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { completeExternalText, userSuppliedText } from "@/providers/ai/external";
import { getAICredential, enforceAIRateLimit } from "@/server/ai-service";
import { getSessionAccount, verifySameOrigin } from "@/server/session";
import { invalidSession, readJson } from "@/server/http";
import { aiFailure } from "@/server/ai-http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request)) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  if (!enforceAIRateLimit(account.sub)) return NextResponse.json({ error: "AI request limit reached. Try again in a minute." }, { status: 429 });
  try {
    const input = z.object({ provider: z.enum(["openai", "anthropic", "openrouter"]) }).parse(await readJson(request));
    const credential = getAICredential(account.sub, input.provider);
    if (!credential) return NextResponse.json({ error: "Save an API key for this provider first." }, { status: 400 });
    await completeExternalText({ provider: input.provider, ...credential, text: userSuppliedText("Reply with the single word OK.") });
    return NextResponse.json({ success: true });
  } catch (error) {
    return aiFailure(error, "AI provider connection test failed.");
  }
}

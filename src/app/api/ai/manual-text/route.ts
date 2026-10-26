import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { completeExternalText, userSuppliedText } from "@/providers/ai/external";
import { getAICredential, enforceAIRateLimit } from "@/server/ai-service";
import { getSessionAccount, verifySameOrigin } from "@/server/session";
import { invalidSession, readJson } from "@/server/http";
import { aiFailure } from "@/server/ai-http";

export const runtime = "nodejs";

const requestSchema = z.object({
  provider: z.enum(["openai", "anthropic", "openrouter"]),
  model: z.string().trim().min(1).max(200).optional(),
  text: z.string().min(1).max(30_000),
});

export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request)) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  if (!enforceAIRateLimit(account.sub)) return NextResponse.json({ error: "AI request limit reached. Try again in a minute." }, { status: 429 });
  try {
    const input = requestSchema.parse(await readJson(request));
    const credential = getAICredential(account.sub, input.provider);
    if (!credential) return NextResponse.json({ error: "Save an API key for this provider first." }, { status: 400 });
    const result = await completeExternalText({
      provider: input.provider,
      apiKey: credential.apiKey,
      model: input.model ?? credential.model,
      endpoint: credential.endpoint,
      text: userSuppliedText(input.text),
    });
    return NextResponse.json({ result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return aiFailure(error, "AI provider request failed.");
  }
}

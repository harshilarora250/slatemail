import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { encryptSecret } from "@/server/crypto";
import database from "@/server/db";
import { validateProviderEndpoint, type ExternalProvider } from "@/providers/ai/external";
import { getSessionAccount, verifySameOrigin } from "@/server/session";
import { failure, invalidSession, readJson } from "@/server/http";
import { allowRequests } from "@/server/rate-limit";

export const runtime = "nodejs";

const providers = ["openai", "anthropic", "openrouter"] as const;
const settingsSchema = z.object({
  provider: z.enum(providers),
  model: z.string().trim().min(1).max(200),
  endpoint: z.string().trim().url().max(500).optional().or(z.literal("")),
  apiKey: z.string().min(1).max(1000).optional(),
});

export async function GET(request: NextRequest) {
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  const rows = database.prepare("SELECT provider, model, endpoint FROM ai_credentials WHERE account_sub = ?")
    .all(account.sub) as Array<{ provider: ExternalProvider; model: string; endpoint: string | null }>;
  const configured = Object.fromEntries(providers.map((provider) => [provider, { configured: false }])) as Record<string, { configured: boolean; model?: string; endpoint?: string }>;
  for (const row of rows) configured[row.provider] = { configured: true, model: row.model, endpoint: row.endpoint ?? undefined };
  return NextResponse.json({ providers: configured }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  if (!verifySameOrigin(request)) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  if (!allowRequests(`ai-settings:${account.sub}`, 10, 60_000)) return NextResponse.json({ error: "AI settings are being changed too quickly. Wait a minute and retry." }, { status: 429 });
  try {
    const input = settingsSchema.parse(await readJson(request));
    try { validateProviderEndpoint(input.provider, input.endpoint || undefined); }
    catch { return NextResponse.json({ error: "Custom endpoints must use HTTPS on the selected provider's official host." }, { status: 400 }); }
    const existing = database.prepare("SELECT encrypted_key FROM ai_credentials WHERE account_sub = ? AND provider = ?")
      .get(account.sub, input.provider) as { encrypted_key: string } | undefined;
    if (!input.apiKey && !existing) return NextResponse.json({ error: "Enter an API key before saving this provider." }, { status: 400 });
    const encrypted = input.apiKey ? encryptSecret(input.apiKey) : existing!.encrypted_key;
    database.prepare(`
      INSERT INTO ai_credentials(account_sub, provider, encrypted_key, model, endpoint, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_sub, provider) DO UPDATE SET encrypted_key = excluded.encrypted_key,
        model = excluded.model, endpoint = excluded.endpoint, updated_at = excluded.updated_at
    `).run(account.sub, input.provider, encrypted, input.model, input.endpoint || null, Date.now());
    return NextResponse.json({ configured: true });
  } catch (error) {
    return failure(error, "Unable to save AI provider settings.");
  }
}

export async function DELETE(request: NextRequest) {
  if (!verifySameOrigin(request)) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  if (!allowRequests(`ai-settings:${account.sub}`, 10, 60_000)) return NextResponse.json({ error: "AI settings are being changed too quickly. Wait a minute and retry." }, { status: 429 });
  const provider = z.enum(providers).safeParse(request.nextUrl.searchParams.get("provider"));
  if (!provider.success) return NextResponse.json({ error: "Unsupported AI provider." }, { status: 400 });
  database.prepare("DELETE FROM ai_credentials WHERE account_sub = ? AND provider = ?").run(account.sub, provider.data);
  return NextResponse.json({ removed: true });
}

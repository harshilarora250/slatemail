import "server-only";
import type { ExternalProvider } from "@/providers/ai/external";
import { decryptSecret } from "@/server/crypto";
import database from "@/server/db";
import { allowRequests } from "@/server/rate-limit";

export function getAICredential(accountSub: string, provider: ExternalProvider) {
  const row = database.prepare("SELECT encrypted_key, model, endpoint FROM ai_credentials WHERE account_sub = ? AND provider = ?")
    .get(accountSub, provider) as { encrypted_key: string; model: string; endpoint: string | null } | undefined;
  if (!row) return undefined;
  return { apiKey: decryptSecret(row.encrypted_key), model: row.model, endpoint: row.endpoint ?? undefined };
}

export function enforceAIRateLimit(accountSub: string): boolean {
  return allowRequests(`ai:${accountSub}`, 8, 60_000);
}

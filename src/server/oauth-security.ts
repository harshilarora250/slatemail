import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { StoredCredentials } from "@/server/google";
import type { Credentials } from "google-auth-library";

export function oauthStateMatches(supplied: string | null | undefined, expected: string | null | undefined): boolean {
  if (!supplied || !expected || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function pkceChallenge(verifier: string): string {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error("PKCE verifier has an invalid format.");
  return createHash("sha256").update(verifier).digest("base64url");
}

export function mergeRefreshedCredentials(previous: StoredCredentials, refreshed: Credentials): StoredCredentials {
  return {
    ...previous,
    ...refreshed,
    refresh_token: refreshed.refresh_token ?? previous.refresh_token,
    scope: refreshed.scope ?? previous.scope,
  };
}

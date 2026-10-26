import "server-only";
import { google, type Auth } from "googleapis";
import { CodeChallengeMethod } from "google-auth-library";
import { env, requireGoogleConfig } from "@/server/env";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import database from "@/server/db";
import { pkceChallenge } from "@/server/oauth-security";
import { mergeRefreshedCredentials } from "@/server/oauth-security";

export const GMAIL_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

export function createOAuthClient(): Auth.OAuth2Client {
  const config = requireGoogleConfig();
  return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
}

export function authorizationUrl(state: string, verifier: string, loginHint?: string): string {
  const oauth = createOAuthClient();
  const challenge = pkceChallenge(verifier);
  return oauth.generateAuthUrl({
    access_type: "offline",
    include_granted_scopes: true,
    prompt: "select_account consent",
    response_type: "code",
    scope: [...GMAIL_SCOPES],
    state,
    login_hint: loginHint,
    code_challenge: challenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });
}

export interface StoredCredentials {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string | null;
  token_type?: string | null;
  expiry_date?: number | null;
  id_token?: string | null;
}

export function getStoredCredentials(encrypted: string): StoredCredentials {
  return JSON.parse(decryptSecret(encrypted)) as StoredCredentials;
}

export function previousAccountCredentials(sub: string): StoredCredentials | undefined {
  const row = database.prepare("SELECT encrypted_credentials FROM accounts WHERE sub = ?")
    .get(sub) as { encrypted_credentials: string } | undefined;
  return row ? getStoredCredentials(row.encrypted_credentials) : undefined;
}

export function saveAccount(account: { sub: string; email: string; name: string; credentials: StoredCredentials }): void {
  const now = Date.now();
  const encrypted = encryptSecret(JSON.stringify(account.credentials));
  database.prepare(`
    INSERT INTO accounts(sub, email, name, encrypted_credentials, created_at, updated_at)
    VALUES (@sub, @email, @name, @encrypted, @now, @now)
    ON CONFLICT(sub) DO UPDATE SET
      email = excluded.email, name = excluded.name,
      encrypted_credentials = excluded.encrypted_credentials, updated_at = excluded.updated_at
  `).run({ sub: account.sub, email: account.email, name: account.name, encrypted, now });
}

export function gmailForAccount(account: { sub: string; encrypted_credentials: string }) {
  const oauth = createOAuthClient();
  const initial = getStoredCredentials(account.encrypted_credentials);
  oauth.setCredentials({
    access_token: initial.access_token ?? undefined,
    refresh_token: initial.refresh_token ?? undefined,
    scope: initial.scope ?? undefined,
    token_type: initial.token_type ?? undefined,
    expiry_date: initial.expiry_date ?? undefined,
    id_token: initial.id_token ?? undefined,
  });
  let refreshed = false;
  oauth.on("tokens", (tokens) => {
    refreshed = true;
    const merged = mergeRefreshedCredentials(initial, tokens);
    database.prepare("UPDATE accounts SET encrypted_credentials = ?, updated_at = ? WHERE sub = ?")
      .run(encryptSecret(JSON.stringify(merged)), Date.now(), account.sub);
  });
  return { gmail: google.gmail({ version: "v1", auth: oauth }), oauth, get refreshed() { return refreshed; } };
}

export async function revokeAccountCredentials(encrypted: string): Promise<void> {
  const credentials = getStoredCredentials(encrypted);
  const token = credentials.refresh_token ?? credentials.access_token;
  if (!token || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) return;
  const oauth = createOAuthClient();
  await oauth.revokeToken(token).catch(() => undefined);
}

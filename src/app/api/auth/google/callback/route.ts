import { NextRequest, NextResponse } from "next/server";
import { appUrl } from "@/server/env";
import { createOAuthClient, previousAccountCredentials, saveAccount } from "@/server/google";
import { createSession, getSessionAccount } from "@/server/session";
import { mergeRefreshedCredentials, oauthStateMatches } from "@/server/oauth-security";

export const runtime = "nodejs";

function clearTransaction(response: NextResponse) {
  const common = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/api/auth/google/callback", maxAge: 0 };
  response.cookies.set("slatemail_oauth_state", "", common);
  response.cookies.set("slatemail_oauth_verifier", "", common);
}

function redirectWithError(code: string) {
  const response = NextResponse.redirect(new URL(`/?oauth=${encodeURIComponent(code)}`, appUrl()));
  clearTransaction(response);
  return response;
}

export async function GET(request: NextRequest) {
  const oauthError = request.nextUrl.searchParams.get("error");
  if (oauthError) return redirectWithError("cancelled");
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  const expectedState = request.cookies.get("slatemail_oauth_state")?.value;
  const verifier = request.cookies.get("slatemail_oauth_verifier")?.value;
  if (!oauthStateMatches(state, expectedState) || !verifier) {
    return redirectWithError("invalid-state");
  }
  if (!code || code.length > 4096) return redirectWithError("invalid-callback");

  try {
    const oauth = createOAuthClient();
    const { tokens } = await oauth.getToken({ code, codeVerifier: verifier });
    if (!tokens.id_token) return redirectWithError("identity-unavailable");
    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
    const identity = ticket.getPayload();
    if (!identity?.sub || !identity.email || identity.email_verified !== true) return redirectWithError("identity-unverified");
    const existingSession = getSessionAccount(request);
    if (existingSession && existingSession.sub !== identity.sub) return redirectWithError("account-mismatch");
    const previousCredentials = previousAccountCredentials(identity.sub);
    const credentials = previousCredentials ? mergeRefreshedCredentials(previousCredentials, tokens) : tokens;
    if (!credentials.refresh_token) return redirectWithError("refresh-token-missing");
    saveAccount({
      sub: identity.sub,
      email: identity.email,
      name: identity.name ?? identity.email,
      credentials,
    });
    const response = NextResponse.redirect(new URL("/", appUrl()));
    createSession(identity.sub, response);
    clearTransaction(response);
    return response;
  } catch {
    return redirectWithError("connection-failed");
  }
}

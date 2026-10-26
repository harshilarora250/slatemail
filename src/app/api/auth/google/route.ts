import { NextRequest, NextResponse } from "next/server";
import { randomIdentifier } from "@/server/crypto";
import { authorizationUrl } from "@/server/google";
import { appUrl } from "@/server/env";
import { getSessionAccount } from "@/server/session";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const state = randomIdentifier(32);
    const verifier = randomIdentifier(48);
    const currentAccount = getSessionAccount(request);
    const response = NextResponse.redirect(authorizationUrl(state, verifier, currentAccount?.email));
    const common = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      path: "/api/auth/google/callback",
      maxAge: 600,
    };
    response.cookies.set("slatemail_oauth_state", state, common);
    response.cookies.set("slatemail_oauth_verifier", verifier, common);
    return response;
  } catch {
    return NextResponse.redirect(new URL("/?oauth=not-configured", appUrl()));
  }
}

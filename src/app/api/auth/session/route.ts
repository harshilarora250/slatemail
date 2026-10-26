import { NextRequest, NextResponse } from "next/server";
import database from "@/server/db";
import { getSessionAccount, destroySession, verifySameOrigin } from "@/server/session";
import { revokeAccountCredentials } from "@/server/google";
import { invalidSession } from "@/server/http";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const account = getSessionAccount(request);
    if (!account) return NextResponse.json({ connected: false });
    const sync = database.prepare("SELECT last_synced_at FROM sync_state WHERE account_sub = ?").get(account.sub) as { last_synced_at?: number } | undefined;
    return NextResponse.json({ connected: true, email: account.email, name: account.name, lastSyncedAt: sync?.last_synced_at });
  } catch {
    return NextResponse.json({ connected: false, error: "Session configuration is unavailable." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!verifySameOrigin(request)) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });
  const account = getSessionAccount(request);
  if (!account) return invalidSession();
  await revokeAccountCredentials(account.encrypted_credentials);
  database.prepare("DELETE FROM accounts WHERE sub = ?").run(account.sub);
  const response = NextResponse.json({ disconnected: true });
  destroySession(request, response);
  return response;
}

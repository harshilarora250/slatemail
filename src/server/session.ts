import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import database from "@/server/db";
import { hashIdentifier, randomIdentifier } from "@/server/crypto";

const COOKIE = "slatemail_session";
const SESSION_LIFETIME = 1000 * 60 * 60 * 24 * 30;

interface SessionAccount {
  sub: string;
  email: string;
  name: string;
  encrypted_credentials: string;
}

function signature(id: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32 || secret.startsWith("replace-")) throw new Error("Set SESSION_SECRET to a high-entropy value of at least 32 characters.");
  return createHmac("sha256", secret).update(id).digest("base64url");
}

export function createSession(accountSub: string, response: NextResponse): void {
  const id = randomIdentifier();
  const now = Date.now();
  const expiresAt = now + SESSION_LIFETIME;
  database.prepare("INSERT INTO sessions(id_hash, account_sub, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(hashIdentifier(id), accountSub, expiresAt, now);
  response.cookies.set(COOKIE, `${id}.${signature(id)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function getSessionAccount(request: NextRequest): SessionAccount | undefined {
  expireOldSessions();
  const token = request.cookies.get(COOKIE)?.value;
  if (!token) return undefined;
  const splitAt = token.lastIndexOf(".");
  if (splitAt <= 0) return undefined;
  const id = token.slice(0, splitAt);
  const supplied = Buffer.from(token.slice(splitAt + 1));
  const expected = Buffer.from(signature(id));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  const row = database.prepare(`
    SELECT a.sub, a.email, a.name, a.encrypted_credentials
    FROM sessions s JOIN accounts a ON a.sub = s.account_sub
    WHERE s.id_hash = ? AND s.expires_at > ?
  `).get(hashIdentifier(id), Date.now()) as SessionAccount | undefined;
  return row;
}

export function destroySession(request: NextRequest, response: NextResponse): void {
  const token = request.cookies.get(COOKIE)?.value;
  if (token) {
    const id = token.slice(0, token.lastIndexOf("."));
    if (id) database.prepare("DELETE FROM sessions WHERE id_hash = ?").run(hashIdentifier(id));
  }
  response.cookies.set(COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export function verifySameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === host && parsed.protocol === (request.nextUrl.protocol || "https:");
  } catch {
    return false;
  }
}

export function expireOldSessions(): void {
  const now = Date.now();
  if (now - lastSessionCleanup < 60 * 60 * 1000) return;
  database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  database.prepare("DELETE FROM send_attempts WHERE status IN ('sent', 'failed') AND updated_at <= ?").run(now - 90 * 24 * 60 * 60 * 1000);
  lastSessionCleanup = now;
}

let lastSessionCleanup = 0;

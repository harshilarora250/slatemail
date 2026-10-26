import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sendAttemptDisposition } from "@/domain/send-attempt";
import { threadMatchesMailbox, updateThreadForAction } from "@/client/operation-cache";
import { mergeRefreshedCredentials, oauthStateMatches, pkceChallenge } from "@/server/oauth-security";
import { remoteDraftVersionConflicts } from "@/domain/draft-conflict";
import { historyCursorExpired, requiresHistoryRebuild } from "@/domain/sync-policy";
import { failure } from "@/server/http";

describe("OAuth validation and token refresh", () => {
  it("validates OAuth state and rejects missing or mismatched values", () => {
    expect(oauthStateMatches("same-state", "same-state")).toBe(true);
    expect(oauthStateMatches("wrong-state", "same-state")).toBe(false);
    expect(oauthStateMatches(undefined, "same-state")).toBe(false);
  });

  it("creates a PKCE S256 challenge and rejects a malformed verifier", () => {
    const verifier = "a".repeat(48);
    expect(pkceChallenge(verifier)).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(() => pkceChallenge("short")).toThrow(/invalid format/);
  });

  it("preserves a refresh token when Google's refresh response omits it", () => {
    const merged = mergeRefreshedCredentials({ refresh_token: "refresh-secret", access_token: "old", expiry_date: 100 }, {
      access_token: "new", expiry_date: 200,
    });
    expect(merged).toMatchObject({ refresh_token: "refresh-secret", access_token: "new", expiry_date: 200 });
  });

  it("detects expired history cursors and bounds incremental rebuild work", () => {
    expect(historyCursorExpired(404)).toBe(true);
    expect(historyCursorExpired(429)).toBe(false);
    expect(requiresHistoryRebuild(101)).toBe(true);
    expect(requiresHistoryRebuild(100)).toBe(false);
  });

  it("does not overwrite an unknown or changed Gmail draft version", () => {
    expect(remoteDraftVersionConflicts(undefined, "remote-v1")).toBe(true);
    expect(remoteDraftVersionConflicts("remote-v1", "remote-v2")).toBe(true);
    expect(remoteDraftVersionConflicts("remote-v1", "remote-v1")).toBe(false);
  });
});

describe("mailbox operations and retry correctness", () => {
  const thread = {
    id: "thread-1",
    messages: [{ labels: ["INBOX", "UNREAD"], unread: true, starred: false }],
  };

  it("applies mailbox state transitions consistently for offline cache updates", () => {
    const read = updateThreadForAction(thread, thread.id, "read");
    expect(read.messages[0]).toMatchObject({ unread: false, labels: ["INBOX"] });
    const starred = updateThreadForAction(read, thread.id, "star");
    expect(starred.messages[0]).toMatchObject({ starred: true, labels: ["INBOX", "STARRED"] });
    expect(threadMatchesMailbox(starred, "STARRED", "", "")).toBe(true);
    expect(threadMatchesMailbox(starred, "INBOX", "needle", "other text")).toBe(false);
  });

  it("never automatically repeats a send with an ambiguous result", () => {
    expect(sendAttemptDisposition(undefined)).toBe("new");
    expect(sendAttemptDisposition("failed")).toBe("new");
    expect(sendAttemptDisposition("sent")).toBe("already-sent");
    expect(sendAttemptDisposition("pending")).toBe("uncertain");
    expect(sendAttemptDisposition("uncertain")).toBe("uncertain");
  });

  it("maps Gmail rate-limit failures to a safe retry response", async () => {
    const response = failure({ response: { status: 429 }, data: { error: "provider-secret-payload" } });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    const body = await response.json() as { error: string };
    expect(body.error).toContain("rate limiting");
    expect(JSON.stringify(body)).not.toContain("provider-secret-payload");
  });
});

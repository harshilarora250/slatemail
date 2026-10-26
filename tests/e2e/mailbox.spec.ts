import { expect, test, type Page } from "@playwright/test";
import type { MailThread } from "../../src/domain/mail";

const inboxThread: MailThread = {
  id: "thread-1",
  snippet: "A real inbox response supplied by the test's mocked Gmail API.",
  historyId: "1001",
  messages: [{
    id: "message-1",
    threadId: "thread-1",
    from: { name: "Ada Lovelace", email: "ada@example.test" },
    to: [{ name: "You", email: "you@example.test" }],
    cc: [],
    subject: "A private test message",
    snippet: "A real inbox response supplied by the test's mocked Gmail API.",
    date: "2026-10-26T12:00:00.000Z",
    unread: true,
    starred: false,
    labels: ["INBOX", "UNREAD"],
    hasAttachments: false,
    attachments: [],
  }],
};

const searchThread: MailThread = {
  ...inboxThread,
  id: "thread-2",
  messages: [{ ...inboxThread.messages[0]!, id: "message-2", threadId: "thread-2", subject: "Needle result", snippet: "Search matched this message." }],
  snippet: "Search matched this message.",
};

async function mockConnectedGmail(page: Page) {
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { connected: true, email: "you@example.test", name: "Test User", lastSyncedAt: Date.now() } }));
  await page.route("**/api/mail/labels", (route) => route.fulfill({ json: { labels: [
    { id: "INBOX", name: "INBOX", type: "system", unreadCount: 1, totalCount: 1 },
    { id: "Projects", name: "Projects", type: "user", unreadCount: 0, totalCount: 2 },
  ] } }));
  await page.route(/\/api\/mail\?/, async (route) => {
    const url = new URL(route.request().url());
    const threads = url.searchParams.get("q") ? [searchThread] : [inboxThread];
    await route.fulfill({ json: { threads, resultSizeEstimate: threads.length, nextPageToken: undefined } });
  });
  await page.route("**/api/sync", (route) => route.fulfill({ json: { initialized: true } }));
  await page.route("**/api/mail/drafts**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      if (new URL(request.url()).searchParams.get("countOnly") === "1") return route.fulfill({ json: { count: 0 } });
      return route.fulfill({ json: { drafts: [] } });
    }
    if (request.method() === "DELETE") return route.fulfill({ json: { deleted: true } });
    return route.fulfill({ json: { id: "gmail-draft-1", version: "v2" } });
  });
  await page.route("**/api/mail/thread-1", async (route) => {
    if (route.request().method() === "PATCH") return route.fulfill({ json: { success: true } });
    return route.fulfill({ json: { ...inboxThread, messages: [{ ...inboxThread.messages[0]!, textBody: "The locally cached reading pane test body." }] } });
  });
  await page.route("**/api/mail/thread-2", async (route) => {
    if (route.request().method() === "PATCH") return route.fulfill({ json: { success: true } });
    return route.fulfill({ json: searchThread });
  });
  await page.route("**/api/mail/send", (route) => route.fulfill({ json: { sent: true, messageId: "sent-1" } }));
}

test("loads mocked Gmail, opens a message, and confirms mailbox actions", async ({ page }) => {
  const actions: string[] = [];
  await mockConnectedGmail(page);
  await page.route("**/api/mail/thread-1", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { action: string };
      actions.push(body.action);
      return route.fulfill({ json: { success: true } });
    }
    return route.fulfill({ json: { ...inboxThread, messages: [{ ...inboxThread.messages[0]!, textBody: "The locally cached reading pane test body." }] } });
  });

  await page.goto("/");
  await expect(page.getByText("A private test message")).toBeVisible();
  await page.getByRole("button", { name: /Ada Lovelace, A private test message/ }).click();
  await expect(page.getByText("The locally cached reading pane test body.")).toBeVisible();
  await page.getByRole("button", { name: "Star message" }).click();
  await expect(page.getByRole("button", { name: "Unstar message" })).toBeVisible();
  await expect.poll(() => actions).toContain("star");
});

test("searches Gmail through its query API and opens the result", async ({ page }) => {
  const queries: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/mail?")) queries.push(new URL(request.url()).searchParams.get("q") ?? "");
  });
  await mockConnectedGmail(page);
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("needle");
  await expect.poll(() => queries).toContain("needle");
  await expect(page.getByText("Needle result")).toBeVisible();
  await page.getByRole("button", { name: /Ada Lovelace, Needle result/ }).click();
  await expect(page.getByRole("heading", { name: "Needle result" })).toBeVisible();
});

test("saves a local-first draft, restores it from IndexedDB, and persists theme settings", async ({ page }) => {
  await mockConnectedGmail(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Compose message" }).click();
  await page.getByLabel("To", { exact: true }).fill("person@example.test");
  await page.getByLabel("Subject").fill("Recovered after reload");
  await page.getByLabel("Message body").fill("Draft text is retained locally.");
  await expect.poll(async () => page.evaluate(() => indexedDB.databases().then((items) => items.some((item) => item.name === "slatemail-cache-v1")))).toBe(true);
  await page.getByRole("button", { name: "Close composer" }).click();
  await page.getByRole("button", { name: "Drafts" }).click();
  await expect(page.getByText("Recovered after reload")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("shows a disconnected first-run state and reports missing Google setup honestly", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("SlateMail does not fill your inbox with sample data.")).toBeVisible();
  await page.getByRole("link", { name: "Connect Gmail" }).click();
  await expect(page.locator('p[role="alert"]')).toContainText("Google OAuth is not configured");
});

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

test("collapses the sidebar cleanly and keeps Settings accessible from the top bar", async ({ page }) => {
  await mockConnectedGmail(page);
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Mailbox navigation" });
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(sidebar).toHaveClass(/sidebar-collapsed/);
  await expect(sidebar.getByRole("button", { name: "Compose message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);
});

test("keeps the page fixed while the email list scrolls independently", async ({ page }) => {
  await mockConnectedGmail(page);
  const manyThreads = Array.from({ length: 40 }, (_, index): MailThread => ({
    ...inboxThread,
    id: `thread-${index}`,
    messages: [{ ...inboxThread.messages[0]!, id: `message-${index}`, threadId: `thread-${index}`, subject: `Message ${index}` }],
  }));
  await page.route(/\/api\/mail\?/, (route) => route.fulfill({ json: { threads: manyThreads, resultSizeEstimate: manyThreads.length } }));
  await page.goto("/");
  await expect(page.getByText("Message 39")).toBeVisible();
  const list = page.locator(".list-scroll");
  const metrics = await list.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight }));
  expect(metrics.scroll).toBeGreaterThan(metrics.client);
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("shows an actionable reconnect message for a Gmail OAuth client failure", async ({ page }) => {
  await mockConnectedGmail(page);
  await page.route(/\/api\/mail\?/, (route) => route.fulfill({
    status: 401,
    json: { error: "Google rejected the configured OAuth client. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then reconnect Gmail." },
  }));
  await page.goto("/");
  await expect(page.locator(".settings-notice[role=alert]")).toContainText("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  await expect(page.getByRole("link", { name: "Reconnect Gmail" })).toHaveAttribute("href", "/api/auth/google");
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

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("loads saved OpenRouter settings and sends only manually entered non-email text", async ({ page }) => {
  let submitted: { provider?: string; model?: string; text?: string } | undefined;
  await mockConnectedGmail(page);
  await page.route("**/api/ai/settings", (route) => route.fulfill({ json: { providers: {
    openai: { configured: false },
    anthropic: { configured: false },
    openrouter: { configured: true, model: "openrouter/free" },
  } } }));
  await page.route("**/api/ai/manual-text", async (route) => {
    submitted = route.request().postDataJSON() as typeof submitted;
    await route.fulfill({ json: { result: "Revised public note." } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByRole("combobox", { name: "External AI provider" }).selectOption("openrouter");
  await expect(page.getByPlaceholder("Model ID supported by OpenRouter")).toHaveValue("openrouter/free");
  const manualText = "Please rewrite this short public announcement.";
  await page.getByPlaceholder("Enter non-email text to revise…").fill(manualText);
  await page.getByRole("button", { name: "Send entered text to provider" }).click();
  await expect(page.getByText("Revised public note.")).toBeVisible();
  expect(submitted).toMatchObject({ provider: "openrouter", model: "openrouter/free", text: manualText });
});

test("shows a disconnected first-run state and reports missing Google setup honestly", async ({ page }) => {
  await page.route("**/api/auth/google", (route) => route.fulfill({ status: 302, headers: { location: "/?oauth=not-configured" } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Email, with room to think." })).toBeVisible();
  await page.getByRole("link", { name: "Connect Gmail" }).click();
  await expect(page.locator('p[role="alert"]')).toContainText("Google OAuth is not configured");
});

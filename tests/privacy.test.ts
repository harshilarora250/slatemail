import { describe, expect, it, vi } from "vitest";
import { completeExternalText, userSuppliedText, validateProviderEndpoint } from "@/providers/ai/external";
import { runLocalMailAI, validateLocalRuntime } from "@/providers/ai/local-runtime";
import { sanitizeEmailHtml } from "@/providers/gmail/sanitize";

const privateMessageFixture = "MAILBOX_BODY_SHOULD_NEVER_LEAVE_THE_BROWSER";

describe("external AI privacy boundary", () => {
  it.each([
    ["openai", "https://api.openai.com/v1/chat/completions"],
    ["openrouter", "https://openrouter.ai/api/v1/chat/completions"],
    ["anthropic", "https://api.anthropic.com/v1/messages"],
  ] as const)("uses the %s adapter for only explicitly supplied text", async (provider, expectedUrl) => {
    const nonEmailText = "Please make this public announcement clearer.";
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      void _url;
      void _init;
      const payload = provider === "anthropic"
        ? { content: [{ type: "text", text: "Edited announcement." }] }
        : { choices: [{ message: { content: "Edited announcement." } }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await completeExternalText({
      provider,
      apiKey: "provider-key-for-this-adapter",
      model: "user-selected-model",
      text: userSuppliedText(nonEmailText),
      fetcher,
    });

    expect(result).toBe("Edited announcement.");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(expectedUrl);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(JSON.stringify(body)).toContain(nonEmailText);
    expect(JSON.stringify(body)).not.toContain(privateMessageFixture);
    expect(JSON.stringify(body)).not.toMatch(/subject|attachment|sender|recipient|thread/i);
    expect(JSON.stringify(init?.headers)).toContain("provider-key-for-this-adapter");
  });

  it("rejects external custom endpoints outside the selected provider's HTTPS host", () => {
    expect(() => validateProviderEndpoint("openai", "https://attacker.example/v1")).toThrow(/official host/);
    expect(() => validateProviderEndpoint("anthropic", "http://api.anthropic.com/v1")).toThrow(/official host/);
    expect(() => validateProviderEndpoint("openrouter", "https://openrouter.ai.evil.example")).toThrow(/official host/);
  });

  it("returns a useful invalid-key error without exposing a provider response body", async () => {
    const fetcher = async (_url: RequestInfo | URL, _init?: RequestInit) => {
      void _url;
      void _init;
      return new Response(JSON.stringify({ error: { message: "secret provider diagnostic" } }), { status: 401 });
    };
    await expect(completeExternalText({
      provider: "openai", apiKey: "bad-key", model: "model-id", text: userSuppliedText("non-email text"), fetcher,
    })).rejects.toMatchObject({ name: "ExternalProviderError", message: "Provider rejected the API key or model access.", status: 400 });
  });

  it("sends email-task content only to an explicitly local loopback runtime", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(JSON.stringify({ message: { content: "Local summary." } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runLocalMailAI({
      endpoint: "http://127.0.0.1:11434",
      model: "local-model",
      task: "summary",
      text: privateMessageFixture,
    });
    expect(result).toBe("Local summary.");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:11434/api/chat");
    expect(String(init?.body)).toContain(privateMessageFixture);
    expect(String(url)).not.toMatch(/openai|anthropic|openrouter/);
  });

  it("blocks a cloud or LAN destination from the email AI runtime", () => {
    expect(() => validateLocalRuntime("https://api.openai.com")).toThrow(/loopback/);
    expect(() => validateLocalRuntime("http://192.168.1.20:11434")).toThrow(/loopback/);
  });
});

describe("defensive HTML rendering", () => {
  it("removes scripts, remote images, inline handlers, and unsafe links", () => {
    const html = sanitizeEmailHtml('<p onclick="steal()">Hello</p><script>alert(1)</script><img src="https://track.example/pixel"><a href="javascript:alert(2)">click</a>');
    expect(html).toContain("Hello");
    expect(html).not.toMatch(/<script|onclick|<img|track\.example|javascript:/i);
  });
});

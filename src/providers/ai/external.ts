import "server-only";

export type ExternalProvider = "openrouter" | "openai" | "anthropic";

export interface UserSuppliedText {
  readonly value: string;
}

const providerOrigins: Record<ExternalProvider, string> = {
  openrouter: "https://openrouter.ai",
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
};

export class ExternalProviderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ExternalProviderError";
  }
}

export function validateProviderEndpoint(provider: ExternalProvider, configured?: string): URL {
  const endpoint = new URL(configured || providerOrigins[provider]);
  const allowed = new URL(providerOrigins[provider]);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.host !== allowed.host) {
    throw new Error("Custom endpoints must use HTTPS on the selected provider's official host.");
  }
  if (endpoint.search) throw new Error("Provider endpoints cannot contain query parameters.");
  return endpoint;
}

function providerPath(provider: ExternalProvider, pathname: string): string {
  const base = pathname.replace(/\/+$/, "");
  if (provider === "anthropic") {
    if (base.endsWith("/v1/messages")) return base;
    if (base.endsWith("/v1")) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  if (base.endsWith("/chat/completions")) return base;
  if (provider === "openai") {
    return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  }
  if (base.endsWith("/api/v1")) return `${base}/chat/completions`;
  if (base.endsWith("/api")) return `${base}/v1/chat/completions`;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/api/v1/chat/completions`;
}

export async function completeExternalText(input: {
  provider: ExternalProvider;
  apiKey: string;
  model: string;
  text: UserSuppliedText;
  endpoint?: string;
  fetcher?: typeof fetch;
}): Promise<string> {
  const url = validateProviderEndpoint(input.provider, input.endpoint);
  url.pathname = providerPath(input.provider, url.pathname);
  const fetcher = input.fetcher ?? fetch;
  let response: Response;

  try {
    if (input.provider === "anthropic") {
      response = await fetcher(url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: input.model, max_tokens: 1024, messages: [{ role: "user", content: input.text.value }] }),
        signal: AbortSignal.timeout(30_000),
      });
    } else {
      response = await fetcher(url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
        body: JSON.stringify({ model: input.model, messages: [{ role: "user", content: input.text.value }] }),
        signal: AbortSignal.timeout(30_000),
      });
    }
  } catch {
    throw new ExternalProviderError("The selected AI provider could not be reached. Check the provider URL and try again.", 502);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new ExternalProviderError("Provider rejected the API key or model access.", 400);
    if (response.status === 429) throw new ExternalProviderError("Provider rate limit reached. Try again later.", 429);
    if (response.status >= 500) throw new ExternalProviderError("The AI provider is temporarily unavailable.", 503);
    throw new ExternalProviderError("Provider rejected this model or request. Check the selected model ID.", 400);
  }
  const payload: unknown = await response.json();
  if (input.provider === "anthropic") {
    const content = (payload as { content?: Array<{ type?: string; text?: string }> }).content;
    return content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") ?? "";
  }
  return (payload as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
}

export function userSuppliedText(value: string): UserSuppliedText {
  return { value };
}

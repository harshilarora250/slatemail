# SlateMail

SlateMail is a privacy-focused Gmail client with a compact three-pane interface, offline reading and drafts, and optional AI assistance. Email-related AI runs against a local Ollama-compatible runtime only. External BYOK providers are kept separate and receive only manually entered non-email text.

## Current V1 status

The repository includes the Next.js application, Gmail OAuth/API routes, local IndexedDB cache and draft queue, incremental Gmail History polling, encrypted server-side credential storage, optional AI adapters, PostHog privacy gate, and automated tests. The interface does not contain demo email. Gmail, PostHog event delivery, and local inference require external configuration and should be verified using the setup instructions below.

Current limitations are listed at the end of this document; in particular, Gmail OAuth verification is owned by the deployer, the server-side SQLite setup is single-instance, and email AI requires a local model runtime.

## Architecture

- **Next.js App Router / React / strict TypeScript** for the web application and same-origin server endpoints.
- **Tailwind CSS and CSS-variable design tokens** for light/dark themes, accent colours, and responsive three-pane layout.
- **Google OAuth 2.0 + Gmail API** for the real provider. Verified Google identity is the app account; there is no second password account.
- **SQLite (`better-sqlite3`)** for account/session metadata, encrypted OAuth and BYOK credentials, sync cursors, draft-to-Gmail mappings, and send-attempt idempotency records. No message bodies or attachment bytes are stored in SQLite.
- **IndexedDB (`idb`)** for a bounded message/thread cache, local-first drafts, and queued offline mailbox actions.
- **Runtime-neutral domain types and provider adapters** separate the Gmail implementation from UI and browser storage.
- **Vitest and Playwright** for unit/integration and browser-flow tests.

The server is designed for a persistent Node.js deployment with one application instance. The SQLite path must be on persistent storage. Horizontal scaling needs a shared database and cross-instance sync locking before adding replicas.

## Requirements

- Node.js 20.9+ (Node 26 is used during development).
- npm 10+.
- A Google Cloud project and OAuth Web application client for real Gmail access.
- A persistent writable data directory for SQLite.
- Optional: a PostHog project; API keys for OpenAI, Anthropic, or OpenRouter; an Ollama-compatible local runtime and local model.

## Local setup

```bash
npm install
cp .env.example .env.local
```

Replace the placeholders in `.env.local`. Generate independent secrets:

```bash
openssl rand -base64 32  # SESSION_SECRET (use a high-entropy value)
openssl rand -base64 32  # APP_ENCRYPTION_KEY (exactly 32 decoded bytes)
```

Set:

```dotenv
APP_URL=http://localhost:3000
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SESSION_SECRET=...
APP_ENCRYPTION_KEY=...
DATABASE_PATH=./data/slatemail.sqlite
```

Start the app:

```bash
npm run dev
```

Without Google credentials, SlateMail displays a disconnected first-run screen and does not invent sample messages. `Connect Gmail` reports that the OAuth configuration is missing until those values are set.

## Google Cloud / Gmail OAuth setup

1. Create/select a Google Cloud project and enable **Gmail API**.
2. Configure the OAuth consent screen, app name, support contact, developer contact, audience, and test users as required by your project.
3. Create an OAuth client ID of type **Web application**.
4. Add the local origin `http://localhost:3000` under Authorized JavaScript origins if required by the Cloud Console and add this exact Authorized redirect URI:
   `http://localhost:3000/api/auth/google/callback`
5. Set the client ID/secret and matching redirect URI in `.env.local`; use HTTPS and the production URL in production.
6. Sign in using a consent-screen test user while the app is in Testing.

SlateMail requests `openid`, `email`, `profile`, `gmail.modify`, and `gmail.compose`. `gmail.modify` includes the mailbox reads required here, so the separate `gmail.readonly` scope is not requested. It does not request `mail.google.com`. Gmail scopes are sensitive/restricted; Google may limit Testing users, require OAuth verification for public use, and require a security assessment for restricted-scope server-side access. App owners must complete Google verification and any assessments in their own Cloud project. A newly issued OAuth grant must include offline refresh access; if a previous grant omitted it, remove SlateMail from the Google Account's third-party access list and reconnect.

OAuth state is validated, a PKCE verifier is used, ID tokens are audience-checked, and the resulting session is an opaque, signed, `HttpOnly`, `SameSite=Lax` cookie. Refresh tokens are AES-256-GCM encrypted at rest and never returned to browser JavaScript. Disconnect attempts Google revocation, removes account credentials/sessions, and clears the local cache.

Reconnect hints the currently connected Google identity and rejects a callback for a different Google subject. To switch Gmail accounts, disconnect the current account first.

### Gmail reconnect errors

- **OAuth client rejected / `invalid_client`:** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` must belong to the same active Web OAuth client. After correcting them, restart SlateMail and reconnect the same Gmail account so Google issues a refresh token for that client.
- **Gmail API disabled:** enable Gmail API in the same Google Cloud project as the OAuth client.
- **Refresh grant revoked / `invalid_grant`:** remove SlateMail from the Google Account's third-party access list, then reconnect and accept the requested scopes.

### Manual Gmail test checklist

Use a dedicated test Gmail account after configuring Cloud OAuth:

1. Connect, inspect consent scopes, refresh the page, and verify the account remains connected.
2. Load Inbox, Starred, Sent, Drafts, Archive, Trash, and a custom label; test a Gmail search query.
3. Open a conversation, mark read/unread, star/unstar, archive, and move to Trash; verify each state in Gmail itself.
4. Compose to the test account, save, reload, edit, attach a small file, send, and verify the received message and attachment.
5. Reply, reply-all, and forward; verify the conversation threading and recipients before sending.
6. Disconnect and verify the Google grant is removed when revocation succeeds and the SlateMail browser cache is cleared.
7. Temporarily disable networking while a draft is open, edit and refresh, reconnect, and verify that the local draft is retained and synchronized. Exercise concurrent Gmail draft edits to confirm conflict resolution is explicit.

## AI settings and privacy boundary

In Settings → AI, email actions (summaries, local reply drafting, rewriting, tone, and clarity) call the configured Ollama `/api/chat` endpoint directly from the browser. The endpoint must be unauthenticated loopback HTTP (`localhost`, `127.0.0.1`, or `::1`); remote endpoints are rejected. Install a local model, configure the runtime's allowed browser origin (for example `OLLAMA_ORIGINS=http://localhost:3000` for local development), set the local URL and model name in Settings, and test the runtime. Browser cross-origin rules must allow the SlateMail origin.

If the local runtime/model is missing, email AI actions report that state and do not fall back to a cloud model. AI-generated replies remain drafts until a user explicitly reviews and sends them. Automatic AI processing is disabled in V1.

OpenRouter, OpenAI, and Anthropic BYOK credentials can be saved in Settings. They are encrypted server-side, never placed in browser storage, and never sent to another provider. External adapters are isolated to the manually entered non-email text tool; they do not receive Gmail objects, threads, drafts, search results, attachments, or mailbox access. Provider-specific request formats are used, and custom endpoints must remain on that provider's official HTTPS host. Do not paste email or email-derived text into the external text tool.

For OpenRouter, leave the endpoint blank to use `https://openrouter.ai/api/v1/chat/completions`, enter a model ID available to your key (for example `openrouter/free`), save the key, and use **Test connection**. That test sends only a short `OK` request; successful connectivity does not enable cloud AI on email content.

## PostHog

Optional client analytics use `posthog-js`. Set `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` to your project values to enable delivery. No project key is committed. Autocapture, pageview events, identity tracking, and session replay are off; the event wrapper allows only a small event-name allowlist and strips properties.

The requested wizard command was attempted:

```bash
npx -y @posthog/wizard@latest
```

The wizard requires an interactive TTY and exited without changing the repository (`PHW_CLI_INTERACTIVE_REQUIRED`). Its CI flow needs a real PostHog key, which is not available here, so the supported manual `posthog-js` integration is used. Review the generated diff before accepting wizard output if rerunning interactively. Optional analytics is enabled by default when consent is not required; when consent is required for the deployment, set `NEXT_PUBLIC_POSTHOG_REQUIRES_CONSENT=true`, which starts tracking disabled until the user enables it in Settings. Opt-out immediately stops future optional events and session recording; it does not delete events already transmitted.

## Development commands

```bash
npm run dev          # development server
npm run typecheck    # strict TypeScript check
npm run lint         # ESLint
npm test             # Vitest unit/integration tests
npm run test:e2e     # Playwright tests (requires browser installation)
npm run build        # production build
npm run start        # serve production build
```

Install a Playwright browser when needed with `npx playwright install chromium`.

## Data, security, and operational limits

- Email data is cached only in browser IndexedDB, bounded to recent threads and bodies the user opens. Cache and local drafts can be cleared in Settings; disconnect clears the account cache.
- Offline reading uses the local cache. Offline mailbox changes are queued and retried. Offline sending is not attempted; content remains a local draft.
- Gmail History is polled while the application is open (about every 45 seconds), with expired cursors triggering a bounded cache rebuild. It is not push/instant synchronization.
- OAuth tokens and AI API keys are encrypted using `APP_ENCRYPTION_KEY`. Keep this key, `SESSION_SECRET`, the SQLite file, and its backups private. Use HTTPS in production.
- Expired sessions are purged during authenticated requests. Confirmed/definitive failed send-attempt metadata is removed after 90 days; ambiguous attempts remain until reconciled so a retry cannot silently duplicate a message.
- This is a web application: same-origin script compromise could access browser-cached messages. Content Security Policy, sanitization, remote-image blocking, and safe rendering reduce risk but do not provide native OS credential-vault isolation.
- HTML email is sanitized to a restricted tag/attribute set. Remote images, scripts, forms, styles, and embedded frames are not rendered. Attachments are download-only and served as `application/octet-stream` with `nosniff`.
- Analytics never receives message content, addresses, search strings, draft text, attachment names, credentials, or tokens.

## Known limitations

- Google verification, restricted-scope approval, production OAuth configuration, and provider credentials cannot be completed in this repository; these require the deployer's accounts.
- V1 assumes one Node instance and persistent local SQLite. Do not horizontally scale until shared database transactions and distributed sync locking exist.
- Gmail does not offer a general exactly-once send guarantee. SlateMail persists send-attempt IDs and refuses automatic retries when a result is ambiguous; the user must check Sent before explicitly starting a new attempt.
- Gmail draft conflict checking is optimistic (read/version check then update) because Gmail draft updates do not offer an atomic compare-and-swap precondition. A narrow race remains if another client edits between that check and update.
- V1 compose content is plain text. Forwarding quotes message text but does not automatically reattach original files. HTML email display is sanitized and intentionally conservative.
- Local model quality, model downloads, CORS setup, hardware capacity, and runtime availability are user controlled. No cloud fallback exists.
- Playwright/Gmail live verification depends on the browser, OAuth client, and Gmail test account being configured.

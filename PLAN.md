# SlateMail V1 implementation plan

## Repository and runtime discovered

- The repository has no application files, package manifest, commits, or existing configuration.
- Working tree is on branch `build-and-implement` and has no commits.
- Node.js `v26.5.0`, npm/npx `11.17.0`, Git, Docker, PostgreSQL client, and Python 3.11 are installed. `pnpm` and `yarn` are not installed.
- No Google, PostHog, database, or AI credentials are present in the repository inspection.

## 1. Architecture and technology choices

- **Web app:** Next.js App Router, React, strict TypeScript, and Node.js server routes. This keeps UI and protected OAuth/provider endpoints in one deployable application and leaves domain logic in runtime-neutral TypeScript modules.
- **UI:** Tailwind CSS, accessible native/custom primitives (shadcn-inspired), and Lucide icons. Design tokens use CSS variables; the mailbox is a responsive, resizable three-pane client interface.
- **Persistence:** SQLite through `better-sqlite3` for server-side account identity, sessions, encrypted OAuth/BYOK credentials, Gmail sync cursors, local-to-Gmail draft mappings, and duplicate-send records. Draft mappings include a stable SlateMail draft header so uncertain creates can be reconciled without blindly creating duplicates. It needs no separate database service and supports an easy local setup. Production must use persistent storage and a single application instance unless a shared database/locking strategy is added.
- **Browser cache:** IndexedDB via `idb` for a bounded set of recently synchronized messages, thread bodies, labels, and locally-first drafts/operation queue. The Gmail provider interface and domain models do not depend on IndexedDB.
- **Gmail:** Google OAuth 2.0 authorization-code flow using Google client libraries, offline access, state + PKCE, and Gmail API provider adapter. A signed, `HttpOnly`, `Secure` (in production), `SameSite=Lax` session cookie identifies the Google account. Tokens are AES-256-GCM encrypted at rest.
- **Validation and tests:** Zod for external input boundaries; Vitest for domain/server tests; Playwright for browser flows. Production runs on a supported Node server runtime (not a static export or edge runtime).
- **Analytics:** PostHog through a central client-only privacy gate; session replay/autocapture are disabled. No email/account/key values are valid event properties.

### Proposed directory structure

```text
src/
  app/                   App Router pages, layouts, and API route handlers
  components/            Mailbox, compose, settings, and reusable UI
  domain/                Runtime-neutral mail, draft, sync, and AI contracts
  providers/gmail/        Gmail API adapter, MIME parsing, OAuth helpers
  providers/ai/           External BYOK adapters and local-runtime adapter
  server/                 Session, encrypted storage, SQLite, and route services
  client/                  IndexedDB repository, sync coordinator, preferences
  analytics/               PostHog client, consent state, allowlisted events
  styles/                  Theme tokens and global styles
tests/                     Unit/integration tests and Playwright scenarios
```

## 2. Gmail OAuth and Google Cloud configuration

- Create a Google Cloud project, enable Gmail API, configure OAuth consent screen and authorized origins/redirect URI, then create a Web application OAuth client.
- Request OpenID identity (`openid email profile`) to use the connected Google account as SlateMail identity, plus `gmail.modify` and `gmail.compose` for reading/modifying mailbox state and labels, drafts, and send. `gmail.readonly` is unnecessary because `gmail.modify` includes the required reads. Do not request `mail.google.com` or Gmail settings scope. Confirm exact API operations against current Google scope requirements during implementation.
- Use `access_type=offline`, state in a short-lived `HttpOnly` cookie, PKCE verifier in the same protected transaction, validated callback state, and verified ID token/account subject. Never put tokens in browser storage, URLs, or logs.
- Google may classify Gmail scopes as restricted/sensitive. Consent-screen test-user restrictions apply while in Testing; public launch can require OAuth verification and, for restricted-scope server-side storage/access, a security assessment. This must be completed in the Google Cloud project by its owner.
- Access-token refresh is server-side. A revoked grant triggers a disconnected/reconnect state. Disconnect deletes the local encrypted token and session and attempts Google token revocation.

## 3. Authentication and account sessions

- Do not add a separate password account. Verified Google OAuth identity is both mailbox identity and SlateMail account identifier; this avoids duplicate sign-in and account-linking ambiguity in the single-provider V1.
- Store an opaque random session ID and expiry in SQLite; sign the ID in an `HttpOnly`, `SameSite=Lax` cookie. Use `Secure` in production, rotate on OAuth, expire sessions, and validate origin/CSRF token for mutating app routes.
- Scope every stored token/cursor to the verified Google `sub`. Account disconnect invalidates all that account's sessions and encrypted credentials.
- Reconnect uses the current account as `login_hint` and rejects an OAuth callback for a different Google subject; users explicitly disconnect before switching accounts.

## 4. Email synchronisation, cache, and offline behaviour

- Initial sync fetches a bounded recent inbox page and message bodies on demand; it does not copy the entire mailbox. Search and pagination use Gmail query/history APIs.
- While a connected app is open, a single-tab sync coordinator polls Gmail History at a modest interval with backoff, persists the remote history cursor, updates IndexedDB, and handles `historyId` expiry by rebuilding the bounded cache. Gmail is authoritative; local cache is for quick/offline reading, never a claim of delivery.
- IndexedDB stores only cached message/thread data needed for recent reading, labels, draft snapshots, and a durable pending-operation queue. Cache clearing is user controlled; disconnect clears account cache. No email is stored in PostHog or application analytics.
- Mutations optimistically update the cache and queue/execute against Gmail. Confirm success only from Gmail; failures are reconciled and shown. Server/database locking and browser single-flight guards prevent overlapping cursor updates.
- Offline mode permits cached reading and local draft editing. Sending and Gmail mailbox mutations remain pending/disabled until connected; queued sends use a stable idempotency record and re-check draft state to avoid automatic duplicate sends.

## 5. AI architecture and no-email-content-egress boundary

- Three explicit adapters support OpenRouter, OpenAI, and Anthropic for **manually supplied, non-email text only**. These adapters accept a dedicated user-text request type; they do not receive a message/thread/draft/repository object or get mailbox access. Keys are encrypted at rest server-side and never sent to a different provider.
- User chooses provider/model and can test, replace, or remove a key. Model names are user-selectable rather than represented as a stale exhaustive catalog. Custom endpoints are HTTPS-only and validated; local runtimes use a separate, explicitly configured endpoint.
- Summary, conversation summary, reply drafting, and email-text rewriting use only a configured local Ollama-compatible runtime called directly from the browser. Email data is never sent through a server AI route or external adapter. If local inference is absent, email AI actions are honestly unavailable; there is no cloud fallback. Automatic AI remains off by default.
- Local inference is opt-in, displays the local destination, and requires the local runtime's browser-origin access to be configured. AI output is untrusted and remains an unsent draft for user review.
- Automated tests inspect external adapter payloads and prove mailbox-derived data is not accepted by those call paths.

## 6. Draft storage and synchronisation

- Write drafts to IndexedDB immediately and autosave after a short debounce. A durable queue tracks local revision, remote Gmail draft ID/revision, last synced time, pending status, and send-attempt state.
- Sync updates the Gmail draft only when its known remote revision has not changed. Concurrent remote changes surface a conflict with both versions; never silently replace a newer remote draft.
- Sending requires a user action and online connection. Use a stable send-attempt identifier, mark `sending` before the request, reconcile uncertain results with Gmail, and never blindly retry an ambiguous send. A failed send preserves the draft and says it was not sent/needs reconciliation.
- Refresh and temporary disconnection restore local content. Gmail remains the cross-device source of truth after successful synchronization.

## 7. PostHog and opt-out

- Ran the requested `npx -y @posthog/wizard@latest` after the app scaffold existed. It exited without modifying files because this environment has no interactive TTY (`PHW_CLI_INTERACTIVE_REQUIRED`); its `--ci` mode requires a real PostHog key, which is not configured. Manually integrated the supported `posthog-js` client with a privacy gate and placeholder environment values instead.
- Central analytics state defaults on only where consent rules allow; persist preference locally. Capture a short allowlist of content-free product milestones (`application_opened`, `mailbox_opened`, `message_opened`, `compose_opened`, `search_used`, confirmed send, settings/theme, and local AI actions) with no properties. If consent is required, start disabled until the user opts in. A single capture wrapper checks the preference at capture time; opt-out calls PostHog opt-out, stops capture/autocapture/replay, and blocks route events for the rest of the session and future sessions.
- Session recording and autocapture are off. Use only an allowlist of low-risk events with no user properties or free-form values; do not transmit account identity, email, search terms, AI content, keys, or tokens. Opt-out itself is not captured.

## 8. Database schema and retention

SQLite tables: `accounts` (Google subject/email, encrypted token blob, grant status), `sessions` (hashed opaque ID, account subject, expiry), `sync_state` (account subject, history cursor, last-success timestamp), `ai_credentials` (provider, encrypted key, model/endpoint configuration), `draft_sync` (stable client draft ID, Gmail draft ID, version/status), and `send_attempts` (opaque attempt ID, Gmail draft/message IDs, status/timestamps). No email bodies or attachment bytes are stored in SQLite.

Retain only account/session/sync/config data needed to operate the app; expire sessions, remove confirmed/failed send-attempt records after 90 days, retain ambiguous send attempts until reconciled to avoid accidental duplicates, delete credentials on disconnect/removal, and allow a user to clear local cache/drafts. SQLite backup/volume retention is deployment-owner responsibility. Browser cache is bounded and removable. Analytics is minimized and opt-out respected.

## 9. Security and threat model

- Treat Gmail messages, HTML, attachment names/types, headers, AI output, provider errors, OAuth callback values, and all request bodies as untrusted. Validate request schemas; sanitize rendered HTML; block remote images by default; never execute embedded content.
- Encrypt OAuth refresh/access credentials and saved BYOK keys with AES-256-GCM; require a high-entropy `APP_ENCRYPTION_KEY`. Protect cookies, validate CSRF/origin, rate-limit OAuth/credential/AI routes, redact server errors, and restrict custom AI endpoints to safe HTTPS configurations.
- Gmail OAuth scopes are sensitive; compromise of the app server/database plus encryption key can expose account access. Protect deployment secrets, disks/backups, TLS, and access to the single-instance SQLite host.
- Browser cache is readable to same-origin JavaScript; XSS would expose cached mail. Use a restrictive CSP, safe React rendering, HTML sanitization, no unsafe script execution, dependency review, and never claim web isolation equal to native OS credential vault isolation.
- External AI providers receive only explicitly submitted non-email text. There is no technical path from mailbox state to those adapters. Local inference still processes mail on the user's configured local machine/runtime.

## 10. Design system and component structure

- Use neutral light/dark palettes with CSS variables, semantic foreground/surface/border tokens, user accent, compact typography, 4px spacing rhythm, thin separators, restrained motion, and visible focus rings.
- `AppShell` composes resizable/collapsible `Sidebar`, `MailList`, and `ReadingPane`; `ComposeWindow` is a keyboard-accessible dialog/dock. `Settings` groups appearance, Gmail, AI, privacy/analytics, and shortcuts. Use accessible primitives and semantic status/live regions.
- Persist theme/system choice, accent, density, pane widths/arrangement, sidebar state/width, shortcuts, and analytics choice locally. Mobile collapses to one pane with back navigation.

## 11. Ordered milestones and dependencies

1. Foundation: initialize Next/TS/Tailwind, tokens, accessible primitives, shell, settings scaffold. (No external credential.)
2. Mail UX: real interaction model, Gmail-shaped domain types, mailbox/read/compose/search/folders/shortcuts; fixtures must be explicitly marked development-only. (No external credential.)
3. Gmail: SQLite and encryption, Google OAuth/session, Gmail provider adapter, message/thread/search/actions/send/draft/attachment routes. (Requires Google Cloud OAuth setup to exercise live account.)
4. Cache/sync: IndexedDB repositories, bounded first sync, History polling, conflict-aware drafts/offline recovery, optimistic updates. (Live sync requires OAuth.)
5. Privacy/AI: provider settings and isolated external non-email text adapters, local Ollama-only email AI, privacy tests. (Requires BYOK keys for external manual-text actions; local runtime for email AI.)
6. Analytics: run/review wizard or manual PostHog install, central event gate, consent/opt-out tests. (Requires PostHog project key to transmit events.)
7. Polish/verification: responsive/accessibility states, docs, unit/integration/e2e tests, typecheck/lint/build, manual Gmail test checklist.

## 12. Testing strategy and acceptance criteria

- Vitest covers OAuth state/PKCE/session and encryption, Gmail adapter refresh/errors/MIME/attachments, sync cursor recovery and locking, draft conflicts/send dedupe/offline queue, preference persistence, keyboard filtering, AI privacy boundaries, and analytics kill switch.
- Playwright covers navigation, selecting/reading/searching mail, safe compose/draft recovery, keyboard behavior, theme/layout persistence, and disconnected/error states using mocked Gmail routes. A separate manual checklist exercises actual Google consent, account refresh/revoke, Gmail operations, send, and attachments.
- Acceptance: `npm run typecheck`, `npm run lint`, `npm test`, and production build pass; a local app can run without secrets in an honest disconnected state; live Gmail is only claimed after OAuth credentials are configured; email never enters external AI request payloads.

## 13. External credentials, variables, and manual setup

Required only for corresponding live integrations: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `APP_URL`, `SESSION_SECRET`, `APP_ENCRYPTION_KEY`, and persistent `DATABASE_PATH`. Optional PostHog: `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` (legacy `NEXT_PUBLIC_POSTHOG_KEY` is also accepted), `NEXT_PUBLIC_POSTHOG_HOST`. AI provider API keys are entered in Settings and encrypted server-side; optional local runtime URL is configured explicitly by the user. `.env.example` will contain placeholders only.

Manual setup also includes Google Cloud Gmail API enablement, consent screen/users and redirect URI; production HTTPS/persistent disk; PostHog project creation if desired; and Ollama/local model installation if local email AI is desired.

## 14. Limitations and unresolved questions

- Google OAuth verification and restricted-scope approval cannot be completed from this repository; test users may be required until the Google project is published and verified.
- V1 assumes one Node application instance with persistent local SQLite storage. Horizontal scaling requires a shared transactional database/locking replacement and coordinated sync.
- Local Ollama inference depends on the user's machine, model capacity, CORS/origin settings, and browser mixed-content rules. No hosted inference fallback is acceptable.
- Gmail API search syntax and scope coverage vary by operation; provider methods must expose errors rather than emulate unsupported behavior. Gmail does not provide a general exactly-once send guarantee, so ambiguous sends require reconciliation.
- Legal consent requirements for analytics depend on deployment jurisdiction; analytics must begin off when consent is legally required until consent is recorded.
- Live Gmail, PostHog delivery, and local inference cannot be credential-verified in this environment unless the required external configuration is supplied.

import Link from "next/link";

export const metadata = { title: "Privacy · SlateMail" };

export default function PrivacyPage() {
  return <main className="privacy-page">
    <header><Link href="/" aria-label="Back to SlateMail">← SlateMail</Link><span>Privacy</span></header>
    <article>
      <p className="privacy-eyebrow">A straightforward promise</p>
      <h1>Your email is yours.</h1>
      <p className="privacy-lede">SlateMail is designed to keep mailbox content between you, Gmail, and your device.</p>
      <section><h2>Email and AI</h2><p>SlateMail never sends email bodies, subjects, sender or recipient details, attachments, quoted history, summaries, or other email-derived content to OpenAI, Anthropic, OpenRouter, PostHog, or another cloud AI service. Email AI actions use an Ollama-compatible model reached directly from your browser at a user-configured loopback address. If that local runtime is unavailable, those actions are unavailable; there is no cloud fallback.</p><p>Cloud AI credentials are optional and encrypted at rest by the SlateMail server. Cloud adapters are limited to text you deliberately enter in the clearly labelled manual-text tool. Do not paste email content into that tool.</p></section>
      <section><h2>Gmail access</h2><p>SlateMail requests Gmail scopes needed to read mail, manage labels and read state, and create drafts and send messages. OAuth access and refresh tokens are held server-side and encrypted using the configured application key. Messages and attachment data are cached in your browser&apos;s IndexedDB for recent reading and draft recovery. You can clear that cache or disconnect Gmail in Settings.</p></section>
      <section><h2>Analytics</h2><p>Optional PostHog events are limited to product actions such as opening Settings or changing the theme. Autocapture, session replay, identity tracking, search content, and email/account fields are disabled. You can disable optional analytics in Settings; new optional capture stops immediately. Disabling analytics does not remove data already sent to PostHog.</p></section>
      <section><h2>Deployment and retention</h2><p>SlateMail&apos;s server stores account identity, encrypted provider credentials, session expiry, sync cursors, draft synchronization metadata, and send-attempt identifiers. It does not store email bodies or attachment bytes in its SQLite database. The operator of a deployment controls server disk backups and retention. A web application cannot isolate local browser data as strongly as a native app backed by an operating-system credential vault.</p></section>
      <section><h2>Contact and project</h2><p>SlateMail is an open-source project. Self-hosting operators should publish their own contact and data-controller details before inviting users. See the repository README for deployment and security configuration.</p></section>
      <p className="privacy-note">This policy describes the current V1 implementation and may change as the project evolves.</p>
    </article>
  </main>;
}

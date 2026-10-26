"use client";

import { useEffect, useRef, useState } from "react";
import {
  Link2, LockKeyhole, Palette, RotateCcw, ShieldCheck, SlidersHorizontal, Sparkles, Trash2,
  X,
} from "lucide-react";
import type { AccountStatus } from "@/domain/mail";
import type { UserPreferences, ThemePreference, AccentPreference, DensityPreference } from "@/client/preferences";
import { validateLocalRuntime } from "@/providers/ai/local-runtime";
import { useModalFocus } from "@/components/use-modal-focus";
import { captureOptional } from "@/analytics/client";

type SettingsSection = "appearance" | "account" | "ai" | "privacy" | "shortcuts";
type AIProvider = "openrouter" | "openai" | "anthropic";

const providerNames: Record<AIProvider, string> = { openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic" };
const localSettingsKey = "slatemail-local-ai-v1";

function readLocalAISettings(): { endpoint: string; model: string } {
  const defaultEndpoint = process.env.NEXT_PUBLIC_LOCAL_AI_URL || "http://localhost:11434";
  if (typeof window === "undefined") return { endpoint: defaultEndpoint, model: "" };
  try {
    const saved = localStorage.getItem(localSettingsKey);
    const value = saved ? JSON.parse(saved) as { endpoint?: string; model?: string } : {};
    return { endpoint: value.endpoint ?? defaultEndpoint, model: value.model ?? "" };
  } catch { return { endpoint: defaultEndpoint, model: "" }; }
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (value: boolean) => void }) {
  return <button type="button" className="toggle" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}

function Row({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return <div className="settings-row"><div className="settings-row-copy"><strong>{title}</strong>{detail && <span>{detail}</span>}</div>{children}</div>;
}

export function SettingsDialog({
  preferences, account, onClose, onPreferencesChange, onDisconnect, onSync, onCacheClear,
}: {
  preferences: UserPreferences; account: AccountStatus; onClose: () => void;
  onPreferencesChange: (value: UserPreferences) => void;
  onDisconnect: () => void; onSync: () => void; onCacheClear: () => Promise<void>;
}) {
  const [section, setSection] = useState<SettingsSection>("appearance");
  const [provider, setProvider] = useState<AIProvider>("openai");
  const [model, setModel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [credentialSaved, setCredentialSaved] = useState(false);
  const [savingCredential, setSavingCredential] = useState(false);
  const [aiSettingsLoading, setAiSettingsLoading] = useState(true);
  const [aiError, setAiError] = useState("");
  const [localSettings] = useState(readLocalAISettings);
  const [localEndpoint, setLocalEndpoint] = useState(localSettings.endpoint);
  const [localModel, setLocalModel] = useState(localSettings.model);
  const [localStatus, setLocalStatus] = useState("");
  const [manualText, setManualText] = useState("");
  const [manualResult, setManualResult] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const dialogRef = useModalFocus<HTMLElement>();
  const aiSettingsRequest = useRef(0);
  const posthogConfigured = !!(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN || process.env.NEXT_PUBLIC_POSTHOG_KEY);

  useEffect(() => {
    void loadAISettings();
    // Load the selected provider's server-side configuration after the dialog mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(next: Partial<UserPreferences>) {
    if (next.theme && next.theme !== preferences.theme) captureOptional("theme_changed");
    onPreferencesChange({ ...preferences, ...next });
  }

  async function loadAISettings(selectedProvider: AIProvider = provider) {
    const requestId = ++aiSettingsRequest.current;
    setAiSettingsLoading(true);
    try {
      const response = await fetch("/api/ai/settings", { cache: "no-store" });
      if (!response.ok) return;
      const value = await response.json() as { providers: Record<string, { model?: string; endpoint?: string; configured: boolean }> };
      if (requestId !== aiSettingsRequest.current) return;
      const selected = value.providers[selectedProvider];
      setModel(selected?.model ?? "");
      setEndpoint(selected?.endpoint ?? "");
      setCredentialSaved(!!selected?.configured);
    } catch { /* AI settings are optional when Gmail is disconnected. */ }
    finally { if (requestId === aiSettingsRequest.current) setAiSettingsLoading(false); }
  }

  async function saveCredential() {
    setAiError("");
    setSavingCredential(true);
    try {
      const response = await fetch("/api/ai/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model, endpoint, apiKey: apiKey || undefined }),
      });
      const value = await response.json() as { error?: string; configured?: boolean };
      if (!response.ok) throw new Error(value.error ?? "Unable to save provider settings.");
      setApiKey("");
      setCredentialSaved(!!value.configured);
    } catch (error) { setAiError(error instanceof Error ? error.message : "Unable to save provider settings."); }
    finally { setSavingCredential(false); }
  }

  async function removeCredential() {
    setAiError("");
    const response = await fetch(`/api/ai/settings?provider=${provider}`, { method: "DELETE" });
    if (!response.ok) { setAiError("Unable to remove this credential."); return; }
    setCredentialSaved(false);
    setApiKey("");
  }

  async function testProvider() {
    setAiError("");
    setSavingCredential(true);
    try {
      const response = await fetch("/api/ai/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
      const value = await response.json() as { error?: string; success?: boolean };
      if (!response.ok) throw new Error(value.error ?? "Provider test failed.");
      setAiError("Connection succeeded. Only a short test string was sent.");
    } catch (error) { setAiError(error instanceof Error ? error.message : "Provider test failed."); }
    finally { setSavingCredential(false); }
  }

  async function sendManualText() {
    setManualBusy(true);
    setManualResult("");
    try {
      const response = await fetch("/api/ai/manual-text", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, text: manualText, model }),
      });
      const value = await response.json() as { error?: string; result?: string };
      if (!response.ok) throw new Error(value.error ?? "Request failed.");
      setManualResult(value.result ?? "");
    } catch (error) { setManualResult(error instanceof Error ? error.message : "Request failed."); }
    finally { setManualBusy(false); }
  }

  async function testLocalRuntime() {
    setLocalStatus("Checking local runtime…");
    try {
      const endpoint = validateLocalRuntime(localEndpoint);
      endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/api/tags`;
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Runtime did not respond successfully.");
      const result = await response.json() as { models?: Array<{ name?: string }> };
      setLocalStatus(`Connected locally${result.models?.length ? ` · ${result.models.length} model${result.models.length === 1 ? "" : "s"} available` : " · no models found"}.`);
    } catch { setLocalStatus("Local runtime unavailable. Check that Ollama is running and allows this site’s browser origin."); }
  }

  function saveLocalAI() {
    localStorage.setItem(localSettingsKey, JSON.stringify({ endpoint: localEndpoint, model: localModel }));
    setLocalStatus("Local AI settings saved in this browser.");
  }

  const sections: Array<{ id: SettingsSection; label: string; icon: typeof Palette }> = [
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "account", label: "Email account", icon: Link2 },
    { id: "ai", label: "AI", icon: Sparkles },
    { id: "privacy", label: "Privacy", icon: ShieldCheck },
    { id: "shortcuts", label: "Shortcuts", icon: SlidersHorizontal },
  ];
  const sectionInfo: Record<SettingsSection, { title: string; detail: string }> = {
    appearance: { title: "Appearance", detail: "Set the feel and proportions of your workspace." },
    account: { title: "Email account", detail: "Connection and synchronisation for your Gmail account." },
    ai: { title: "AI preferences", detail: "Local models can work with mail. Cloud providers are limited to text you enter here." },
    privacy: { title: "Privacy & analytics", detail: "Manage optional analytics and local data." },
    shortcuts: { title: "Keyboard shortcuts", detail: "Navigate and act without leaving the keyboard." },
  };

  return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="dialog-header"><strong className="dialog-title" id="settings-title">Settings</strong><button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}><X size={16} /></button></header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">{sections.map(({ id, label, icon: Icon }) => <button key={id} className={section === id ? "active" : ""} onClick={() => { setSection(id); if (id === "ai") captureOptional("ai_provider_settings_opened"); }}><Icon size={14} />{label}</button>)}</nav>
        <div className="settings-content">
          <h2 className="settings-heading">{sectionInfo[section].title}</h2><p className="settings-description">{sectionInfo[section].detail}</p>
          {section === "appearance" && <>
            <div className="settings-group"><Row title="Theme" detail="Follow your system or choose a fixed appearance."><select className="settings-select" aria-label="Theme" value={preferences.theme} onChange={(event) => update({ theme: event.target.value as ThemePreference })}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></Row></div>
            <div className="settings-group"><Row title="Accent colour" detail="Used for focus, selection, and important actions."><div className="accent-options">{(["blue", "violet", "green", "orange"] as AccentPreference[]).map((accent) => <button key={accent} type="button" aria-label={`${accent} accent`} aria-pressed={preferences.accent === accent} className={`accent-dot ${preferences.accent === accent ? "active" : ""}`} style={{ background: ({ blue: "#426bda", violet: "#7858c7", green: "#287d59", orange: "#bf6a2b" })[accent] }} onClick={() => update({ accent })} />)}</div></Row></div>
            <div className="settings-group"><Row title="Email density" detail="Choose the amount of space in the message list."><select className="settings-select" aria-label="Email density" value={preferences.density} onChange={(event) => update({ density: event.target.value as DensityPreference })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></Row></div>
            <div className="settings-group"><Row title="Show sidebar" detail="Collapse navigation to icon-only mode."><Toggle checked={preferences.sidebarVisible} label="Show sidebar" onChange={(sidebarVisible) => update({ sidebarVisible })} /></Row><Row title="Sidebar width"><input aria-label="Sidebar width" type="range" min={180} max={340} value={preferences.sidebarWidth} onChange={(event) => update({ sidebarWidth: Number(event.target.value) })} /></Row><Row title="Message list width"><input aria-label="Message list width" type="range" min={300} max={560} value={preferences.listWidth} onChange={(event) => update({ listWidth: Number(event.target.value) })} /></Row><Row title="Reading pane width"><input aria-label="Reading pane width" type="range" min={400} max={1200} value={preferences.readingWidth} onChange={(event) => update({ readingWidth: Number(event.target.value) })} /></Row></div>
            <div className="settings-group"><Row title="Pane arrangement" detail="Choose how the message list and reader share the main area."><select className="settings-select" aria-label="Pane arrangement" value={preferences.paneArrangement} onChange={(event) => update({ paneArrangement: event.target.value as UserPreferences["paneArrangement"] })}><option value="vertical">Side by side</option><option value="horizontal">Stacked</option></select></Row><Row title="Keyboard shortcuts" detail="Use c, /, j/k, e, #, r and f when not typing."><Toggle checked={preferences.shortcutsEnabled} label="Enable keyboard shortcuts" onChange={(shortcutsEnabled) => update({ shortcutsEnabled })} /></Row></div>
          </>}
          {section === "account" && <>
            <div className="settings-group"><Row title={account.email ?? "No Gmail account connected"} detail={account.connected ? `Connected to Gmail${account.lastSyncedAt ? ` · last synced ${new Date(account.lastSyncedAt).toLocaleString()}` : ""}` : "Connect Gmail to load and send real messages."}><span className={`status-dot ${account.connected ? "connected" : ""}`} /></Row><div style={{ display: "flex", gap: 8, marginTop: 12 }}><button className="button-secondary" onClick={onSync} disabled={!account.connected}><RotateCcw size={13} /> Sync now</button>{account.connected && <><a href="/api/auth/google" className="button-secondary" style={{ textDecoration: "none" }}>Reconnect Gmail</a><button className="danger-button" onClick={onDisconnect}>Disconnect Gmail</button></>}</div></div>
            <div className="settings-group"><div className="settings-notice">Disconnecting revokes the Google grant when possible and clears the account token, local mail cache, and drafts on this device.</div></div>
          </>}
          {section === "ai" && <>
            <div className="settings-notice" style={{ marginBottom: 14 }}><LockKeyhole size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />Email bodies, subjects, attachments, and derived email content are never sent to OpenAI, Anthropic, OpenRouter, or another cloud AI. Email actions require an explicitly configured local runtime.</div>
            <div className="settings-group"><Row title="Local runtime" detail="Email summaries and reply drafts run directly from this browser to your local Ollama instance."><span className="sync-state"><span className={`status-dot ${localStatus.startsWith("Connected") ? "connected" : ""}`} />Local only</span></Row><label className="settings-row-copy" style={{ display: "grid", marginTop: 10 }}>Local Ollama URL<input className="settings-text settings-wide-input" value={localEndpoint} onChange={(event) => setLocalEndpoint(event.target.value)} placeholder="http://localhost:11434" /></label><label className="settings-row-copy" style={{ display: "grid", marginTop: 10 }}>Model name<input className="settings-text settings-wide-input" value={localModel} onChange={(event) => setLocalModel(event.target.value)} placeholder="e.g. llama3.2" /></label><div style={{ display: "flex", gap: 7, marginTop: 9 }}><button className="button-secondary" onClick={() => void testLocalRuntime()}>Test local runtime</button><button className="button-secondary" onClick={saveLocalAI}>Save local settings</button></div>{localStatus && <p role="status" className="settings-description" style={{ marginTop: 8, marginBottom: 0 }}>{localStatus}</p>}</div>
            <div className="settings-group"><Row title="Automatic processing" detail="Off in V1. SlateMail never processes email in the background." ><span className="settings-description" style={{ margin: 0 }}>Disabled</span></Row></div>
      <div className="settings-group"><Row title="External provider" detail="Cloud API credentials are encrypted server-side and only receive manual text entered below."><select className="settings-select" aria-label="External AI provider" value={provider} disabled={aiSettingsLoading} onChange={(event) => { const next = event.target.value as AIProvider; setProvider(next); setCredentialSaved(false); setModel(""); setEndpoint(""); setAiError(""); void loadAISettings(next); }}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openrouter">OpenRouter</option></select></Row>{aiSettingsLoading && <p className="settings-description" role="status">Loading saved provider settings…</p>}<label className="settings-row-copy" style={{ display: "grid", marginTop: 12 }}>Model<input className="settings-text settings-wide-input" value={model} disabled={aiSettingsLoading} onChange={(event) => setModel(event.target.value)} placeholder={`Model ID supported by ${providerNames[provider]}`} /></label><label className="settings-row-copy" style={{ display: "grid", marginTop: 10 }}>Custom API path on provider host (optional)<input className="settings-text settings-wide-input" value={endpoint} disabled={aiSettingsLoading} onChange={(event) => setEndpoint(event.target.value)} placeholder="Provider default (same HTTPS host)" /></label><label className="settings-row-copy" style={{ display: "grid", marginTop: 10 }}>API key{credentialSaved && <span>Saved encrypted; leave blank to keep it.</span>}<input className="settings-text settings-wide-input" type="password" autoComplete="new-password" value={apiKey} disabled={aiSettingsLoading} onChange={(event) => setApiKey(event.target.value)} placeholder={credentialSaved ? "Replace key" : "Paste API key"} /></label><div style={{ display: "flex", gap: 7, marginTop: 10 }}><button className="button-primary" onClick={() => void saveCredential()} disabled={aiSettingsLoading || savingCredential || (!apiKey && !credentialSaved)}>{savingCredential ? "Working…" : "Save settings"}</button><button className="button-secondary" onClick={() => void testProvider()} disabled={aiSettingsLoading || savingCredential || !credentialSaved}>Test connection</button>{credentialSaved && <button className="danger-button" onClick={() => void removeCredential()} disabled={aiSettingsLoading}>Remove key</button>}</div>{aiError && <p role="status" className="settings-description" style={{ color: aiError.startsWith("Connection") ? "var(--success)" : "var(--danger)", marginTop: 8, marginBottom: 0 }}>{aiError}</p>}</div>
            <div className="settings-group"><strong style={{ fontSize: 11 }}>Manual cloud text tool</strong><p className="settings-description" style={{ marginTop: 5, marginBottom: 10 }}>Only text you deliberately enter here is sent to {providerNames[provider]}. Never paste email or email-derived content.</p><textarea className="settings-text settings-wide-input" style={{ minHeight: 72, resize: "vertical" }} value={manualText} onChange={(event) => setManualText(event.target.value)} placeholder="Enter non-email text to revise…" /><button className="button-secondary" style={{ marginTop: 8 }} onClick={() => void sendManualText()} disabled={!credentialSaved || manualBusy || !manualText.trim()}>{manualBusy ? "Sending text…" : "Send entered text to provider"}</button>{manualResult && <div className="settings-notice" style={{ whiteSpace: "pre-wrap", marginTop: 9 }}>{manualResult}</div>}</div>
          </>}
          {section === "privacy" && <>
            <div className="settings-group"><Row title="Optional analytics" detail={`${posthogConfigured ? "Limited product events only; never mail or account identifiers." : "PostHog is not configured, so no analytics events are currently sent."} The preference is remembered for this browser.`}><Toggle checked={preferences.analyticsEnabled} label="Allow optional PostHog analytics when configured" onChange={(analyticsEnabled) => update({ analyticsEnabled, analyticsConsentGiven: true })} /></Row><div className="settings-notice" style={{ marginTop: 10 }}>Session replay, autocapture, identity tracking, search terms, and sensitive screen data are disabled. Opting out stops optional PostHog capture immediately; it does not delete data already sent. If your deployment requires consent, set `NEXT_PUBLIC_POSTHOG_REQUIRES_CONSENT=true` so tracking starts disabled until you enable it here.</div><a href="/privacy" className="button-secondary" style={{ marginTop: 10, width: "fit-content", textDecoration: "none" }}>Privacy policy <ArrowUpRightIcon /></a></div>
            <div className="settings-group"><Row title="Clear local mail and drafts" detail="Remove cached message bodies, attachment metadata, and offline drafts from this browser."><button className="danger-button" onClick={() => void onCacheClear()}><Trash2 size={12} /> Clear local data</button></Row></div>
          </>}
          {section === "shortcuts" && <div className="settings-group">{[["c", "Compose"], ["/", "Search mail"], ["j / k", "Next / previous conversation"], ["Enter", "Open selected conversation"], ["e", "Archive"], ["#", "Move to Trash"], ["r", "Reply"], ["f", "Forward"], ["Alt + 1–6", "Navigate Inbox, Starred, Drafts, Sent, Archive, Trash"], ["Esc", "Close the current pane or dialog"]].map(([key, label]) => <div className="settings-row" key={key}><span className="settings-row-copy"><strong>{label}</strong></span><kbd>{key}</kbd></div>)}</div>}
        </div>
      </div>
    </section>
  </div>;
}

function ArrowUpRightIcon() { return <span aria-hidden="true">↗</span>; }

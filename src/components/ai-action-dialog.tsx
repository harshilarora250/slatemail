"use client";

import { useState } from "react";
import { LoaderCircle, LockKeyhole, Sparkles, X } from "lucide-react";
import type { MailDraft, MailThread } from "@/domain/mail";
import { runLocalMailAI, type LocalMailTask } from "@/providers/ai/local-runtime";
import { useModalFocus } from "@/components/use-modal-focus";
import { captureOptional } from "@/analytics/client";

const settingsKey = "slatemail-local-ai-v1";
const taskLabels: Record<LocalMailTask, string> = {
  summary: "Summarize this email",
  "conversation-summary": "Summarize conversation",
  reply: "Draft a reply",
  rewrite: "Rewrite selected text",
  tone: "Change tone",
  clarity: "Improve clarity and grammar",
};

function readLocalSettings(): { endpoint: string; model: string } {
  const defaultEndpoint = process.env.NEXT_PUBLIC_LOCAL_AI_URL || "http://localhost:11434";
  if (typeof window === "undefined") return { endpoint: defaultEndpoint, model: "" };
  try {
    const saved = localStorage.getItem(settingsKey);
    const value = saved ? JSON.parse(saved) as { endpoint?: string; model?: string } : {};
    return { endpoint: value.endpoint ?? defaultEndpoint, model: value.model ?? "" };
  } catch { return { endpoint: defaultEndpoint, model: "" }; }
}

function defaultInput(thread: MailThread): string {
  return thread.messages.map((message) => [
    `From: ${message.from.name || message.from.email}`,
    `Date: ${message.date}`,
    `Subject: ${message.subject}`,
    message.textBody || safeHtmlText(message.safeHtmlBody) || message.snippet,
  ].join("\n")).join("\n\n---\n\n").slice(-30_000);
}

function safeHtmlText(html: string | undefined): string {
  if (!html || typeof DOMParser === "undefined") return "";
  const document = new DOMParser().parseFromString(html, "text/html");
  return document.body.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

export function AIActionDialog({
  thread, onClose, onUseAsDraft,
}: {
  thread: MailThread; onClose: () => void; onUseAsDraft: (draft: Partial<MailDraft>) => void;
}) {
  const [task, setTask] = useState<LocalMailTask>("summary");
  const [text, setText] = useState(() => defaultInput(thread));
  const [tone, setTone] = useState("warm and concise");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [localSettings] = useState(readLocalSettings);
  const [endpoint] = useState(localSettings.endpoint);
  const [model] = useState(localSettings.model);
  const dialogRef = useModalFocus<HTMLElement>();

  async function generate() {
    setBusy(true);
    setError("");
    setResult("");
    try {
      const generated = await runLocalMailAI({
        endpoint,
        model,
        task,
        text,
        extraInstruction: task === "tone" ? `Use a ${tone} tone.` : undefined,
      });
      if (!generated.trim()) throw new Error("The local model returned no text. Try a different model or prompt.");
      setResult(generated.trim());
      captureOptional("local_ai_action_completed");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Local AI request failed."); }
    finally { setBusy(false); }
  }

  function useAsDraft() {
    const latest = thread.messages.at(-1);
    if (!latest || !result) return;
    const subject = /^re:/i.test(latest.subject) ? latest.subject : `Re: ${latest.subject}`;
    onUseAsDraft({ to: latest.from.email, subject, threadId: thread.id, body: result });
    onClose();
  }

  return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <section ref={dialogRef} className="dialog ai-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-title">
      <header className="dialog-header"><strong className="dialog-title" id="ai-title"><Sparkles size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />Local AI assistant</strong><button className="icon-button" aria-label="Close AI assistant" onClick={onClose}><X size={16} /></button></header>
      <div style={{ padding: "16px 18px", overflow: "auto" }}>
        <div className="settings-notice" style={{ marginBottom: 14 }}><LockKeyhole size={13} style={{ verticalAlign: "middle", marginRight: 6 }} />Email content is sent directly from this browser to your configured loopback Ollama runtime ({endpoint}) only. It is never sent to a cloud AI provider.</div>
        <label className="settings-row-copy" style={{ display: "grid", gap: 7 }}>Action<select className="settings-select" value={task} onChange={(event) => { setTask(event.target.value as LocalMailTask); setResult(""); }} aria-label="Local AI action">{Object.entries(taskLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {task === "tone" && <label className="settings-row-copy" style={{ display: "grid", gap: 7, marginTop: 12 }}>Tone<input className="settings-text settings-wide-input" value={tone} onChange={(event) => setTone(event.target.value)} /></label>}
        <label className="settings-row-copy" style={{ display: "grid", gap: 7, marginTop: 13 }}>Email text (processed locally)<textarea className="settings-text settings-wide-input" style={{ minHeight: 150, resize: "vertical", lineHeight: 1.5 }} value={text} onChange={(event) => setText(event.target.value)} /></label>
        {error && <p role="alert" className="compose-error">{error}</p>}
        {result && <div className="settings-group"><strong style={{ fontSize: 11 }}>Result</strong><p className="local-ai-result">{result}</p>{task !== "summary" && task !== "conversation-summary" && <button className="button-secondary" onClick={useAsDraft}>Use as reply draft</button>}</div>}
      </div>
      <footer className="compose-footer"><span className="settings-description" style={{ margin: 0 }}>{model ? `Model: ${model}` : "Choose a local model in Settings first."}</span><button className="button-primary" onClick={() => void generate()} disabled={busy || !text.trim() || !model.trim()}>{busy ? <><LoaderCircle size={13} className="animate-spin" />Working locally…</> : <><Sparkles size={13} />Generate locally</>}</button></footer>
    </section>
  </div>;
}

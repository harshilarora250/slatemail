"use client";

import { useEffect, useRef, useState } from "react";
import { FilePlus2, LoaderCircle, Send, Trash2, X } from "lucide-react";
import type { AccountStatus, LocalAttachment, MailDraft } from "@/domain/mail";
import { getDrafts, removeDraft, saveDraft } from "@/client/mail-cache";
import { useModalFocus } from "@/components/use-modal-focus";

const maxAttachmentBytes = 20_000_000;

function isValidAddressList(value: string): boolean {
  if (!value.trim()) return true;
  return value.split(",").every((address) => /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(address.trim()));
}

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Unable to read ${file.name}.`));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma < 0 ? "" : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function ComposeDialog({
  seed, account, onClose, onSent, onDraftSaved,
}: {
  seed?: Partial<MailDraft>; account: AccountStatus; onClose: () => void;
  onSent: () => void; onDraftSaved: (draft?: MailDraft) => void;
}) {
  const [draft, setDraft] = useState<MailDraft>(() => ({
    id: seed?.id ?? crypto.randomUUID(),
    remoteId: seed?.remoteId,
    remoteVersion: seed?.remoteVersion,
    threadId: seed?.threadId,
    inReplyTo: seed?.inReplyTo,
    references: seed?.references,
    to: seed?.to ?? "", cc: seed?.cc ?? "", bcc: seed?.bcc ?? "",
    subject: seed?.subject ?? "", body: seed?.body ?? "",
    attachments: seed?.attachments ?? [],
    updatedAt: seed?.updatedAt ?? Date.now(), revision: seed?.revision ?? 0,
    status: seed?.status ?? "local",
  }));
  const [showCc, setShowCc] = useState(!!seed?.cc);
  const [showBcc, setShowBcc] = useState(!!seed?.bcc);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [statusText, setStatusText] = useState(seed?.status === "synced" ? "Saved to Gmail" : "Saved on this device");
  const [uploading, setUploading] = useState(false);
  const [sendUncertain, setSendUncertain] = useState(seed?.status === "sending" && !!seed.sendAttemptId);
  const fileInput = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  const syncInFlight = useRef(false);
  const dirtyWhileSaving = useRef(false);
  const sendAttemptId = useRef<string | undefined>(draft.sendAttemptId);
  const dialogRef = useModalFocus<HTMLFormElement>();

  useEffect(() => {
    if (!seed?.id) return;
    void getDrafts().then((drafts) => {
      const stored = drafts.find((item) => item.id === seed.id);
      if (stored) {
        draftRef.current = stored;
        setDraft(stored);
        setShowCc(!!stored.cc);
        setShowBcc(!!stored.bcc);
        setStatusText(stored.status === "synced" ? "Saved to Gmail" : "Saved on this device");
        return;
      }
      if (!seed.remoteId || !account.connected || !navigator.onLine) return;
      setLoadingRemote(true);
      return fetch(`/api/mail/drafts?draftId=${encodeURIComponent(seed.remoteId)}`, { cache: "no-store" }).then(async (response) => {
        const value = await response.json() as { error?: string; id?: string; threadId?: string; to?: string; cc?: string; bcc?: string; subject?: string; body?: string; attachments?: LocalAttachment[]; updatedAt?: number; version?: string };
        if (!response.ok) throw new Error(value.error ?? "Unable to open this Gmail draft.");
        if (draftRef.current.revision > 0) return;
        const loaded: MailDraft = {
          ...draftRef.current,
          id: seed.id!,
          remoteId: value.id,
          remoteVersion: value.version,
          threadId: value.threadId,
          to: value.to ?? "", cc: value.cc ?? "", bcc: value.bcc ?? "",
          subject: value.subject ?? "", body: value.body ?? "",
          attachments: value.attachments ?? [],
          updatedAt: value.updatedAt ?? Date.now(),
          status: "synced",
        };
        draftRef.current = loaded;
        setDraft(loaded);
        setShowCc(!!loaded.cc);
        setShowBcc(!!loaded.bcc);
        setStatusText("Saved to Gmail");
      }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Unable to open this Gmail draft.")).finally(() => setLoadingRemote(false));
    }).catch(() => undefined);
  }, [seed?.id, seed?.remoteId, account.connected]);

  useEffect(() => {
    const initial = draftRef.current;
    if (initial.remoteId || initial.revision > 0 || !(initial.to || initial.cc || initial.bcc || initial.subject || initial.body || initial.attachments?.length)) return;
    const prepared: MailDraft = { ...initial, revision: 1, updatedAt: Date.now(), status: "pending" };
    draftRef.current = prepared;
    void saveDraft(prepared).then(() => {
      setDraft(prepared);
      setStatusText(navigator.onLine && account.connected ? "Saved on this device · syncing to Gmail" : "Saved on this device · waiting for connection");
      onDraftSaved(prepared);
    }).catch(() => setError("This draft could not be saved to local storage. Keep this window open and try again."));
    // Prefilled reply/forward content is saved locally as soon as the composer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(patch: Partial<MailDraft>) {
    const next: MailDraft = {
      ...draftRef.current,
      ...patch,
      updatedAt: Date.now(),
      revision: draftRef.current.revision + 1,
      status: draftRef.current.status === "conflict" ? "conflict" : "pending",
    };
    draftRef.current = next;
    setDraft(next);
    setStatusText("Saving locally…");
    setError("");
    void saveDraft(next).then(() => {
      setStatusText(navigator.onLine && account.connected ? "Saved on this device · syncing to Gmail" : "Saved on this device · waiting for connection");
      onDraftSaved(next);
    }).catch(() => setError("This draft could not be saved to local storage. Keep this window open and try again."));
  }

  async function syncRemoteDraft() {
    const snapshot = draftRef.current;
    if (syncInFlight.current) { dirtyWhileSaving.current = true; return; }
    if (!account.connected || !navigator.onLine || snapshot.revision === 0 || snapshot.status === "conflict") return;
    syncInFlight.current = true;
    try {
      setSaving(true);
      const response = await fetch("/api/mail/drafts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          localDraftId: snapshot.id,
          draftId: snapshot.remoteId,
          expectedVersion: snapshot.remoteVersion,
          threadId: snapshot.threadId,
          inReplyTo: snapshot.inReplyTo,
          references: snapshot.references,
          to: snapshot.to,
          cc: snapshot.cc,
          bcc: snapshot.bcc,
          subject: snapshot.subject,
          body: snapshot.body,
          attachments: snapshot.attachments ?? [],
        }),
      });
      const value = await response.json() as { error?: string; id?: string; version?: string; remoteVersion?: string };
      if (response.status === 409) {
        const conflict = { ...draftRef.current, status: "conflict" as const, conflictingRemoteVersion: value.remoteVersion };
        draftRef.current = conflict;
        setDraft(conflict);
        await saveDraft(conflict);
        setStatusText("Conflict · your local version is kept");
        setError(value.error ?? "A newer version exists in Gmail. Your local copy has been preserved.");
      } else if (!response.ok) {
        setStatusText("Saved locally · Gmail sync will retry");
      } else {
        const current = draftRef.current;
        const sameRevision = current.revision === snapshot.revision;
        const synced: MailDraft = {
          ...current,
          remoteId: value.id,
          remoteVersion: value.version,
          status: sameRevision ? "synced" : "pending",
        };
        draftRef.current = synced;
        setDraft(synced);
        await saveDraft(synced);
        setStatusText(sameRevision ? "Saved to Gmail" : "Saved locally · syncing latest edit");
        onDraftSaved(synced);
      }
    } catch {
      setStatusText("Saved locally · Gmail sync will retry");
    } finally {
      setSaving(false);
      syncInFlight.current = false;
      if (dirtyWhileSaving.current) {
        dirtyWhileSaving.current = false;
        window.setTimeout(() => void syncRemoteDraft(), 200);
      }
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void syncRemoteDraft(), 1100);
    return () => window.clearTimeout(timer);
    // A draft's content revision is the only trigger for synchronization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.revision]);

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const current = draftRef.current.attachments ?? [];
    const additions = Array.from(files);
    if (current.length + additions.length > 10 || current.reduce((sum, item) => sum + item.size, 0) + additions.reduce((sum, file) => sum + file.size, 0) > maxAttachmentBytes) {
      setError("Choose up to 10 attachments with a combined size under 20 MB.");
      return;
    }
    setUploading(true);
    try {
      const uploaded: LocalAttachment[] = await Promise.all(additions.map(async (file) => ({
        name: file.name.slice(0, 180),
        mimeType: file.type || "application/octet-stream",
        data: await fileAsBase64(file),
        size: file.size,
      })));
      update({ attachments: [...current, ...uploaded] });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to add attachment."); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function discard() {
    if (draft.remoteId && navigator.onLine && account.connected) {
      const response = await fetch("/api/mail/drafts", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId: draft.remoteId }) });
      if (!response.ok) {
        const value = await response.json() as { error?: string };
        setError(value.error ?? "Gmail did not confirm that the draft was discarded.");
        return;
      }
    }
    await removeDraft(draft.id).catch(() => undefined);
    onDraftSaved();
    onClose();
  }

  async function keepLocalVersion() {
    if (!draft.conflictingRemoteVersion) {
      setError("Gmail's current version could not be confirmed. Keep this local draft and reconnect before trying again.");
      return;
    }
    const rebased: MailDraft = {
      ...draftRef.current,
      remoteVersion: draft.conflictingRemoteVersion,
      conflictingRemoteVersion: undefined,
      status: "pending",
      revision: draftRef.current.revision + 1,
    };
    draftRef.current = rebased;
    setDraft(rebased);
    setError("");
    setStatusText("Your local version will replace the newer Gmail copy");
    await saveDraft(rebased);
  }

  async function selectGmailVersion() {
    await removeDraft(draft.id).catch(() => undefined);
    onDraftSaved();
    onClose();
  }

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!draft.to.trim() || !isValidAddressList(draft.to) || !isValidAddressList(draft.cc) || !isValidAddressList(draft.bcc)) {
      setError("Enter a valid recipient address in To, Cc, or Bcc.");
      return;
    }
    if (!navigator.onLine || !account.connected) {
      setError("This message has not been sent. It is saved locally and will remain a draft until Gmail is connected.");
      return;
    }
    if (!sendAttemptId.current) sendAttemptId.current = crypto.randomUUID();
    const latest = { ...draftRef.current, sendAttemptId: sendAttemptId.current, status: "sending" as const, updatedAt: Date.now() };
    draftRef.current = latest;
    setDraft(latest);
    await saveDraft(latest).catch(() => undefined);
    setSending(true);
    try {
      const response = await fetch("/api/mail/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attemptId: sendAttemptId.current,
          draftId: latest.id,
          remoteDraftId: latest.remoteId,
          to: latest.to,
          cc: latest.cc,
          bcc: latest.bcc,
          subject: latest.subject,
          body: latest.body,
          threadId: latest.threadId,
          inReplyTo: latest.inReplyTo,
          references: latest.references,
          attachments: latest.attachments ?? [],
        }),
      });
      const value = await response.json() as { error?: string; sent?: boolean };
      if (!response.ok || !value.sent) {
        if (response.status === 409 || value.error?.toLowerCase().includes("uncertain")) setSendUncertain(true);
        throw new Error(value.error ?? "Gmail did not confirm that this message was sent.");
      }
      await removeDraft(latest.id).catch(() => undefined);
      onSent();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Gmail did not confirm the send. Your draft is preserved.";
      setError(message);
      const preserved = { ...draftRef.current, status: sendUncertain || message.toLowerCase().includes("uncertain") ? "sending" as const : "pending" as const };
      draftRef.current = preserved;
      setDraft(preserved);
      await saveDraft(preserved).catch(() => undefined);
      setStatusText("Not confirmed sent · draft preserved");
    } finally { setSending(false); }
  }

  return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <form ref={dialogRef} className="dialog compose-dialog" role="dialog" aria-modal="true" aria-labelledby="compose-title" onSubmit={(event) => void send(event)}>
      <header className="dialog-header"><strong className="dialog-title" id="compose-title">{draft.threadId ? "Reply" : "New message"}</strong><div style={{ display: "flex", alignItems: "center", gap: 7 }}><span className="settings-description" style={{ margin: 0 }}>{loadingRemote ? "Loading draft…" : saving ? "Syncing…" : statusText}</span><button type="button" className="icon-button" aria-label="Close composer" onClick={onClose}><X size={16} /></button></div></header>
      <div className="compose-fields">
        <div className="compose-line"><label className="compose-label" htmlFor="compose-to">To</label><input id="compose-to" className="compose-input" autoComplete="email" value={draft.to} onChange={(event) => update({ to: event.target.value })} /><button type="button" className="link-button" onClick={() => setShowCc(!showCc)}>Cc</button><button type="button" className="link-button" onClick={() => setShowBcc(!showBcc)}>Bcc</button></div>
        {showCc && <div className="compose-line"><label className="compose-label" htmlFor="compose-cc">Cc</label><input id="compose-cc" className="compose-input" autoComplete="email" value={draft.cc} onChange={(event) => update({ cc: event.target.value })} /></div>}
        {showBcc && <div className="compose-line"><label className="compose-label" htmlFor="compose-bcc">Bcc</label><input id="compose-bcc" className="compose-input" autoComplete="email" value={draft.bcc} onChange={(event) => update({ bcc: event.target.value })} /></div>}
        <div className="compose-line"><label className="compose-label" htmlFor="compose-subject">Subject</label><input id="compose-subject" className="compose-input" value={draft.subject} onChange={(event) => update({ subject: event.target.value })} /></div>
      </div>
      {draft.status === "conflict" && <div className="draft-conflict" role="alert"><strong>This draft changed in Gmail.</strong><span>Your local copy is preserved. Choose which version to keep.</span><div><button type="button" className="button-secondary" onClick={() => void keepLocalVersion()} disabled={!draft.conflictingRemoteVersion}>Replace Gmail with my version</button><button type="button" className="button-secondary" onClick={() => void selectGmailVersion()} disabled={!draft.conflictingRemoteVersion}>Use Gmail&apos;s latest copy</button></div></div>}
      <textarea className="compose-body" aria-label="Message body" placeholder="Write your message…" value={draft.body} onChange={(event) => update({ body: event.target.value })} />
      {(draft.attachments?.length ?? 0) > 0 && <div className="attachment-preview">{draft.attachments?.map((attachment, index) => <span className="attachment-remove" key={`${attachment.name}-${index}`}>{attachment.name} · {Math.max(1, Math.round(attachment.size / 1024))} KB<button type="button" aria-label={`Remove ${attachment.name}`} className="icon-button" onClick={() => update({ attachments: draft.attachments?.filter((_, itemIndex) => itemIndex !== index) })}><X size={11} /></button></span>)}</div>}
      {error && <div className="compose-error" role="alert">{error}</div>}
      {sendUncertain && <div className="compose-error" role="alert">The send result is uncertain. Check Gmail Sent before retrying. <button type="button" className="link-button" onClick={() => { sendAttemptId.current = undefined; const retryable = { ...draftRef.current, sendAttemptId: undefined, status: draftRef.current.remoteId ? "synced" as const : "pending" as const, revision: draftRef.current.revision + 1 }; draftRef.current = retryable; setDraft(retryable); void saveDraft(retryable); setSendUncertain(false); setError(""); }}>I checked Sent; allow a new attempt</button></div>}
      <footer className="compose-footer"><div className="compose-footer-left"><button type="submit" className="button-primary" disabled={sending || uploading || saving || sendUncertain || draft.status === "conflict" || (!!draft.remoteId && draft.status !== "synced")}><Send size={13} />{sending ? "Sending…" : "Send"}</button><button type="button" className="icon-button" title="Attach files" aria-label="Attach files" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? <LoaderCircle size={15} className="animate-spin" /> : <FilePlus2 size={15} />}</button><input ref={fileInput} type="file" multiple hidden onChange={(event) => void addFiles(event.target.files)} /></div><div className="compose-footer-right"><span className="settings-description" style={{ margin: 0 }}>Drafts save on this device first</span><button type="button" className="icon-button" aria-label="Discard draft" title="Discard draft" onClick={() => void discard()}><Trash2 size={15} /></button></div></footer>
    </form>
  </div>;
}

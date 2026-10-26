"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive, ArrowDownUp, ArrowLeft, ArrowLeftRight, ArrowUpRight, Check, CheckCheck,
  File, FileText, Forward, Inbox, LoaderCircle, Mail, Menu, Paperclip,
  PenLine, RefreshCw, Search, Settings2, Star, Trash2,
} from "lucide-react";
import type { AccountStatus, MailDraft, MailMessage, MailPage, MailThread } from "@/domain/mail";
import { cacheThread, cacheThreads, clearAllLocalData, clearCachedMessages, getCachedThread, getCachedThreads, getDrafts, getPendingMailOperations, queueMailOperation, removeMailOperation, type MailOperationAction } from "@/client/mail-cache";
import { threadMatchesMailbox, updateThreadForAction } from "@/client/operation-cache";
import { syncPendingDrafts } from "@/client/draft-sync";
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences, type UserPreferences } from "@/client/preferences";
import { ComposeDialog } from "@/components/compose-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { AIActionDialog } from "@/components/ai-action-dialog";
import { AnalyticsGate, captureOptional, setAnalyticsRuntimeEnabled } from "@/analytics/client";

type Folder = { id: string; name: string; unreadCount: number; type: string };

const coreFolders = [
  { id: "INBOX", label: "Inbox", icon: Inbox },
  { id: "STARRED", label: "Starred", icon: Star },
  { id: "DRAFT", label: "Drafts", icon: FileText },
  { id: "SENT", label: "Sent", icon: ArrowUpRight },
  { id: "ARCHIVE", label: "Archive", icon: Archive },
  { id: "TRASH", label: "Trash", icon: Trash2 },
];

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function displayName(message: MailMessage): string {
  return message.from.name || message.from.email || "Unknown sender";
}

function initials(account?: AccountStatus): string {
  const value = account?.name || account?.email || "S";
  return value.split(/[\s@.]/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "S";
}

function lastMessage(thread: MailThread): MailMessage | undefined {
  return [...thread.messages].sort((a, b) => b.date.localeCompare(a.date))[0];
}

function AppIconButton({ label, onClick, children, className = "", disabled = false }: {
  label: string; onClick: () => void; children: React.ReactNode; className?: string; disabled?: boolean;
}) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function MailboxApp() {
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFERENCES);
  const [account, setAccount] = useState<AccountStatus>({ connected: false });
  const [folders, setFolders] = useState<Folder[]>([]);
  const [currentFolder, setCurrentFolder] = useState("INBOX");
  const [threads, setThreads] = useState<MailThread[]>([]);
  const [activeThread, setActiveThread] = useState<MailThread | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searchValue, setSearchValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [syncing, setSyncing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeSeed, setComposeSeed] = useState<Partial<MailDraft> | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiThread, setAiThread] = useState<MailThread | null>(null);
  const [toast, setToast] = useState("");
  const [mobileReading, setMobileReading] = useState(false);
  const [draftCount, setDraftCount] = useState(0);
  const [remoteDraftCount, setRemoteDraftCount] = useState(0);
  const [oldestFirst, setOldestFirst] = useState(false);
  const [localDrafts, setLocalDrafts] = useState<MailDraft[]>([]);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [oauthMessage, setOauthMessage] = useState("");
  const flushingOperations = useRef(false);
  const activeDraftId = useRef<string | undefined>(undefined);
  const composeActive = useRef(false);
  const syncingRef = useRef(false);
  const connectedRef = useRef(account.connected);
  const currentFolderRef = useRef(currentFolder);
  const searchValueRef = useRef(searchValue);
  const previousSearchValue = useRef(searchValue);
  const syncMailboxRef = useRef<() => Promise<void>>(async () => undefined);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<MailThread | null>(null);
  activeRef.current = activeThread;
  connectedRef.current = account.connected;
  currentFolderRef.current = currentFolder;
  searchValueRef.current = searchValue;

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }, []);

  const applyPreferences = useCallback((value: UserPreferences) => {
    setPreferences(value);
    setAnalyticsRuntimeEnabled(value.analyticsEnabled);
    const root = document.documentElement;
    const dark = value.theme === "dark" || (value.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.accent = value.accent;
    root.style.setProperty("--sidebar-width", `${value.sidebarWidth}px`);
    root.style.setProperty("--list-width", `${value.listWidth}px`);
    root.style.setProperty("--reading-width", `${value.readingWidth}px`);
    savePreferences(value);
  }, []);

  useEffect(() => {
    const stored = loadPreferences();
    // Preferences are intentionally restored after hydration from local storage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreferences(stored);
    setAnalyticsRuntimeEnabled(stored.analyticsEnabled);
    setPreferencesReady(true);
    if (stored.analyticsEnabled) captureOptional("application_opened");
    const dark = stored.theme === "dark" || (stored.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.accent = stored.accent;
    document.documentElement.style.setProperty("--sidebar-width", `${stored.sidebarWidth}px`);
    document.documentElement.style.setProperty("--list-width", `${stored.listWidth}px`);
    document.documentElement.style.setProperty("--reading-width", `${stored.readingWidth}px`);
    void refreshDraftCount();
    void loadAccount();
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get("oauth");
    if (oauth) {
      const messages: Record<string, string> = {
        "not-configured": "Google OAuth is not configured on this server yet.",
        "invalid-state": "Google sign-in could not be verified. Please try again.",
        "account-mismatch": "Google returned a different account. Disconnect the current Gmail account before switching.",
        "refresh-token-missing": "Google did not return offline access. Remove SlateMail from Google security settings and retry.",
        cancelled: "Google account connection was cancelled.",
        "connection-failed": "Google account connection failed. Check OAuth configuration and try again.",
      };
      setOauthMessage(messages[oauth] ?? "Google sign-in could not be completed.");
      window.history.replaceState({}, "", window.location.pathname);
    }
    const connection = () => setOffline(!navigator.onLine);
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    const onOnline = () => { void syncMailboxRef.current(); };
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
      window.removeEventListener("online", onOnline);
    };
    // Initial state is read once from browser storage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (preferences.theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updateTheme = () => { document.documentElement.dataset.theme = media.matches ? "dark" : "light"; };
    media.addEventListener("change", updateTheme);
    return () => media.removeEventListener("change", updateTheme);
  }, [preferences.theme]);

  useEffect(() => {
    if (!account.connected) return;
    void loadMailbox(currentFolder, searchValue);
    void loadFolders();
    void flushPendingOperations();
    void syncPendingDrafts(activeDraftId.current);
    const interval = window.setInterval(() => void syncMailbox(), 45_000);
    return () => window.clearInterval(interval);
    // Account/folder changes establish a fresh list and a single poller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.connected, currentFolder]);

  useEffect(() => {
    if (!account.connected) return;
    if (previousSearchValue.current === searchValue) return;
    previousSearchValue.current = searchValue;
    const timer = window.setTimeout(() => void loadMailbox(currentFolder, searchValue), 300);
    return () => window.clearTimeout(timer);
    // The debounced callback intentionally uses the current folder/query closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchValue, account.connected, currentFolder]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target?.closest("input, textarea, select, [contenteditable='true'], [role='textbox']");
      if (typing || !preferences.shortcutsEnabled) {
        if (event.key === "Escape" && (composeOpen || settingsOpen || aiThread || activeRef.current)) closeActive();
        return;
      }
      if (event.altKey && /^[1-6]$/.test(event.key)) {
        event.preventDefault();
        const folder = coreFolders[Number(event.key) - 1];
        if (folder) { setCurrentFolder(folder.id); setActiveThread(null); setSearchValue(""); }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "c") { event.preventDefault(); beginCompose(); }
      else if (key === "/") { event.preventDefault(); searchRef.current?.focus(); }
      else if (key === "escape") closeActive();
      else if (key === "j" || key === "k") {
        event.preventDefault();
        const index = threads.findIndex((thread) => thread.id === activeRef.current?.id);
        const next = threads[Math.max(0, Math.min(threads.length - 1, index + (key === "j" ? 1 : -1)))];
        if (next) void openThread(next.id);
      } else if (key === "enter") {
        const first = threads.find((thread) => selected.has(thread.id)) ?? threads[0];
        if (first) void openThread(first.id);
      } else if (key === "e" && activeRef.current) void performAction(activeRef.current.id, "archive");
      else if (key === "#" && activeRef.current) void performAction(activeRef.current.id, "trash");
      else if (key === "r" && activeRef.current) replyTo(activeRef.current);
      else if (key === "f" && activeRef.current) forwardThread(activeRef.current);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
    // Keyboard handlers are re-registered when their referenced state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences.shortcutsEnabled, threads, selected, composeOpen, settingsOpen, aiThread]);

  async function refreshDraftCount(includeRemote = false, connected = connectedRef.current) {
    try {
      const drafts = await getDrafts();
      if (currentFolderRef.current !== "DRAFT") setLocalDrafts(drafts);
      const localOnlyCount = drafts.filter((draft) => !draft.remoteId).length;
      let remoteCount = remoteDraftCount;
      if (includeRemote && connected && navigator.onLine) {
        const response = await fetch("/api/mail/drafts?countOnly=1", { cache: "no-store" });
        if (response.ok) {
          const value = await response.json() as { count: number };
          remoteCount = value.count;
          setRemoteDraftCount(remoteCount);
        }
      }
      setDraftCount(remoteCount + localOnlyCount);
    } catch { setDraftCount(remoteDraftCount); }
  }

  async function loadAccount() {
    try {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      const value = await response.json() as AccountStatus & { error?: string };
      if (!response.ok && value.error) setOauthMessage(value.error);
      setAccount(value);
      if (value.connected) {
        setOauthMessage("");
        void refreshDraftCount(true, true);
      }
    } catch {
      setOffline(true);
    }
  }

  async function loadFolders() {
    try {
      const response = await fetch("/api/mail/labels", { cache: "no-store" });
      if (!response.ok) return;
      const value = await response.json() as { labels: Folder[] };
      setFolders(value.labels);
    } catch { /* Mail navigation remains usable with standard Gmail folders. */ }
  }

  async function loadMailbox(folder: string, query: string, quiet = false, pageToken?: string) {
    if (!account.connected) return;
    if (pageToken) setLoadingMore(true);
    else if (!quiet) { setLoading(true); setError(""); }
    try {
      if (folder === "DRAFT") {
        const local = await getDrafts();
        type RemoteDraft = { id: string; clientDraftId?: string; threadId: string; to: string; cc: string; bcc: string; subject: string; body: string; updatedAt: number; version: string; attachments: Array<{ filename: string; size: number }> };
        let remoteRows: RemoteDraft[] = [];
        if (navigator.onLine) {
          const response = await fetch("/api/mail/drafts", { cache: "no-store" });
          if (response.ok) {
            const value = await response.json() as { drafts: RemoteDraft[] };
            remoteRows = value.drafts;
          }
        }
        const remote = remoteRows.map((draft): MailDraft => ({
          id: draft.clientDraftId || `remote-${draft.id}`, remoteId: draft.id, threadId: draft.threadId,
          to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body,
          updatedAt: draft.updatedAt, remoteVersion: draft.version, revision: 0, status: "synced",
        }));
        const byRemote = new Map(remote.map((draft) => [draft.remoteId, draft]));
        const byLocalId = new Map(remote.map((draft) => [draft.id, draft]));
        const merged = local.map((draft) => {
          const remoteDraft = (draft.remoteId ? byRemote.get(draft.remoteId) : undefined) ?? byLocalId.get(draft.id);
          if (!remoteDraft) return draft;
          const versionChanged = !!draft.remoteVersion && draft.remoteVersion !== remoteDraft.remoteVersion;
          const row = remoteRows.find((item) => item.id === remoteDraft.remoteId);
          const localAttachments = (draft.attachments ?? []).map((item) => `${item.name}:${item.size}`).sort();
          const remoteAttachments = (row?.attachments ?? []).map((item) => `${item.filename}:${item.size}`).sort();
          const contentMatches = draft.to.trim() === remoteDraft.to.trim()
            && draft.cc.trim() === remoteDraft.cc.trim()
            && draft.bcc.trim() === remoteDraft.bcc.trim()
            && draft.subject.trim() === remoteDraft.subject.trim()
            && draft.body.trim() === remoteDraft.body.trim()
            && localAttachments.join("|") === remoteAttachments.join("|");
          if (draft.status === "conflict" || ((draft.status === "pending" || draft.status === "local") && !contentMatches && (!draft.remoteVersion || versionChanged))) {
            return { ...draft, status: "conflict" as const, remoteId: remoteDraft.remoteId, conflictingRemoteVersion: remoteDraft.remoteVersion };
          }
          if ((draft.status === "pending" || draft.status === "local") && contentMatches) {
            return { ...draft, remoteId: remoteDraft.remoteId, remoteVersion: remoteDraft.remoteVersion, status: "synced" as const };
          }
          if (draft.status === "pending" || draft.status === "sending" || draft.status === "local") return { ...draft, remoteId: remoteDraft.remoteId };
          return { ...draft, ...remoteDraft, id: draft.id, attachments: draft.attachments ?? [], revision: draft.revision, remoteVersion: remoteDraft.remoteVersion, status: "synced" as const };
        });
        const localRemoteIds = new Set(local.flatMap((draft) => [draft.remoteId, draft.id]).filter(Boolean));
        const all = [...merged, ...remote.filter((draft) => !localRemoteIds.has(draft.remoteId) && !localRemoteIds.has(draft.id))].sort((a, b) => b.updatedAt - a.updatedAt);
        setLocalDrafts(all);
        setDraftCount(all.length);
        setRemoteDraftCount(remote.length);
        setThreads([]);
        setNextPageToken(undefined);
        setActiveThread(null);
        setOffline(!navigator.onLine);
        return;
      }
      const params = new URLSearchParams({ mailbox: folder, q: query });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await fetch(`/api/mail?${params}`, { cache: "no-store" });
      if (!response.ok) {
        const value = await response.json() as { error?: string };
        throw new Error(value.error ?? "Unable to load Gmail.");
      }
      const value = await response.json() as MailPage;
      setThreads((previous) => pageToken ? [...previous, ...value.threads] : value.threads);
      setNextPageToken(value.nextPageToken);
      setOffline(false);
      setError("");
      await cacheThreads(value.threads);
    } catch (caught) {
      let cached = await getCachedThreads().catch(() => []);
      cached = cached.filter((thread) => threadMatchesMailbox(
        thread,
        folder,
        query,
        `${thread.messages.map((message) => `${message.from.name} ${message.from.email} ${message.subject} ${message.snippet}`).join(" ")} ${thread.snippet}`,
      ));
      if (cached.length) {
        setThreads(cached);
        setNextPageToken(undefined);
        setOffline(true);
        if (!quiet) setError("Showing cached mail. Reconnect to refresh or change mailbox state.");
      } else if (!quiet) setError(caught instanceof Error ? caught.message : "Unable to load Gmail.");
    } finally {
      if (!quiet) setLoading(false);
      if (pageToken) setLoadingMore(false);
    }
  }

  async function loadThread(id: string): Promise<MailThread | null> {
    try {
      const response = await fetch(`/api/mail/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) {
        const value = await response.json() as { error?: string };
        throw new Error(value.error ?? "Unable to open conversation.");
      }
      const value = await response.json() as MailThread;
      setActiveThread(value);
      setThreads((previous) => previous.map((thread) => thread.id === id ? value : thread));
      await cacheThread(value);
      void performAction(id, "read", false);
      setMobileReading(true);
      return value;
    } catch (caught) {
      const cached = await getCachedThread(id).catch(() => undefined);
      if (cached) {
        setActiveThread(cached);
        setMobileReading(true);
        setOffline(true);
        return cached;
      }
      setError(caught instanceof Error ? caught.message : "Unable to open conversation.");
      return null;
    }
  }

  async function openThread(id: string) {
    const cached = await getCachedThread(id).catch(() => undefined);
    if (cached) setActiveThread(cached);
    if (navigator.onLine && account.connected) await loadThread(id);
    else if (cached) { setMobileReading(true); setOffline(true); void performAction(id, "read", false); }
  }

  async function performAction(id: string, action: "read" | "unread" | "star" | "unstar" | "archive" | "trash", showToast = true): Promise<"confirmed" | "queued" | "failed"> {
    try {
      if (!account.connected || !navigator.onLine) {
        await queueMailOperation({ threadId: id, action });
        applyLocalAction(id, action);
        if (showToast) notify("Saved locally · this change will sync when Gmail reconnects");
        return "queued";
      }
      const response = await fetch(`/api/mail/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error ?? "Gmail did not confirm the change.");
      applyLocalAction(id, action);
      if (showToast) notify(action === "trash" ? "Moved to Trash" : action === "archive" ? "Archived" : action === "star" ? "Starred" : action === "unstar" ? "Unstarred" : "Updated");
      void loadFolders();
      return "confirmed";
    } catch (caught) {
      if (!navigator.onLine) {
        try {
          await queueMailOperation({ threadId: id, action });
          applyLocalAction(id, action);
          setOffline(true);
          if (showToast) notify("Saved locally · this change will sync when Gmail reconnects");
          return "queued";
        } catch { /* Show the original error if durable queueing also fails. */ }
      }
      setError(caught instanceof Error ? caught.message : "Gmail did not confirm the change.");
      return "failed";
    }
  }

  function applyLocalAction(id: string, action: MailOperationAction) {
    const update = (thread: MailThread) => updateThreadForAction(thread, id, action);
    if (action === "archive" || action === "trash") {
      setThreads((previous) => previous.filter((thread) => thread.id !== id));
      if (activeRef.current?.id === id) setActiveThread(null);
    } else {
      setThreads((previous) => previous.map(update));
      setActiveThread((previous) => previous ? update(previous) : null);
    }
    void getCachedThread(id).then((thread) => thread && cacheThread(update(thread))).catch(() => undefined);
  }

  async function flushPendingOperations() {
    if (!connectedRef.current || !navigator.onLine || flushingOperations.current) return;
    flushingOperations.current = true;
    try {
      const operations = await getPendingMailOperations();
      for (const operation of operations) {
        const response = await fetch(`/api/mail/${encodeURIComponent(operation.threadId)}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: operation.action }),
        });
        if (!response.ok) break;
        await removeMailOperation(operation.id);
      }
    } catch { /* Keep queued actions for the next connection attempt. */ }
    finally { flushingOperations.current = false; }
  }

  async function bulkAction(action: "read" | "unread" | "archive" | "trash") {
    const ids = [...selected];
    let confirmed = 0;
    let queued = 0;
    for (const id of ids) {
      const outcome = await performAction(id, action, false);
      if (outcome === "confirmed") confirmed += 1;
      if (outcome === "queued") queued += 1;
    }
    setSelected(new Set());
    if (confirmed || queued) {
      const parts = [confirmed ? `${confirmed} confirmed` : "", queued ? `${queued} queued for sync` : ""].filter(Boolean);
      notify(`${parts.join(" · ")} conversation${confirmed + queued === 1 ? "" : "s"}`);
    }
  }

  async function syncMailbox() {
    if (!connectedRef.current || syncingRef.current || !navigator.onLine) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      await flushPendingOperations();
      await syncPendingDrafts(activeDraftId.current);
      const folder = currentFolderRef.current;
      const query = searchValueRef.current;
      const response = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailbox: folder }) });
      if (!response.ok || response.status === 202) return;
      const result = await response.json() as { resetRequired?: boolean; threads?: MailThread[] };
      if (result.threads?.length) await cacheThreads(result.threads);
      if (result.resetRequired) await clearCachedMessages();
      if (result.resetRequired || result.threads?.length) await loadMailbox(folder, query, true);
      setAccount((current) => ({ ...current, lastSyncedAt: Date.now(), syncStatus: "idle" }));
    } catch {
      setAccount((current) => ({ ...current, syncStatus: "error" }));
    } finally { syncingRef.current = false; setSyncing(false); }
  }

  syncMailboxRef.current = syncMailbox;

  function beginCompose(seed?: Partial<MailDraft>) {
    const normalized = { ...seed, id: seed?.id ?? crypto.randomUUID(), revision: seed?.revision ?? 0 };
    activeDraftId.current = normalized.id;
    composeActive.current = true;
    setComposeSeed(normalized);
    setComposeOpen(true);
  }

  function closeActive() {
    if (composeOpen) setComposeOpen(false);
    else if (settingsOpen) setSettingsOpen(false);
    else if (aiThread) setAiThread(null);
    else { setActiveThread(null); setMobileReading(false); }
  }

  function replyTo(thread: MailThread, all = false) {
    const message = lastMessage(thread);
    if (!message) return;
    const to = all
      ? [message.from.email, ...message.to.map((item) => item.email)].filter((email, index, source) => email && email !== account.email && source.indexOf(email) === index).join(", ")
      : message.from.email;
    const prefix = /^re:/i.test(message.subject) ? "" : "Re: ";
    beginCompose({ to, cc: all ? message.cc.map((item) => item.email).filter((email) => email !== account.email).join(", ") : "", subject: `${prefix}${message.subject}`, threadId: thread.id, inReplyTo: message.rfcMessageId, references: [message.references, message.rfcMessageId].filter(Boolean).join(" "), body: `\n\nOn ${new Date(message.date).toLocaleString()}, ${displayName(message)} wrote:\n${message.textBody ?? message.snippet}` });
  }

  function forwardThread(thread: MailThread) {
    const message = lastMessage(thread);
    if (!message) return;
    beginCompose({ subject: `Fwd: ${message.subject.replace(/^fwd:\s*/i, "")}`, body: `\n\n---------- Forwarded message ----------\nFrom: ${displayName(message)} <${message.from.email}>\nDate: ${new Date(message.date).toLocaleString()}\nSubject: ${message.subject}\n\n${message.textBody ?? message.snippet}` });
  }

  async function disconnected() {
    try {
      const response = await fetch("/api/auth/session", { method: "DELETE" });
      if (!response.ok) throw new Error("Account could not be disconnected.");
      await clearAllLocalData();
      setAccount({ connected: false });
      setThreads([]);
      setActiveThread(null);
      setFolders([]);
      setCurrentFolder("INBOX");
      notify("Gmail disconnected and local mail cache cleared");
    } catch (caught) { notify(caught instanceof Error ? caught.message : "Disconnect failed."); }
  }

  const folderLabel = useMemo(() => coreFolders.find((folder) => folder.id === currentFolder)?.label ?? folders.find((folder) => `label:${folder.id}` === currentFolder)?.name ?? currentFolder.replace(/^label:/, ""), [currentFolder, folders]);

  const content = (
    <div className="app-frame" data-density={preferences.density}>
      <aside className={`sidebar ${preferences.sidebarVisible ? "" : "sidebar-collapsed"}`} aria-label="Mailbox navigation">
        <div className="brand"><span className="brand-mark"><Mail size={15} strokeWidth={2.2} /></span><span className="brand-name">SlateMail</span></div>
        <button type="button" className="compose-button" onClick={() => beginCompose()} aria-label="Compose message"><PenLine size={15} /> <span className="nav-item-label">Compose</span></button>
        <nav className="nav-section">
          {coreFolders.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" className={`nav-item ${currentFolder === id ? "active" : ""}`} onClick={() => { setCurrentFolder(id); setActiveThread(null); setSelected(new Set()); setSearchValue(""); }} aria-current={currentFolder === id ? "page" : undefined} title={label}>
              <Icon size={16} strokeWidth={1.8} /><span className="nav-item-label">{label}</span>
              {id === "DRAFT" && draftCount > 0 && <span className="nav-count">{draftCount}</span>}
              {id === "INBOX" && folders.find((folder) => folder.id === "INBOX")?.unreadCount ? <span className="nav-count">{folders.find((folder) => folder.id === "INBOX")?.unreadCount}</span> : null}
            </button>
          ))}
        </nav>
        {folders.some((folder) => folder.type === "user") && <><div className="nav-divider" /><nav className="nav-section" aria-label="Gmail labels">
          {folders.filter((folder) => folder.type === "user").slice(0, 8).map((folder) => <button key={folder.id} type="button" className={`nav-item ${currentFolder === `label:${folder.id}` ? "active" : ""}`} onClick={() => { setCurrentFolder(`label:${folder.id}`); setActiveThread(null); }} title={folder.name}><File size={15} /><span className="nav-item-label">{folder.name}</span></button>)}
        </nav></>}
        <div className="sidebar-bottom">
          <button type="button" className="nav-item" onClick={() => { setSettingsOpen(true); captureOptional("settings_opened"); }} title="Settings"><Settings2 size={16} /><span className="nav-item-label">Settings</span></button>
          <div className="account-switcher" title={account.email || "No Gmail account connected"}>
            <span className="avatar">{initials(account)}</span>
            <div className="account-meta"><span className="account-email">{account.email ?? "Not connected"}</span><span className="account-state"><i className={`status-dot ${account.connected ? "connected" : ""}`} />{account.connected ? "Gmail connected" : "Connect an account"}</span></div>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button type="button" className="icon-button" aria-label={preferences.sidebarVisible ? "Collapse sidebar" : "Expand sidebar"} title="Toggle sidebar" onClick={() => applyPreferences({ ...preferences, sidebarVisible: !preferences.sidebarVisible })}><Menu size={16} /></button>
          <strong className="topbar-title">{folderLabel}</strong>
          <label className="search-wrap"><Search size={15} aria-hidden="true" /><input ref={searchRef} className="search-input" type="search" placeholder="Search mail" aria-label="Search mail" value={searchValue} onChange={(event) => setSearchValue(event.target.value)} /><kbd className="shortcut-hint">/</kbd></label>
          <span className="toolbar-spacer" />
          <span className="sync-state" aria-live="polite">{offline ? <><span className="status-dot" />Offline</> : syncing ? <><LoaderCircle size={12} className="animate-spin" />Syncing</> : account.connected ? <><span className="status-dot connected" />Connected</> : null}</span>
          <AppIconButton label="Sync now" onClick={() => void syncMailbox()} disabled={!account.connected || syncing}><RefreshCw size={15} className={syncing ? "animate-spin" : ""} /></AppIconButton>
        </header>
        {account.connected && oauthMessage && <div className="settings-notice" role="alert" style={{ margin: 12 }}>{oauthMessage}</div>}

        {!account.connected ? (
          <div className="empty-state">
            <div className="connect-card"><span className="connect-mark"><Mail size={23} /></span><h2>Your inbox, thoughtfully arranged.</h2><p>Connect a Gmail account to see your real messages. SlateMail does not fill your inbox with sample data.</p><a className="button-primary" href="/api/auth/google"><Mail size={14} /> Connect Gmail</a>{oauthMessage && <p role="alert" style={{ color: "var(--danger)" }}>{oauthMessage}</p>}<span style={{ fontSize: 10 }}>Your email stays out of external AI services.</span></div>
          </div>
        ) : (
          <div className="mail-layout" data-arrangement={preferences.paneArrangement}>
            <section className="message-list-pane" data-density={preferences.density} aria-label={`${folderLabel} message list`}>
              <div className="list-toolbar"><div className="list-toolbar-left"><input type="checkbox" aria-label="Select all conversations" checked={threads.length > 0 && selected.size === threads.length} onChange={(event) => setSelected(event.target.checked ? new Set(threads.map((thread) => thread.id)) : new Set())} /><span className="list-toolbar-label">{selected.size ? `${selected.size} selected` : currentFolder === "DRAFT" ? `${localDrafts.length} drafts` : `${threads.length} conversations`}</span></div><div className="list-toolbar-right">
                {selected.size > 0 ? <><AppIconButton label="Mark selected read" onClick={() => void bulkAction("read")}><CheckCheck size={15} /></AppIconButton><AppIconButton label="Mark selected unread" onClick={() => void bulkAction("unread")}><Mail size={14} /></AppIconButton><AppIconButton label="Archive selected" onClick={() => void bulkAction("archive")}><Archive size={15} /></AppIconButton><AppIconButton label="Delete selected" onClick={() => void bulkAction("trash")}><Trash2 size={15} /></AppIconButton></> : <><AppIconButton label={`Sort ${oldestFirst ? "newest" : "oldest"} first`} onClick={() => setOldestFirst((value) => !value)}><ArrowDownUp size={15} /></AppIconButton><span className="list-toolbar-label">{oldestFirst ? "Oldest" : "Newest"}</span></>}
              </div></div>
              {error && <div role="status" className="settings-notice" style={{ margin: 12 }}>{error}</div>}
              <div className="list-scroll" aria-busy={loading || loadingMore}>
                {loading && threads.length === 0 && localDrafts.length === 0 ? <div className="empty-state"><LoaderCircle size={18} className="animate-spin" /><span>Loading mailbox…</span></div> : currentFolder === "DRAFT" ? localDrafts.length === 0 ? <div className="empty-state"><Check size={20} /><h2>No drafts</h2><p>Drafts you save on this device or in Gmail will appear here.</p><button className="button-secondary" onClick={() => beginCompose()}>Compose a message</button></div> : localDrafts.map((draft) => <article key={draft.id} className="mail-row"><span className="row-check" aria-hidden="true"><PenLine size={13} /></span><button type="button" className="row-open" aria-label={`Edit draft ${draft.subject || "New message"}`} onClick={() => beginCompose(draft)}><div className="row-main"><div className="row-heading"><span className="mail-sender">{draft.to || "New message"}</span><time className="mail-date">{formatDate(new Date(draft.updatedAt).toISOString())}</time></div><span className="mail-subject">{draft.subject || "(no subject)"}</span><span className="mail-preview">{draft.body || "Draft saved locally"}</span></div></button><span className="mail-date">{draft.status === "conflict" ? "Conflict" : draft.status === "synced" ? "Saved" : "Pending"}</span></article>) : threads.length === 0 ? <div className="empty-state"><Check size={20} /><h2>{searchValue ? "No matching messages" : "You're all caught up"}</h2><p>{searchValue ? "Try a different search or Gmail query." : "New messages will appear here after Gmail syncs."}</p></div> : (oldestFirst ? [...threads].reverse() : threads).map((thread) => {
                  const message = lastMessage(thread);
                  if (!message) return null;
                  const unread = thread.messages.some((item) => item.unread);
                  const starred = thread.messages.some((item) => item.starred);
                  return <article key={thread.id} className={`mail-row ${unread ? "unread" : ""} ${selected.has(thread.id) ? "selected" : ""}`}>
                    <input className="row-check" type="checkbox" aria-label={`Select conversation from ${displayName(message)}`} checked={selected.has(thread.id)} onClick={(event) => event.stopPropagation()} onChange={(event) => setSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(thread.id); else next.delete(thread.id); return next; })} />
                    <button type="button" className="row-open" aria-label={`Open conversation from ${displayName(message)}, ${message.subject}`} onClick={() => void openThread(thread.id)}><div className="row-main"><div className="row-heading"><span className="mail-sender">{displayName(message)}{thread.messages.length > 1 ? ` (${thread.messages.length})` : ""}</span><time className="mail-date" dateTime={message.date}>{formatDate(message.date)}</time></div><span className="mail-subject">{message.subject || "(no subject)"}</span><span className="mail-preview">{thread.snippet || message.snippet}</span></div></button>
                    <div className="row-trailing" onClick={(event) => event.stopPropagation()}><AppIconButton label={starred ? "Unstar conversation" : "Star conversation"} className={starred ? "selected" : ""} onClick={() => void performAction(thread.id, starred ? "unstar" : "star")}><Star size={14} fill={starred ? "currentColor" : "none"} /></AppIconButton><AppIconButton label="Archive conversation" onClick={() => void performAction(thread.id, "archive")}><Archive size={14} /></AppIconButton></div>
                  </article>;
                })}
                {nextPageToken && !offline && <div className="load-more-wrap"><button className="button-secondary" onClick={() => void loadMailbox(currentFolder, searchValue, true, nextPageToken)} disabled={loadingMore}>{loadingMore ? <><LoaderCircle size={12} className="animate-spin" />Loading…</> : "Load more conversations"}</button></div>}
              </div>
            </section>

            <section className={`reading-pane ${mobileReading ? "mobile-open" : ""}`} aria-label="Message reading pane">
              {activeThread ? <ReadingPane thread={activeThread} account={account} onBack={() => { setMobileReading(false); setActiveThread(null); }} onAction={performAction} onReply={(all) => replyTo(activeThread, all)} onForward={() => forwardThread(activeThread)} onAI={() => setAiThread(activeThread)} /> : <div className="reading-empty"><Mail size={21} strokeWidth={1.4} /><strong>Select a conversation</strong><span>Your message will open here.</span></div>}
            </section>
          </div>
        )}
      </main>

      {composeOpen && <ComposeDialog seed={composeSeed} account={account} onClose={() => { setComposeOpen(false); setComposeSeed(undefined); activeDraftId.current = undefined; composeActive.current = false; void refreshDraftCount(true, account.connected); void syncPendingDrafts(); if (currentFolder === "DRAFT") void loadMailbox("DRAFT", "", true); }} onDraftSaved={(draft) => { if (draft && composeActive.current) activeDraftId.current = draft.id; else if (draft) void syncPendingDrafts(); void refreshDraftCount(!!draft && draft.status === "synced", account.connected); }} onSent={() => { setComposeOpen(false); setComposeSeed(undefined); activeDraftId.current = undefined; composeActive.current = false; void refreshDraftCount(true, account.connected); void loadMailbox("SENT", ""); setCurrentFolder("SENT"); notify("Message sent"); }} />}
      {aiThread && <AIActionDialog thread={aiThread} onClose={() => setAiThread(null)} onUseAsDraft={(draft) => { setAiThread(null); beginCompose(draft); }} />}
      {settingsOpen && <SettingsDialog preferences={preferences} account={account} onClose={() => setSettingsOpen(false)} onPreferencesChange={applyPreferences} onDisconnect={disconnected} onSync={() => void syncMailbox()} onCacheClear={async () => { await clearAllLocalData(); setThreads([]); setActiveThread(null); notify("Local cache and drafts cleared"); }} />}
      <div className="toast-region" role="status" aria-live="polite">{toast && <div className="toast">{toast}</div>}</div>
    </div>
  );

  return <AnalyticsGate enabled={preferencesReady && preferences.analyticsEnabled}>{content}</AnalyticsGate>;
}

function ReadingPane({ thread, account, onBack, onAction, onReply, onForward, onAI }: {
  thread: MailThread; account: AccountStatus; onBack: () => void;
  onAction: (id: string, action: "read" | "unread" | "star" | "unstar" | "archive" | "trash") => void;
  onReply: (all: boolean) => void; onForward: () => void; onAI: () => void;
}) {
  return <div className="reading-content">
    <div className="reading-toolbar"><AppIconButton label="Back to message list" className="mobile-back" onClick={onBack}><ArrowLeft size={15} /></AppIconButton><AppIconButton label="Archive conversation" onClick={() => onAction(thread.id, "archive")}><Archive size={15} /></AppIconButton><AppIconButton label="Move to Trash" onClick={() => onAction(thread.id, "trash")}><Trash2 size={15} /></AppIconButton><span className="toolbar-spacer" /><AppIconButton label="Mark unread" onClick={() => onAction(thread.id, "unread")}><Mail size={15} /></AppIconButton><AppIconButton label="Mark read" onClick={() => onAction(thread.id, "read")}><CheckCheck size={15} /></AppIconButton></div>
    <h1 className="reading-subject">{thread.messages.at(-1)?.subject || "(no subject)"}</h1>
    {thread.messages.map((message) => <article className="message-card" key={message.id}>
      <div className="message-card-header"><span className="message-avatar">{displayName(message).slice(0, 1).toUpperCase()}</span><div className="message-details"><strong className="message-from">{displayName(message)}</strong><span className="message-to">to {message.to.map((item) => item.name || item.email).join(", ") || account.email || "you"}{message.cc.length ? `, cc ${message.cc.map((item) => item.email).join(", ")}` : ""}</span></div><time className="message-timestamp" dateTime={message.date}>{new Date(message.date).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time><AppIconButton label={message.starred ? "Unstar message" : "Star message"} className={message.starred ? "selected" : ""} onClick={() => onAction(thread.id, message.starred ? "unstar" : "star")}><Star size={14} fill={message.starred ? "currentColor" : "none"} /></AppIconButton></div>
      {message.safeHtmlBody ? <div className="safe-html-body" dangerouslySetInnerHTML={{ __html: message.safeHtmlBody }} /> : <div className="message-body">{message.textBody || message.snippet || "(This message has no text content.)"}</div>}
      {!message.textBody && !message.safeHtmlBody && message.snippet && <p className="offline-note">Only the cached message preview is available. Reconnect to load the full body.</p>}
      {message.attachments.length > 0 && <div className="attachment-list">{message.attachments.map((attachment) => <a className="attachment-chip" key={attachment.id} href={`/api/mail/${encodeURIComponent(thread.id)}/attachments/${encodeURIComponent(attachment.id)}?messageId=${encodeURIComponent(message.id)}`}><Paperclip size={13} /><span>{attachment.filename}</span><span className="mail-date">{attachment.size < 1_000_000 ? `${Math.round(attachment.size / 1024)} KB` : `${(attachment.size / 1_000_000).toFixed(1)} MB`}</span></a>)}</div>}
    </article>)}
    {thread.messages.length > 0 && <div className="reply-actions"><button className="button-secondary" onClick={() => onReply(false)}><ArrowLeftRight size={13} /> Reply</button><button className="button-secondary" onClick={() => onReply(true)}><ArrowLeftRight size={13} /> Reply all</button><button className="button-secondary" onClick={onForward}><Forward size={13} /> Forward</button><button className="button-secondary" onClick={onAI}><PenLine size={13} /> AI actions</button></div>}
  </div>;
}

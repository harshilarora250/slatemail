import "server-only";
import type { gmail_v1 } from "googleapis";
import type { MailAddress, MailAttachment, MailMessage, MailPage, MailThread } from "@/domain/mail";
import type { LocalAttachment } from "@/domain/mail";
import { gmailForAccount } from "@/server/google";
import { sanitizeEmailHtml } from "@/providers/gmail/sanitize";
import { buildRawMessage } from "@/providers/gmail/mime";
import { remoteDraftVersionConflicts } from "@/domain/draft-conflict";
export { buildRawMessage } from "@/providers/gmail/mime";

export interface GmailAccount {
  sub: string;
  encrypted_credentials: string;
}

const MAILBOX_LABELS: Record<string, string> = {
  INBOX: "INBOX",
  STARRED: "STARRED",
  DRAFT: "DRAFT",
  SENT: "SENT",
  TRASH: "TRASH",
};

function provider(account: GmailAccount) {
  return gmailForAccount(account).gmail;
}

function headersOf(message?: gmail_v1.Schema$Message): Map<string, string> {
  return new Map((message?.payload?.headers ?? []).flatMap((header) =>
    header.name && header.value ? [[header.name.toLowerCase(), header.value] as [string, string]] : [],
  ));
}

function parseAddressList(value: string | undefined): MailAddress[] {
  if (!value) return [];
  return value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((part) => {
    const match = part.trim().match(/^(.*?)\s*<([^<>]+)>$/);
    const name = match?.[1]?.replace(/^"|"$/g, "").trim() ?? "";
    const email = (match?.[2] ?? part).trim();
    return { name, email };
  }).filter((address) => address.email.includes("@"));
}

function decodeHeader(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_match, charset: string, encoding: string, data: string) => {
    try {
      const bytes = encoding.toLowerCase() === "b"
        ? Buffer.from(data, "base64")
        : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_hex, code: string) => String.fromCharCode(parseInt(code, 16))), "binary");
      return new TextDecoder(charset).decode(bytes);
    } catch { return data; }
  });
}

function decodeBody(data: string | null | undefined): string {
  if (!data) return "";
  return decodeBase64Url(data).toString("utf8");
}

function decodeBase64Url(data: string | null | undefined): Buffer {
  if (!data) return Buffer.alloc(0);
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

interface BodyParts { text: string; html: string; attachments: MailAttachment[] }

function collectParts(part: gmail_v1.Schema$MessagePart | undefined, messageId: string, result: BodyParts): void {
  if (!part) return;
  const mime = (part.mimeType ?? "").toLowerCase();
  const filename = part.filename?.trim();
  const attachmentId = part.body?.attachmentId;
  if (filename && attachmentId) {
    result.attachments.push({
      id: attachmentId,
      filename: filename.slice(0, 240),
      mimeType: mime || "application/octet-stream",
      size: Math.max(0, part.body?.size ?? 0),
    });
  } else if (part.body?.data) {
    const decoded = decodeBody(part.body.data);
    if (mime === "text/plain") result.text += `${result.text ? "\n" : ""}${decoded}`;
    if (mime === "text/html") result.html += decoded;
  }
  for (const child of part.parts ?? []) collectParts(child, messageId, result);
  void messageId;
}

function toMessage(message: gmail_v1.Schema$Message, includeBody = false): MailMessage {
  const headers = headersOf(message);
  const from = parseAddressList(headers.get("from"))[0] ?? { name: "Unknown sender", email: "" };
  const labels = message.labelIds ?? [];
  const bodyParts: BodyParts = { text: "", html: "", attachments: [] };
  if (includeBody) collectParts(message.payload, message.id ?? "", bodyParts);
  else collectMetadataAttachments(message.payload, bodyParts.attachments);
  const dateHeader = headers.get("date");
  const internalDate = message.internalDate ? Number(message.internalDate) : Date.now();
  const date = dateHeader && Number.isFinite(Date.parse(dateHeader)) ? new Date(dateHeader).toISOString() : new Date(internalDate).toISOString();
  const snippet = message.snippet ?? "";
  return {
    id: message.id ?? "",
    threadId: message.threadId ?? "",
    from,
    to: parseAddressList(headers.get("to")),
    cc: parseAddressList(headers.get("cc")),
    subject: decodeHeader(headers.get("subject")) || "(no subject)",
    snippet,
    date,
    unread: labels.includes("UNREAD"),
    starred: labels.includes("STARRED"),
    labels,
    hasAttachments: bodyParts.attachments.length > 0,
    attachments: bodyParts.attachments,
    rfcMessageId: headers.get("message-id"),
    references: headers.get("references"),
    ...(includeBody ? { textBody: bodyParts.text || undefined, safeHtmlBody: sanitizeEmailHtml(bodyParts.html) } : {}),
  };
}

function collectMetadataAttachments(part: gmail_v1.Schema$MessagePart | undefined, result: MailAttachment[]): void {
  if (!part) return;
  if (part.filename?.trim() && part.body?.attachmentId) {
    result.push({
      id: part.body.attachmentId,
      filename: part.filename.trim().slice(0, 240),
      mimeType: part.mimeType ?? "application/octet-stream",
      size: Math.max(0, part.body.size ?? 0),
    });
  }
  for (const child of part.parts ?? []) collectMetadataAttachments(child, result);
}

function queryForMailbox(mailbox: string): { labelIds?: string[]; q?: string } {
  if (MAILBOX_LABELS[mailbox]) return { labelIds: [MAILBOX_LABELS[mailbox]] };
  if (mailbox === "ARCHIVE") return { q: "-in:inbox -in:sent -in:trash -in:drafts" };
  if (mailbox.startsWith("label:")) return { labelIds: [mailbox.slice(6)] };
  return { labelIds: ["INBOX"] };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await mapper(items[index]!);
    }
  }));
  return output;
}

export async function listThreads(
  account: GmailAccount,
  options: { mailbox?: string; query?: string; pageToken?: string; maxResults?: number } = {},
): Promise<MailPage> {
  const gmail = provider(account);
  const mailbox = options.mailbox ?? "INBOX";
  const query = queryForMailbox(mailbox);
  const response = await gmail.users.threads.list({
    userId: "me",
    labelIds: query.labelIds,
    q: [query.q, options.query?.trim()].filter(Boolean).join(" ") || undefined,
    pageToken: options.pageToken,
    maxResults: Math.min(50, Math.max(1, options.maxResults ?? 30)),
  });
  const summaries = await mapWithConcurrency(response.data.threads ?? [], 5, async (threadRef) => {
    if (!threadRef.id) return undefined;
    const thread = await gmail.users.threads.get({ userId: "me", id: threadRef.id, format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject", "Date"] });
    return thread.data;
  });
  const threads = summaries.flatMap((thread): MailThread[] => {
    if (!thread?.id) return [];
    return [{
      id: thread.id,
      snippet: thread.snippet ?? "",
      historyId: thread.historyId ?? undefined,
      messages: (thread.messages ?? []).map((message) => toMessage(message)),
    }];
  });
  return {
    threads,
    nextPageToken: response.data.nextPageToken ?? undefined,
    resultSizeEstimate: response.data.resultSizeEstimate ?? undefined,
  };
}

export async function getThread(account: GmailAccount, id: string): Promise<MailThread> {
  const gmail = provider(account);
  const result = await gmail.users.threads.get({ userId: "me", id, format: "full" });
  const thread = result.data;
  return {
    id: thread.id ?? id,
    snippet: thread.snippet ?? "",
    historyId: thread.historyId ?? undefined,
    messages: (thread.messages ?? []).map((message) => toMessage(message, true)),
  };
}

export async function getProfile(account: GmailAccount) {
  const gmail = provider(account);
  const result = await gmail.users.getProfile({ userId: "me" });
  return { email: result.data.emailAddress ?? "", historyId: result.data.historyId ?? "" };
}

export async function getLabels(account: GmailAccount) {
  const gmail = provider(account);
  const result = await gmail.users.labels.list({ userId: "me" });
  return (result.data.labels ?? []).map((label) => ({
    id: label.id ?? "",
    name: label.name ?? "",
    type: label.type ?? "user",
    unreadCount: label.messagesUnread ?? 0,
    totalCount: label.messagesTotal ?? 0,
  }));
}

export async function modifyThread(account: GmailAccount, id: string, action: "read" | "unread" | "star" | "unstar" | "archive") {
  const gmail = provider(account);
  const addLabelIds: string[] = [];
  const removeLabelIds: string[] = [];
  if (action === "read") removeLabelIds.push("UNREAD");
  if (action === "unread") addLabelIds.push("UNREAD");
  if (action === "star") addLabelIds.push("STARRED");
  if (action === "unstar") removeLabelIds.push("STARRED");
  if (action === "archive") removeLabelIds.push("INBOX");
  await gmail.users.threads.modify({ userId: "me", id, requestBody: { addLabelIds, removeLabelIds } });
}

export async function trashThread(account: GmailAccount, id: string): Promise<void> {
  await provider(account).users.threads.trash({ userId: "me", id });
}

export async function downloadAttachment(account: GmailAccount, messageId: string, attachmentId: string) {
  const gmail = provider(account);
  const response = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
  return decodeBase64Url(response.data.data);
}

export async function createOrUpdateDraft(
  account: GmailAccount,
  input: { localDraftId: string; draftId?: string; expectedVersion?: string; to: string; cc?: string; bcc?: string; subject: string; body: string; threadId?: string; attachments?: LocalAttachment[]; inReplyTo?: string; references?: string },
): Promise<{ id: string; messageId?: string; version?: string }> {
  const gmail = provider(account);
  const raw = buildRawMessage({ ...input, clientDraftId: input.localDraftId });
  if (input.draftId) {
    const current = await gmail.users.drafts.get({ userId: "me", id: input.draftId, format: "full" });
    const remoteMessage = current.data.message;
    const version = remoteMessage?.historyId ?? remoteMessage?.internalDate ?? remoteMessage?.id ?? "";
    if (remoteDraftVersionConflicts(input.expectedVersion, version)) {
      const conflict = new Error("The Gmail draft changed elsewhere. Your local version is preserved.") as Error & { response: { status: number }; remoteVersion: string };
      conflict.response = { status: 409 };
      conflict.remoteVersion = version;
      throw conflict;
    }
  }
  const requestBody: gmail_v1.Schema$Draft = { message: { raw, threadId: input.threadId } };
  const response = input.draftId
    ? await gmail.users.drafts.update({ userId: "me", id: input.draftId, requestBody })
    : await gmail.users.drafts.create({ userId: "me", requestBody });
  const message = response.data.message;
  return {
    id: response.data.id ?? "",
    messageId: message?.id ?? undefined,
    version: message?.historyId ?? message?.internalDate ?? message?.id ?? undefined,
  };
}

export async function deleteDraft(account: GmailAccount, id: string): Promise<void> {
  await provider(account).users.drafts.delete({ userId: "me", id });
}

export async function listDrafts(account: GmailAccount): Promise<Array<{
  id: string; clientDraftId?: string; threadId: string; to: string; cc: string; bcc: string; subject: string; body: string;
  updatedAt: number; version: string; attachments: MailAttachment[];
}>> {
  const gmail = provider(account);
  const listed = await gmail.users.drafts.list({ userId: "me", maxResults: 50 });
  const drafts = await mapWithConcurrency(listed.data.drafts ?? [], 4, async (draftRef) => {
    if (!draftRef.id) return undefined;
    const response = await gmail.users.drafts.get({ userId: "me", id: draftRef.id, format: "full" });
    const draft = response.data;
    const message = draft.message;
    if (!message) return undefined;
    const headers = headersOf(message);
    const parts: BodyParts = { text: "", html: "", attachments: [] };
    collectParts(message.payload, message.id ?? "", parts);
    const internalDate = Number(message.internalDate ?? Date.now());
    return {
      id: draft.id ?? draftRef.id,
      clientDraftId: headers.get("x-slatemail-draft-id"),
      threadId: message.threadId ?? "",
      to: headers.get("to") ?? "",
      cc: headers.get("cc") ?? "",
      bcc: headers.get("bcc") ?? "",
      subject: decodeHeader(headers.get("subject")),
      body: parts.text || message.snippet || "",
      updatedAt: Number.isFinite(internalDate) ? internalDate : Date.now(),
      version: message.historyId ?? message.internalDate ?? message.id ?? "",
      attachments: parts.attachments,
    };
  });
  return drafts.filter((draft): draft is NonNullable<typeof draft> => !!draft);
}

export async function getDraftCount(account: GmailAccount): Promise<number> {
  const response = await provider(account).users.drafts.list({ userId: "me", maxResults: 1 });
  return response.data.resultSizeEstimate ?? response.data.drafts?.length ?? 0;
}

export async function getDraftForEdit(account: GmailAccount, id: string) {
  const gmail = provider(account);
  const response = await gmail.users.drafts.get({ userId: "me", id, format: "full" });
  const draft = response.data;
  const message = draft.message;
  if (!message) throw new Error("Draft message is empty.");
  const headers = headersOf(message);
  const parts: BodyParts = { text: "", html: "", attachments: [] };
  collectParts(message.payload, message.id ?? "", parts);
  const attachmentSize = parts.attachments.reduce((sum, item) => sum + item.size, 0);
  if (attachmentSize > 20_000_000) {
    const error = new Error("This draft has attachments over 20 MB. Remove or manage them in Gmail before editing here.") as Error & { response: { status: number } };
    error.response = { status: 413 };
    throw error;
  }
  const attachments: LocalAttachment[] = await mapWithConcurrency(parts.attachments, 3, async (attachment) => {
    const result = await gmail.users.messages.attachments.get({ userId: "me", messageId: message.id ?? "", id: attachment.id });
    return {
      name: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      data: decodeBase64Url(result.data.data).toString("base64"),
    };
  });
  const timestamp = Number(message.internalDate ?? Date.now());
  return {
    id: draft.id ?? id,
    threadId: message.threadId ?? undefined,
    to: headers.get("to") ?? "",
    cc: headers.get("cc") ?? "",
    bcc: headers.get("bcc") ?? "",
    subject: decodeHeader(headers.get("subject")),
    body: parts.text || message.snippet || "",
    attachments,
    updatedAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
    version: message.historyId ?? message.internalDate ?? message.id ?? "",
  };
}

export async function sendRawMessage(account: GmailAccount, raw: string, threadId?: string) {
  const gmail = provider(account);
  const response = await gmail.users.messages.send({ userId: "me", requestBody: { raw, threadId } });
  return { id: response.data.id ?? "", threadId: response.data.threadId ?? "" };
}

export async function sendDraft(account: GmailAccount, draftId: string) {
  const gmail = provider(account);
  const response = await gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
  return { id: response.data.id ?? "", threadId: response.data.threadId ?? "" };
}

export async function listHistory(account: GmailAccount, startHistoryId: string) {
  const gmail = provider(account);
  const allHistory: gmail_v1.Schema$History[] = [];
  let pageToken: string | undefined;
  let latestHistoryId: string | null | undefined;
  for (let page = 0; page < 20; page += 1) {
    const response = await gmail.users.history.list({
      userId: "me",
      startHistoryId,
      pageToken,
      historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
      maxResults: 500,
    });
    allHistory.push(...(response.data.history ?? []));
    latestHistoryId = response.data.historyId ?? latestHistoryId;
    pageToken = response.data.nextPageToken ?? undefined;
    if (!pageToken) return { ...response.data, history: allHistory, historyId: latestHistoryId };
  }
  throw new Error("Gmail sync has more than 10,000 pending history changes. Retry when the mailbox is quieter.");
}

export async function historyId(account: GmailAccount): Promise<string> {
  return (await getProfile(account)).historyId;
}

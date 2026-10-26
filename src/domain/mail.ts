export type MailboxName =
  | "INBOX"
  | "STARRED"
  | "DRAFT"
  | "SENT"
  | "ARCHIVE"
  | "TRASH"
  | string;

export interface MailAddress {
  name: string;
  email: string;
}

export interface MailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MailMessage {
  id: string;
  threadId: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
  starred: boolean;
  labels: string[];
  hasAttachments: boolean;
  attachments: MailAttachment[];
  rfcMessageId?: string;
  references?: string;
  textBody?: string;
  safeHtmlBody?: string;
}

export interface MailThread {
  id: string;
  messages: MailMessage[];
  snippet: string;
  historyId?: string;
}

export interface MailPage {
  threads: MailThread[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
  historyId?: string;
}

export interface MailDraft {
  id: string;
  remoteId?: string;
  threadId?: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachments?: LocalAttachment[];
  updatedAt: number;
  remoteUpdatedAt?: number;
  remoteVersion?: string;
  conflictingRemoteVersion?: string;
  inReplyTo?: string;
  references?: string;
  sendAttemptId?: string;
  revision: number;
  status: "local" | "pending" | "synced" | "conflict" | "sending";
}

export interface LocalAttachment {
  name: string;
  mimeType: string;
  data: string;
  size: number;
}

export interface AccountStatus {
  connected: boolean;
  email?: string;
  name?: string;
  lastSyncedAt?: number;
  syncStatus?: "idle" | "syncing" | "offline" | "error";
}

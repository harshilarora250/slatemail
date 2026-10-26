"use client";

import type { MailOperationAction } from "@/client/mail-cache";

export function updateThreadForAction<T extends { id: string; messages: Array<{ labels: string[]; unread: boolean; starred: boolean }> }>(
  thread: T,
  threadId: string,
  action: MailOperationAction,
): T {
  if (thread.id !== threadId) return thread;
  return {
    ...thread,
    messages: thread.messages.map((message) => {
      let labels = message.labels;
      if (action === "read") labels = labels.filter((label) => label !== "UNREAD");
      if (action === "unread") labels = [...new Set([...labels, "UNREAD"])];
      if (action === "star") labels = [...new Set([...labels, "STARRED"])];
      if (action === "unstar") labels = labels.filter((label) => label !== "STARRED");
      if (action === "archive") labels = labels.filter((label) => label !== "INBOX");
      if (action === "trash") labels = [...new Set([...labels.filter((label) => label !== "INBOX"), "TRASH"])];
      return { ...message, labels, unread: labels.includes("UNREAD"), starred: labels.includes("STARRED") };
    }),
  };
}

export function threadMatchesMailbox(
  thread: { messages: Array<{ labels: string[] }> },
  mailbox: string,
  query: string,
  searchableText: string,
): boolean {
  const labels = new Set(thread.messages.flatMap((message) => message.labels));
  const folderMatch = mailbox === "INBOX" ? labels.has("INBOX")
    : mailbox === "STARRED" ? labels.has("STARRED")
      : mailbox === "SENT" ? labels.has("SENT")
        : mailbox === "TRASH" ? labels.has("TRASH")
          : mailbox === "ARCHIVE" ? !["INBOX", "SENT", "TRASH", "DRAFT"].some((label) => labels.has(label))
            : mailbox.startsWith("label:") ? labels.has(mailbox.slice(6)) : true;
  return folderMatch && (!query.trim() || searchableText.toLowerCase().includes(query.trim().toLowerCase()));
}

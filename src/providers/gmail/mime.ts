import { randomBytes } from "node:crypto";
import type { LocalAttachment } from "@/domain/mail";

export function buildRawMessage(input: {
  to: string; cc?: string; bcc?: string; subject: string; body: string;
  from?: string; inReplyTo?: string; references?: string; clientDraftId?: string;
  attachments?: LocalAttachment[];
}): string {
  const encodeHeader = (value: string) => value.replace(/[\r\n]/g, " ");
  const subject = /^[\x00-\x7F]*$/.test(input.subject)
    ? encodeHeader(input.subject)
    : `=?UTF-8?B?${Buffer.from(input.subject).toString("base64")}?=`;
  const body = Buffer.from(input.body, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n").trim();
  const attachments = input.attachments ?? [];
  let mimeBody: string;
  let contentType: string;
  if (attachments.length) {
    const boundary = `slatemail_${randomBytes(18).toString("hex")}`;
    contentType = `multipart/mixed; boundary="${boundary}"`;
    const parts = [
      `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}`,
      ...attachments.map((attachment) => {
        const filename = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "attachment";
        const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType) ? attachment.mimeType : "application/octet-stream";
        const data = attachment.data.replace(/[^A-Za-z0-9+/=_-]/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/.{1,76}/g, "$&\r\n").trim();
        return `--${boundary}\r\nContent-Type: ${mimeType}; name="${filename}"\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${data}`;
      }),
      `--${boundary}--`,
    ];
    mimeBody = parts.join("\r\n");
  } else {
    contentType = "text/plain; charset=UTF-8";
    mimeBody = body;
  }
  const lines = [
    `To: ${encodeHeader(input.to)}`,
    ...(input.cc ? [`Cc: ${encodeHeader(input.cc)}`] : []),
    ...(input.bcc ? [`Bcc: ${encodeHeader(input.bcc)}`] : []),
    ...(input.from ? [`From: ${encodeHeader(input.from)}`] : []),
    `Subject: ${subject}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${encodeHeader(input.inReplyTo)}`] : []),
    ...(input.references ? [`References: ${encodeHeader(input.references)}`] : []),
    ...(input.clientDraftId ? [`X-SlateMail-Draft-ID: ${encodeHeader(input.clientDraftId)}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: ${contentType}`,
    ...(attachments.length ? [] : ["Content-Transfer-Encoding: base64"]),
    "",
    mimeBody,
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

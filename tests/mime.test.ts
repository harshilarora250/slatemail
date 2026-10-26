import { describe, expect, it } from "vitest";
import { buildRawMessage } from "@/providers/gmail/mime";

describe("Gmail MIME construction", () => {
  it("encodes text and attachments without allowing header injection", () => {
    const raw = buildRawMessage({
      to: "person@example.test\r\nBcc: attacker@example.test",
      subject: "Café status",
      body: "Plain text body",
      inReplyTo: "<parent@example.test>",
      clientDraftId: "draft_123",
      attachments: [{ name: "report.pdf\r\nX-Evil: yes", mimeType: "application/pdf", data: Buffer.from("pdf-data").toString("base64"), size: 8 }],
    });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toMatch(/^To: person@example\.test\s+Bcc: attacker@example\.test$/m);
    expect(decoded).not.toMatch(/^Bcc: attacker@example\.test$/m);
    expect(decoded).toContain("=?UTF-8?B?");
    expect(decoded).toContain("In-Reply-To: <parent@example.test>");
    expect(decoded).toContain("X-SlateMail-Draft-ID: draft_123");
    expect(decoded).toContain("Content-Disposition: attachment; filename=\"report.pdf__X-Evil__yes\"");
    expect(decoded).toContain(Buffer.from("pdf-data").toString("base64"));
  });
});

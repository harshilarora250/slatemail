import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function encryptionKey(): Buffer {
  const configured = process.env.APP_ENCRYPTION_KEY;
  if (!configured || configured.startsWith("replace-")) throw new Error("Set APP_ENCRYPTION_KEY to a base64-encoded 32-byte key before connecting an account.");
  const decoded = Buffer.from(configured, "base64");
  if (decoded.length === 32) return decoded;
  if (Buffer.byteLength(configured) === 32) return Buffer.from(configured, "utf8");
  throw new Error("APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(value: string): string {
  const [ivEncoded, tagEncoded, ciphertextEncoded] = value.split(".");
  if (!ivEncoded || !tagEncoded || !ciphertextEncoded) throw new Error("Encrypted credential is malformed.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivEncoded, "base64url"));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function hashIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomIdentifier(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

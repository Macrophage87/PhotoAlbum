import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Refresh tokens at rest: AES-256-GCM under TOKEN_ENCRYPTION_KEY, serialised as `v1.<iv>.<tag>.<ciphertext>` in
 * base64url. Rotating the key (see DEPLOY.md) means every member reconnects; the old ciphertext fails to decrypt
 * cleanly rather than silently.
 */
export function encryptSecret(plain: string, key: Buffer = keyFromEnv()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(sealed: string, key: Buffer = keyFromEnv()): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unrecognised sealed token");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export function keyFromEnv(): Buffer {
  const raw = env().TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

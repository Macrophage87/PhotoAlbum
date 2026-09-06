import { createHash, randomBytes } from "node:crypto";

/** Random URL-safe token. Only the sha256 hash is ever stored. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Accept a post-sign-in redirect target only when it is a same-site relative path:
 * starts with a single "/" and is not protocol-relative ("//host") or backslash-tricked.
 */
export function safeNextPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string") return fallback;
  if (!/^\/(?![\/\\])/.test(value)) return fallback;
  if (/[\r\n]/.test(value)) return fallback;
  return value;
}

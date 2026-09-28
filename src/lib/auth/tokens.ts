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

const PROBE_ORIGIN = "http://album.invalid";

/**
 * Accept a post-sign-in redirect target only when it is a same-site relative path. The value is resolved the way a
 * browser resolves a Location header, so tricks the URL parser undoes (a tab or newline after the slash, backslashes,
 * "/..//host") cannot turn it into another host. What comes back is the parsed path, not the raw input.
 */
export function safeNextPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;
  // The URL parser silently drops tabs and newlines, and a CR/LF could split a header: no control characters at all.
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;
  const path = url.pathname + url.search + url.hash;
  // Dot segments can collapse "/..//host" into "//host", which is protocol-relative once it is a Location again.
  if (!/^\/(?![\/\\])/.test(path)) return fallback;
  return path;
}

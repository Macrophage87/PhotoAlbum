/** The session cookie's name, lifetime and attributes. Kept free of the database so the proxy can use it. */
export const SESSION_COOKIE = "session";
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  };
}

/** What a raw session token looks like (base64url of 32 random bytes); anything else is not worth carrying forward. */
export function looksLikeSessionToken(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** The session cookie's name, lifetime and attributes. Kept free of the database so the proxy can use it. */
export const SESSION_COOKIE = "session";
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** The database extends a session once it is this old (src/lib/auth/session.ts), so it never has less left than TTL minus this. */
export const SESSION_SLIDE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How long a cookie re-issued on a page visit lasts: no longer than the database row is sure to, since every page
 * reads the session and slides the row to 90 days whenever it has fewer than 83 left.
 */
export const SESSION_REFRESH_MS = SESSION_TTL_MS - SESSION_SLIDE_AFTER_MS;

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

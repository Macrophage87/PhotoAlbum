import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { generateToken, hashToken } from "./tokens";
import { SESSION_COOKIE, SESSION_SLIDE_AFTER_MS, SESSION_TTL_MS, sessionCookieOptions } from "./session-cookie";

export { SESSION_COOKIE, SESSION_TTL_MS };

/** Create a DB session and set the cookie. Only callable from a Route Handler or Server Action. */
export async function createSession(userId: string): Promise<void> {
  const raw = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({ data: { id: hashToken(raw), userId, expiresAt } });
  (await cookies()).set(SESSION_COOKIE, raw, sessionCookieOptions(expiresAt));
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (raw) await db.session.deleteMany({ where: { id: hashToken(raw) } });
  store.delete(SESSION_COOKIE);
}

/** Resolve the current session's user from the cookie, or null. Never sets cookies. */
export async function readSessionUser() {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const session = await db.session.findUnique({ where: { id: hashToken(raw) }, include: { user: true } });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  // Sliding expiry: extend in the DB when the session is a week old. Pages cannot set cookies, so the proxy
  // (src/proxy.ts) pushes the cookie's own expiry forward on every page visit instead.
  if (session.expiresAt.getTime() - Date.now() < SESSION_TTL_MS - SESSION_SLIDE_AFTER_MS) {
    await db.session
      .update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) } })
      .catch(() => {});
  }
  return session.user;
}

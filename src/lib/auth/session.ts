import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { generateToken, hashToken } from "./tokens";

export const SESSION_COOKIE = "session";
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SLIDE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  };
}

/** Create a DB session and set the cookie. Only callable from a Route Handler or Server Action. */
export async function createSession(userId: string): Promise<void> {
  const raw = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({ data: { id: hashToken(raw), userId, expiresAt } });
  (await cookies()).set(SESSION_COOKIE, raw, cookieOptions(expiresAt));
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
  // Sliding expiry: extend in the DB when the session is a week old; the cookie itself lasts 90 days.
  if (session.expiresAt.getTime() - Date.now() < SESSION_TTL_MS - SLIDE_AFTER_MS) {
    await db.session
      .update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) } })
      .catch(() => {});
  }
  return session.user;
}

import type { Db } from "@/lib/db";
import { generateToken, hashToken } from "./tokens";

/**
 * A phone's sign-in for the album's app. Unlike a browser's cookie it is not sent by itself, so it cannot be used
 * by a page somebody else wrote (no cross-site forgery to guard against); the other side of that is that it has to
 * be asked for explicitly. Only the routes the app calls ask (getApiViewer in viewer.ts): the upload, its status,
 * and /api/v1. Pages, Server Actions and everything an admin does stay with the browser's session.
 */

/** Left unused this long, a phone's token is no longer honoured: a phone lost in a drawer is not a way in forever. */
export const DEVICE_TOKEN_IDLE_MS = 180 * 24 * 60 * 60 * 1000;
/** How stale `lastUsedAt` may get before a request writes it again; an upload of 200 photos is not 200 writes. */
export const DEVICE_TOKEN_TOUCH_MS = 60 * 60 * 1000;
const MAX_NAME = 80;

/** The token in an `Authorization: Bearer …` header, when it has the shape of one of ours. */
export function bearerToken(headers: Headers): string | null {
  const match = /^Bearer\s+([A-Za-z0-9_-]{43})$/i.exec(headers.get("authorization")?.trim() ?? "");
  return match ? match[1] : null;
}

/** A name fit to show in a list of phones: one line, not too long, never empty. */
export function deviceName(value: string | null | undefined): string {
  const name = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_NAME);
  return name || "Phone";
}

/** Sign a phone in as this member. The token is returned once and never stored: only its hash is. */
export async function createDeviceToken(db: Db, userId: string, name?: string | null): Promise<{ id: string; token: string }> {
  const token = generateToken();
  const row = await db.deviceToken.create({ data: { id: hashToken(token), userId, name: deviceName(name) }, select: { id: true } });
  return { id: row.id, token };
}

/** Whose phone this token is, or null: unknown, left unused too long, or its member is being removed. */
export async function readDeviceUser(db: Db, token: string, now: Date = new Date()) {
  const row = await db.deviceToken.findUnique({ where: { id: hashToken(token) }, include: { user: true } });
  // As a session is: a member being removed is signed out everywhere, and a token made at that very moment with them.
  if (!row || row.user.removingAt) return null;
  const idle = now.getTime() - row.lastUsedAt.getTime();
  if (idle > DEVICE_TOKEN_IDLE_MS) {
    await db.deviceToken.delete({ where: { id: row.id } }).catch(() => {});
    return null;
  }
  if (idle > DEVICE_TOKEN_TOUCH_MS) {
    await db.deviceToken.update({ where: { id: row.id }, data: { lastUsedAt: now } }).catch(() => {});
  }
  return row.user;
}

import { createHmac, timingSafeEqual } from "node:crypto";
import { formKey } from "@/lib/notes/token";

/**
 * A television shown the album's slideshow from the phone app fetches each picture itself, and it has no way to
 * sign in: it is handed an address and nothing else. So the app is given, for each picture of the slideshow it is
 * about to cast, an address the album has signed: good for that one picture, at the size a link's preview gets
 * (a JPEG with none of the file's metadata), and only for a few hours. Anyone the address reaches in that time can
 * see that picture, which is what casting to a screen in the room means; after that it opens nothing.
 */
export const CAST_LINK_MS = 6 * 60 * 60 * 1000;

let cachedKey: Buffer | undefined;

/** Its own key, made from the install's signing key, so a cast link and a note form's token can never stand in for each other. */
export async function castKey(): Promise<Buffer> {
  return (cachedKey ??= createHmac("sha256", await formKey()).update("cast-link:v1").digest());
}

function sign(key: Buffer, photoId: string, expiresAt: number): string {
  return createHmac("sha256", key).update(`cast:${photoId}:${expiresAt}`).digest("base64url");
}

/** What goes in `?cast=`: when it stops working, and the album's signature on that and the picture. */
export function signCastLink(key: Buffer, photoId: string, expiresAt: number): string {
  return `${expiresAt}.${sign(key, photoId, expiresAt)}`;
}

/** Whether this is the album's own signature for this picture and its time is not up. Anything else is no. */
export function readCastLink(key: Buffer, photoId: string, token: unknown, now: number): boolean {
  if (typeof token !== "string") return false;
  const m = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return false;
  const expiresAt = Number(m[1]);
  const given = Buffer.from(m[2]!);
  const expected = Buffer.from(sign(key, photoId, expiresAt));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  // Never further ahead than the album itself would have signed: a clock set wrong once does not make a link for ever.
  return now < expiresAt && expiresAt - now <= CAST_LINK_MS + 60_000;
}

/** The address a television fetches one slide from. */
export async function castUrl(photo: { id: string; imageVersion: number }, now = Date.now()): Promise<string> {
  return `/api/photos/${photo.id}/preview?v=${photo.imageVersion}&cast=${signCastLink(await castKey(), photo.id, now + CAST_LINK_MS)}`;
}

/** A clip's own address for a television: the copy the album made for playing, signed as its still is. */
export async function castVideoUrl(photo: { id: string; imageVersion: number }, now = Date.now()): Promise<string> {
  return `/api/photos/${photo.id}/video?v=${photo.imageVersion}&cast=${signCastLink(await castKey(), photo.id, now + CAST_LINK_MS)}`;
}

export async function castLinkGood(photoId: string, token: unknown, now = Date.now()): Promise<boolean> {
  return readCastLink(await castKey(), photoId, token, now);
}

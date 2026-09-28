import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";

/** A person reads the page and writes something; a script posts at once. */
export const MIN_FILL_MS = 3_000;
/** A form left open longer than a day is asked to be sent again, so an old token cannot be replayed for ever. */
export const MAX_FILL_MS = 24 * 60 * 60 * 1000;

let cachedKey: Buffer | undefined;

/**
 * The key the note form's timing token is signed with: random, made once per install and kept in the database, so
 * every web process and every restart agree on it. The token only proves the form was fetched from here a while
 * ago, so whoever holds a copy of the database gains nothing from it.
 */
export async function formKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  // Two first uses at once must agree on one key: whichever insert or fill comes first wins, and both read it back.
  await db.$executeRaw`INSERT INTO "AppSetting" (id, "noteFormKey", "updatedAt") VALUES ('app', ${randomBytes(32).toString("base64")}, now()) ON CONFLICT (id) DO NOTHING`;
  await db.appSetting.updateMany({ where: { id: "app", noteFormKey: null }, data: { noteFormKey: randomBytes(32).toString("base64") } });
  const row = await db.appSetting.findUniqueOrThrow({ where: { id: "app" }, select: { noteFormKey: true } });
  cachedKey = Buffer.from(row.noteFormKey!, "base64");
  return cachedKey;
}

function sign(key: Buffer, issuedAt: number): string {
  return createHmac("sha256", key).update(`visitor-note:${issuedAt}`).digest("base64url");
}

/** The token a freshly drawn form carries: when it was drawn, and the album's signature on that. */
export function signFormToken(key: Buffer, issuedAt: number): string {
  return `${issuedAt}.${sign(key, issuedAt)}`;
}

export type TokenCheck = "ok" | "too-fast" | "stale";

/**
 * Whether the form was drawn here between three seconds and a day ago. A token that is missing, malformed, not
 * ours or dated in the future is "stale", like one that has expired: the sender is simply asked to send it again.
 */
export function readFormToken(key: Buffer, token: unknown, now: number): TokenCheck {
  if (typeof token !== "string") return "stale";
  const m = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return "stale";
  const issuedAt = Number(m[1]);
  const given = Buffer.from(m[2]!);
  const expected = Buffer.from(sign(key, issuedAt));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "stale";
  const age = now - issuedAt;
  if (age < 0 || age > MAX_FILL_MS) return "stale";
  if (age < MIN_FILL_MS) return "too-fast";
  return "ok";
}

export async function issueFormToken(now = Date.now()): Promise<string> {
  return signFormToken(await formKey(), now);
}

export async function checkFormToken(token: unknown, now = Date.now()): Promise<TokenCheck> {
  return readFormToken(await formKey(), token, now);
}

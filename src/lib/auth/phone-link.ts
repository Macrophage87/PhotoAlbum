import { createHash, timingSafeEqual } from "node:crypto";
import type { Db } from "@/lib/db";
import { createDeviceToken, deviceName } from "./device-token";
import { generateToken, hashToken } from "./tokens";

/**
 * Connecting the album's app to a member, by way of the sign-in the album already has. The app never sees an
 * email or a password of its own:
 *
 *   1. The app makes a secret (the verifier), keeps it, and opens the album's website at /account/phone with the
 *      secret's hash (the challenge).
 *   2. The member signs in there as they always do, and says yes. That makes a PhoneLink and a one-time code, and
 *      the page hands the code back to the app through a link.
 *   3. The app sends the code and the verifier; if they belong together the album gives it a device token.
 *
 * The code travels through a link any app on the phone could claim, which is why it is worth nothing without the
 * verifier, which never leaves the app that made it (the same idea as PKCE in OAuth).
 */

/** How long a member's yes is good for: long enough to switch back to the app, not to be found lying around. */
export const PHONE_LINK_TTL_MS = 10 * 60 * 1000;

/** A code, a verifier and a challenge all have this shape: 32 random bytes, or a SHA-256, in URL-safe base64. */
const SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The link schemes the app answers to: the one from Play, and the debug build that installs beside it. */
export const APP_SCHEMES = ["familyalbum", "familyalbum-debug"] as const;
export type AppScheme = (typeof APP_SCHEMES)[number];

export function appScheme(value: unknown): AppScheme {
  return APP_SCHEMES.find((s) => s === value) ?? "familyalbum";
}

export function isChallenge(value: unknown): value is string {
  return typeof value === "string" && SHAPE.test(value);
}

/** What the app sends first: the hash of its secret. */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** The member said yes. Returns the code to hand back to the app, once; only its hash is kept. */
export async function createPhoneLink(db: Db, userId: string, challenge: string, name?: string | null, now: Date = new Date()): Promise<string> {
  if (!isChallenge(challenge)) throw new Error("Bad challenge");
  // A yes that was never used is of no use to anyone later; clearing the member's old ones keeps the table small.
  await db.phoneLink.deleteMany({ where: { OR: [{ userId }, { createdAt: { lt: new Date(now.getTime() - PHONE_LINK_TTL_MS) } }] } });
  const code = generateToken();
  await db.phoneLink.create({ data: { id: hashToken(code), userId, challenge, name: deviceName(name) } });
  return code;
}

/**
 * The app comes back with the code and its secret. Null when the code is unknown, too old, already used, the
 * secret is not the one the challenge was made from, or the member is being removed. The link is used up either
 * way once found, so a wrong guess at the secret cannot be followed by another.
 */
export async function redeemPhoneLink(db: Db, code: unknown, verifier: unknown, now: Date = new Date()): Promise<{ token: string; name: string } | null> {
  if (typeof code !== "string" || typeof verifier !== "string" || !SHAPE.test(code) || !SHAPE.test(verifier)) return null;
  const id = hashToken(code);
  // Deleting is the claim: of two requests with the same code, only one gets a row back.
  const link = await db.phoneLink.delete({ where: { id } }).catch(() => null);
  if (!link) return null;
  if (now.getTime() - link.createdAt.getTime() > PHONE_LINK_TTL_MS) return null;
  const expected = Buffer.from(link.challenge);
  const given = Buffer.from(challengeOf(verifier));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const user = await db.user.findUnique({ where: { id: link.userId }, select: { removingAt: true } });
  if (!user || user.removingAt) return null;
  const { token } = await createDeviceToken(db, link.userId, link.name);
  return { token, name: link.name };
}

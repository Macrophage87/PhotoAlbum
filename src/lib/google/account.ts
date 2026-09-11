import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "./crypto";
import { GoogleAuthError, refreshAccessToken, revokeToken } from "./oauth";

export type GoogleStatus = { connected: boolean; needsReconnect: boolean; connectedAt: string | null };

export async function googleStatus(userId: string): Promise<GoogleStatus> {
  const a = await db.googleAccount.findUnique({ where: { userId }, select: { connectedAt: true, needsReconnect: true } });
  return { connected: Boolean(a), needsReconnect: a?.needsReconnect ?? false, connectedAt: a?.connectedAt.toISOString() ?? null };
}

export async function storeRefreshToken(userId: string, refreshToken: string): Promise<void> {
  const encryptedRefreshToken = encryptSecret(refreshToken);
  await db.googleAccount.upsert({ where: { userId }, create: { userId, encryptedRefreshToken }, update: { encryptedRefreshToken, needsReconnect: false, connectedAt: new Date() } });
}

// Access tokens live about an hour; keep them in memory per member so a picking session refreshes once.
const cache = new Map<string, { token: string; expiresAt: number }>();

/** A live access token for the member, refreshing from the stored refresh token; marks the account when Google says it is gone. */
export async function accessTokenFor(userId: string): Promise<string> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const account = await db.googleAccount.findUnique({ where: { userId } });
  if (!account) throw new GoogleAuthError("Google Photos is not connected", true);
  if (account.needsReconnect) throw new GoogleAuthError("Google Photos needs to be connected again", true);
  try {
    const t = await refreshAccessToken(decryptSecret(account.encryptedRefreshToken));
    cache.set(userId, { token: t.accessToken, expiresAt: Date.now() + t.expiresIn * 1000 });
    await db.googleAccount.update({ where: { userId }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    return t.accessToken;
  } catch (err) {
    if (err instanceof GoogleAuthError && err.needsReconnect) await db.googleAccount.update({ where: { userId }, data: { needsReconnect: true } }).catch(() => undefined);
    throw err;
  }
}

/** Forget the grant here and, best effort, at Google. */
export async function disconnectGoogleAccount(userId: string): Promise<void> {
  const account = await db.googleAccount.findUnique({ where: { userId } });
  cache.delete(userId);
  if (!account) return;
  await db.googleAccount.delete({ where: { userId } });
  try {
    await revokeToken(decryptSecret(account.encryptedRefreshToken));
  } catch {
    /* an undecryptable token (rotated key) cannot be revoked; the local copy is gone */
  }
}

export const _cacheForTests = cache;

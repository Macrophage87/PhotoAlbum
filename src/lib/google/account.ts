import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "./crypto";
import { GoogleAuthError, refreshAccessToken, revokeToken, revokeTokenOrThrow } from "./oauth";

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
/** A token with less than this left is refreshed rather than handed out: a download can take minutes. */
const TOKEN_MARGIN_MS = 5 * 60_000;

/** A live access token for the member, refreshing from the stored refresh token; marks the account when Google says it is gone. */
export async function accessTokenFor(userId: string): Promise<string> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now() + TOKEN_MARGIN_MS) return hit.token;
  const account = await db.googleAccount.findUnique({ where: { userId } });
  if (!account) throw new GoogleAuthError("Google Photos is not connected", true);
  if (account.needsReconnect) throw new GoogleAuthError("Google Photos needs to be connected again", true);
  try {
    const t = await refreshAccessToken(decryptSecret(account.encryptedRefreshToken));
    cache.set(userId, { token: t.accessToken, expiresAt: Date.now() + t.expiresIn * 1000 });
    await db.googleAccount.update({ where: { userId }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    return t.accessToken;
  } catch (err) {
    await noteAuthFailure(userId, err);
    throw err;
  }
}

/**
 * Google said the grant is gone (invalid_grant on refresh, or a 401 on a Picker call or download): remember it on
 * the account so the Upload page offers "Connect again", and drop the cached access token so nothing reuses it.
 * Any other error is left alone. Returns true when the error was a reconnect case.
 */
export async function noteAuthFailure(userId: string, err: unknown): Promise<boolean> {
  if (!(err instanceof GoogleAuthError) || !err.needsReconnect) return false;
  cache.delete(userId);
  await db.googleAccount.updateMany({ where: { userId }, data: { needsReconnect: true } }).catch(() => undefined);
  return true;
}

/**
 * Stop handing out the cached access token, so the next accessTokenFor refreshes. For a token Google refused (a 401)
 * although the grant itself may be fine: an access token that expired is not a revoked grant, and only a refresh
 * that fails says the member has to connect again.
 */
export function forgetAccessToken(userId: string): void {
  cache.delete(userId);
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

/**
 * Revoke at Google a connection whose row is already gone (a removed member's goes with their account), and stop
 * handing out its cached access token. "failed" when Google could not be told: the caller queues it to be tried
 * again (`revokeQueuedConnection`), since the grant would otherwise outlive the member.
 */
export async function revokeRemovedConnection(userId: string, encryptedRefreshToken: string | null): Promise<"revoked" | "failed" | "none"> {
  cache.delete(userId);
  if (!encryptedRefreshToken) return "none";
  let token: string;
  try {
    token = decryptSecret(encryptedRefreshToken);
  } catch {
    // An undecryptable token (rotated key) cannot be revoked; the local copy is gone.
    return "none";
  }
  try {
    await revokeTokenOrThrow(token);
    return "revoked";
  } catch (err) {
    console.error("[google] could not revoke a removed member's Google connection; queued to try again", err instanceof Error ? err.message : err);
    return "failed";
  }
}

/** The retry: throws while Google cannot be told, so the queue tries again later. */
export async function revokeQueuedConnection(job: { encryptedRefreshToken: string }): Promise<void> {
  let token: string;
  try {
    token = decryptSecret(job.encryptedRefreshToken);
  } catch {
    return;
  }
  await revokeTokenOrThrow(token);
}

export const _cacheForTests = cache;

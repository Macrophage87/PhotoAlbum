import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.hoisted(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64");
});
const oauth = vi.hoisted(() => ({ refresh: vi.fn(), revoked: [] as string[] }));
vi.mock("@/lib/google/oauth", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/google/oauth");
  return { ...real, refreshAccessToken: oauth.refresh, revokeToken: async (t: string) => { oauth.revoked.push(t); } };
});

import { _cacheForTests, accessTokenFor, disconnectGoogleAccount, googleStatus, storeRefreshToken } from "@/lib/google/account";
import { GoogleAuthError } from "@/lib/google/oauth";

describe("a member's Google connection", () => {
  let userId: string;
  beforeEach(async () => {
    await resetTestDb();
    _cacheForTests.clear();
    oauth.refresh.mockReset();
    oauth.revoked.length = 0;
    userId = (await db.user.create({ data: { email: "g@example.com", role: "MEMBER" } })).id;
  });
  afterEach(() => _cacheForTests.clear());
  it("stores the refresh token encrypted, refreshes once per hour, and revokes on disconnect", async () => {
    await storeRefreshToken(userId, "1//rt");
    const row = await db.googleAccount.findUniqueOrThrow({ where: { userId } });
    expect(row.encryptedRefreshToken).not.toContain("1//rt");
    oauth.refresh.mockResolvedValue({ accessToken: "at", expiresIn: 3600 });
    expect(await accessTokenFor(userId)).toBe("at");
    expect(await accessTokenFor(userId)).toBe("at");
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(oauth.refresh).toHaveBeenCalledWith("1//rt");
    expect((await googleStatus(userId)).connected).toBe(true);
    await disconnectGoogleAccount(userId);
    expect(oauth.revoked).toEqual(["1//rt"]);
    expect((await googleStatus(userId)).connected).toBe(false);
    await expect(accessTokenFor(userId)).rejects.toBeInstanceOf(GoogleAuthError);
  });
  it("marks the account when Google says the grant is gone, and clears the mark on reconnect", async () => {
    await storeRefreshToken(userId, "1//old");
    oauth.refresh.mockRejectedValue(new GoogleAuthError("revoked", true));
    await expect(accessTokenFor(userId)).rejects.toMatchObject({ needsReconnect: true });
    expect((await googleStatus(userId)).needsReconnect).toBe(true);
    await storeRefreshToken(userId, "1//new");
    expect((await googleStatus(userId)).needsReconnect).toBe(false);
  });
  it("goes with the member when their account is deleted", async () => {
    await storeRefreshToken(userId, "1//rt");
    await db.user.delete({ where: { id: userId } });
    expect(await db.googleAccount.count()).toBe(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));

import { appScheme, challengeOf, createPhoneLink, isChallenge, PHONE_LINK_TTL_MS, redeemPhoneLink } from "@/lib/auth/phone-link";
import { readDeviceUser } from "@/lib/auth/device-token";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import { POST as exchange } from "@/app/api/v1/phone-link/route";

const post = (body: unknown) => exchange(new Request("http://localhost/api/v1/phone-link", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

describe("connecting a phone through the album's own sign-in", () => {
  let userId: string;
  const verifier = generateToken();
  const challenge = challengeOf(verifier);
  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "pat@example.com", name: "Pat" } })).id;
  });

  it("knows a challenge by its shape, and the app by its link scheme", () => {
    expect(isChallenge(challenge)).toBe(true);
    expect(isChallenge("short")).toBe(false);
    expect(isChallenge(undefined)).toBe(false);
    expect(appScheme("familyalbum-debug")).toBe("familyalbum-debug");
    expect(appScheme("javascript")).toBe("familyalbum");
    expect(appScheme(undefined)).toBe("familyalbum");
  });

  it("gives the phone a token for the code and the secret together, once", async () => {
    const code = await createPhoneLink(db, userId, challenge, "Pixel 9");
    expect(await db.phoneLink.count({ where: { id: code } })).toBe(0);
    expect(await db.phoneLink.count({ where: { id: hashToken(code) } })).toBe(1);
    const linked = await redeemPhoneLink(db, code, verifier);
    expect(linked?.name).toBe("Pixel 9");
    expect((await readDeviceUser(db, linked!.token))?.id).toBe(userId);
    expect(await redeemPhoneLink(db, code, verifier)).toBeNull();
    expect(await db.deviceToken.count()).toBe(1);
  });

  it("is worth nothing to an app that caught the code but does not hold the secret, and is then used up", async () => {
    const code = await createPhoneLink(db, userId, challenge);
    expect(await redeemPhoneLink(db, code, generateToken())).toBeNull();
    expect(await redeemPhoneLink(db, code, verifier)).toBeNull();
    expect(await db.deviceToken.count()).toBe(0);
  });

  it("stops working after ten minutes", async () => {
    const code = await createPhoneLink(db, userId, challenge);
    expect(await redeemPhoneLink(db, code, verifier, new Date(Date.now() + PHONE_LINK_TTL_MS + 1000))).toBeNull();
    expect(await db.deviceToken.count()).toBe(0);
  });

  it("keeps one pending yes per member, and none for a member being removed", async () => {
    const first = await createPhoneLink(db, userId, challenge);
    const second = await createPhoneLink(db, userId, challenge);
    expect(await db.phoneLink.count()).toBe(1);
    expect(await redeemPhoneLink(db, first, verifier)).toBeNull();
    await db.user.update({ where: { id: userId }, data: { removingAt: new Date() } });
    expect(await redeemPhoneLink(db, second, verifier)).toBeNull();
  });

  it("refuses anything that is not a code and a secret", async () => {
    expect(await redeemPhoneLink(db, undefined, verifier)).toBeNull();
    expect(await redeemPhoneLink(db, "nope", "nope")).toBeNull();
    await expect(createPhoneLink(db, userId, "not a challenge")).rejects.toThrow();
  });

  it("answers the app over the route", async () => {
    const code = await createPhoneLink(db, userId, challenge, "Pixel 9");
    expect((await post("not json")).status).toBe(400);
    expect((await post({ code })).status).toBe(400);
    // A new yes replaces the member's earlier one.
    const again = await createPhoneLink(db, userId, challenge, "Pixel 9");
    const ok = await post({ code: again, verifier });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { token: string; name: string };
    expect(body.name).toBe("Pixel 9");
    expect((await readDeviceUser(db, body.token))?.id).toBe(userId);
  });
});

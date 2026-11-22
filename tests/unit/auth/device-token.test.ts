import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const jar = vi.hoisted(() => ({ session: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "session" && jar.session ? { name, value: jar.session } : undefined),
    getAll: () => [],
  }),
}));

import { bearerToken, createDeviceToken, DEVICE_TOKEN_IDLE_MS, DEVICE_TOKEN_TOUCH_MS, deviceName, readDeviceUser } from "@/lib/auth/device-token";
import { hashToken } from "@/lib/auth/tokens";
import { GET as me } from "@/app/api/v1/me/route";
import { GET as status } from "@/app/api/photos/status/route";

const call = (token?: string) => new Request("http://localhost/api/v1/me", { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("a phone's token", () => {
  let userId: string;
  beforeEach(async () => {
    jar.session = null;
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "pat@example.com", name: "Pat" } })).id;
  });

  it("reads a bearer header only when it has the shape of a token", () => {
    const token = "A".repeat(43);
    expect(bearerToken(new Headers({ authorization: `Bearer ${token}` }))).toBe(token);
    expect(bearerToken(new Headers({ authorization: `bearer  ${token} ` }))).toBe(token);
    expect(bearerToken(new Headers({ authorization: `Basic ${token}` }))).toBeNull();
    expect(bearerToken(new Headers({ authorization: "Bearer short" }))).toBeNull();
    expect(bearerToken(new Headers({ authorization: `Bearer ${token} extra` }))).toBeNull();
    expect(bearerToken(new Headers())).toBeNull();
  });

  it("names a phone in one short line", () => {
    expect(deviceName("  Pixel 9\n")).toBe("Pixel 9");
    expect(deviceName("")).toBe("Phone");
    expect(deviceName(null)).toBe("Phone");
    expect(deviceName("x".repeat(200))).toHaveLength(80);
  });

  it("keeps only the hash, and finds its member by the token", async () => {
    const { token, id } = await createDeviceToken(db, userId, "Pixel 9");
    expect(id).toBe(hashToken(token));
    expect(await db.deviceToken.count({ where: { id: token } })).toBe(0);
    expect((await readDeviceUser(db, token))?.id).toBe(userId);
    expect(await readDeviceUser(db, "B".repeat(43))).toBeNull();
  });

  it("is not honoured once left unused too long, and is then forgotten", async () => {
    const { token, id } = await createDeviceToken(db, userId);
    const later = new Date(Date.now() + DEVICE_TOKEN_IDLE_MS + 60_000);
    expect(await readDeviceUser(db, token, later)).toBeNull();
    expect(await db.deviceToken.count({ where: { id } })).toBe(0);
  });

  it("notes that it was used, but not on every request", async () => {
    const { token, id } = await createDeviceToken(db, userId);
    const made = (await db.deviceToken.findUniqueOrThrow({ where: { id } })).lastUsedAt;
    await readDeviceUser(db, token, new Date(made.getTime() + 60_000));
    expect((await db.deviceToken.findUniqueOrThrow({ where: { id } })).lastUsedAt).toEqual(made);
    const next = new Date(made.getTime() + DEVICE_TOKEN_TOUCH_MS + 60_000);
    await readDeviceUser(db, token, next);
    expect((await db.deviceToken.findUniqueOrThrow({ where: { id } })).lastUsedAt).toEqual(next);
    // Used again within the idle time of that, it is still good long after it was made.
    expect((await readDeviceUser(db, token, new Date(next.getTime() + DEVICE_TOKEN_IDLE_MS - 60_000)))?.id).toBe(userId);
  });

  it("stops working the moment its member is being removed", async () => {
    const { token } = await createDeviceToken(db, userId);
    await db.user.update({ where: { id: userId }, data: { removingAt: new Date() } });
    expect(await readDeviceUser(db, token)).toBeNull();
  });

  it("goes with its member", async () => {
    await createDeviceToken(db, userId);
    await db.user.delete({ where: { id: userId } });
    expect(await db.deviceToken.count()).toBe(0);
  });

  it("opens the app's routes: who am I and the album's limits", async () => {
    const { token } = await createDeviceToken(db, userId);
    expect((await me(call())).status).toBe(401);
    expect((await me(call("C".repeat(43)))).status).toBe(401);
    const res = await me(call(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toEqual({ id: userId, email: "pat@example.com", name: "Pat", role: "MEMBER" });
    expect(body.limits.clipSeconds).toBeGreaterThan(0);
    expect(body.limits.photoBytes).toBeGreaterThan(0);
    expect(body.limits.videoBytes).toBeGreaterThan(0);
    expect(body.limits.imageTypes).toContain("image/heic");
    expect(body.limits.videoTypes).toContain("video/mp4");
  });

  it("opens the upload's status route too", async () => {
    const { token } = await createDeviceToken(db, userId);
    const url = "http://localhost/api/photos/status?ids=x";
    expect((await status(new Request(url))).status).toBe(401);
    expect((await status(new Request(url, { headers: { authorization: `Bearer ${token}` } }))).status).toBe(200);
  });

  it("tells the app whether the album already holds a file, by its hash", async () => {
    const { token } = await createDeviceToken(db, userId);
    const ask = async (sha256: string) => status(new Request(`http://localhost/api/photos/status?sha256=${sha256}`, { headers: { authorization: `Bearer ${token}` } }));
    const hash = "a".repeat(64);
    expect(await (await ask(hash)).json()).toEqual({ have: null });
    expect((await ask("not-a-hash")).status).toBe(400);

    const other = await db.user.create({ data: { email: "sam@example.com" } });
    const photo = { status: "READY" as const, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/original.jpg", sizeBytes: 1, contentHash: hash };
    const binned = await db.photo.create({ data: { ...photo, uploaderId: userId, trashedAt: new Date() } });
    expect(await (await ask(hash)).json()).toEqual({ have: null });
    const kept = await db.photo.create({ data: { ...photo, uploaderId: other.id } });
    expect(await (await ask(hash)).json()).toEqual({ have: { id: kept.id, status: "READY", mine: false } });
    expect(binned.id).not.toBe(kept.id);
  });
});

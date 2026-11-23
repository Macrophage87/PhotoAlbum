import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => null }));

import { createDeviceToken } from "@/lib/auth/device-token";
import { CAST_LINK_MS, readCastLink, signCastLink } from "@/lib/cast/link";
import { GET as slideshow } from "@/app/api/v1/album/slideshow/route";
import { GET as bytes } from "@/app/api/photos/[id]/[size]/route";

const req = (path: string, token?: string) => new Request(`http://album.test${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("a cast link's signature", () => {
  const key = Buffer.alloc(32, 7);
  const now = 1_800_000_000_000;
  it("is good for its own picture until its time is up", () => {
    const token = signCastLink(key, "p1", now + CAST_LINK_MS);
    expect(readCastLink(key, "p1", token, now)).toBe(true);
    expect(readCastLink(key, "p1", token, now + CAST_LINK_MS - 1)).toBe(true);
    expect(readCastLink(key, "p1", token, now + CAST_LINK_MS)).toBe(false);
  });
  it("opens no other picture, and nothing under another key", () => {
    const token = signCastLink(key, "p1", now + CAST_LINK_MS);
    expect(readCastLink(key, "p2", token, now)).toBe(false);
    expect(readCastLink(Buffer.alloc(32, 8), "p1", token, now)).toBe(false);
  });
  it("is refused when it is missing, malformed, altered, or dated further ahead than the album signs", () => {
    const token = signCastLink(key, "p1", now + CAST_LINK_MS);
    for (const bad of [null, undefined, "", "nonsense", `${now + CAST_LINK_MS}.${"A".repeat(43)}`, token.replace(/^\d+/, String(now + 2 * CAST_LINK_MS))]) expect(readCastLink(key, "p1", bad, now)).toBe(false);
    expect(readCastLink(key, "p1", signCastLink(key, "p1", now + 10 * CAST_LINK_MS), now)).toBe(false);
  });
});

/** What the app asks for before it casts, and what a television can then fetch with no sign-in of its own. */
describe("the slideshow for a television", () => {
  let token: string, userId: string, tripId: string, firstId: string, secondId: string;

  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "pat@example.com", name: "Pat" } })).id;
    token = (await createDeviceToken(db, userId, "Pixel")).token;
    tripId = (await db.trip.create({ data: { slug: "coast", title: "Coast", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: userId } })).id;
    const mk = async (name: string, extra: Record<string, unknown> = {}) =>
      (await db.photo.create({ data: { tripId, uploaderId: userId, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", width: 100, height: 80, tzOffsetMin: -240, ...extra } })).id;
    secondId = await mk("second", { takenAt: new Date("2025-08-12T15:00:00Z") });
    firstId = await mk("first", { takenAt: new Date("2025-08-11T15:00:00Z"), caption: "Low tide" });
    await mk("clip", { kind: "VIDEO", takenAt: new Date("2025-08-11T16:00:00Z") });
  });

  it("is a member's to ask for, and says which trip or collection", async () => {
    expect((await slideshow(req("/api/v1/album/slideshow?trip=coast"))).status).toBe(401);
    expect((await slideshow(req("/api/v1/album/slideshow", token))).status).toBe(400);
    expect((await slideshow(req("/api/v1/album/slideshow?trip=coast&collection=best", token))).status).toBe(400);
    expect((await slideshow(req("/api/v1/album/slideshow?trip=nowhere", token))).status).toBe(404);
    expect((await slideshow(req("/api/v1/album/slideshow?collection=nowhere", token))).status).toBe(404);
  });

  it("gives a trip's photographs in order, each with an address a television can fetch", async () => {
    const body = await (await slideshow(req("/api/v1/album/slideshow?trip=coast", token))).json();
    expect(body.title).toBe("Coast");
    expect(body.slides.map((s: { id: string }) => s.id)).toEqual([firstId, secondId]);
    expect(body.slides[0]).toMatchObject({ caption: "Low tide", day: expect.stringContaining("August 11, 2025") });
    expect(body.slides[0].thumb).toMatch(new RegExp(`^/api/photos/${firstId}/thumb\\?v=\\d+$`));
    expect(body.slides[0].cast).toMatch(new RegExp(`^/api/photos/${firstId}/preview\\?v=\\d+&cast=\\d+\\.[A-Za-z0-9_-]{43}$`));
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("gives a collection's too", async () => {
    const c = await db.collection.create({ data: { slug: "best", title: "Best", createdById: userId } });
    await db.collectionItem.create({ data: { collectionId: c.id, photoId: secondId, addedById: userId } });
    const body = await (await slideshow(req("/api/v1/album/slideshow?collection=best", token))).json();
    expect(body.title).toBe("Best");
    expect(body.slides.map((s: { id: string }) => s.id)).toEqual([secondId]);
  });

  it("lets the signed address past the door with no sign-in, for that picture at that size only", async () => {
    const body = await (await slideshow(req("/api/v1/album/slideshow?trip=coast", token))).json();
    const cast = new URL(body.slides[0].cast, "http://album.test").searchParams.get("cast")!;
    const fetchAs = (id: string, size: string, query: string) => bytes(req(`/api/photos/${id}/${size}?v=1${query}`), { params: Promise.resolve({ id, size }) });
    // Past the door: the test photo has no picture stored, so the answer is that it is not ready, not that it is refused.
    expect((await fetchAs(firstId, "preview", `&cast=${cast}`)).status).toBe(404);
    expect((await fetchAs(firstId, "preview", "")).status).toBe(401);
    expect((await fetchAs(firstId, "preview", "&cast=1.x")).status).toBe(401);
    // Another picture, or the file itself, is not what was signed.
    expect((await fetchAs(secondId, "preview", `&cast=${cast}`)).status).toBe(401);
    expect((await fetchAs(firstId, "original", `&cast=${cast}`)).status).toBe(401);
    expect((await fetchAs(firstId, "medium", `&cast=${cast}`)).status).toBe(401);
    // In the trash, it is off the television as it is off every link.
    await db.photo.update({ where: { id: firstId }, data: { trashedAt: new Date() } });
    expect((await fetchAs(firstId, "preview", `&cast=${cast}`)).status).toBe(401);
  });
});

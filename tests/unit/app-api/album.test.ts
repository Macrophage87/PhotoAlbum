import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => null }));

import { createDeviceToken } from "@/lib/auth/device-token";
import { GET as trips } from "@/app/api/v1/album/trips/route";
import { GET as trip } from "@/app/api/v1/album/trips/[slug]/route";
import { GET as collections } from "@/app/api/v1/album/collections/route";
import { GET as collection } from "@/app/api/v1/album/collections/[slug]/route";
import { GET as onThisDay } from "@/app/api/v1/album/on-this-day/route";
import { GET as bytes } from "@/app/api/photos/[id]/[size]/route";

const req = (path: string, token?: string) => new Request(`http://album.test${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

/** What the phone app reads to browse the album: members only, by the phone's token. */
describe("the app's album browsing", () => {
  let token: string, userId: string, tripId: string, firstId: string, secondId: string, privateTripPhoto: string;

  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "pat@example.com", name: "Pat" } })).id;
    token = (await createDeviceToken(db, userId, "Pixel")).token;
    tripId = (await db.trip.create({ data: { slug: "coast", title: "Coast", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: userId } })).id;
    await db.trip.create({ data: { slug: "older", title: "Older", startDate: new Date("2024-05-01"), endDate: new Date("2024-05-03"), createdById: userId } });
    const mk = async (name: string, extra: Record<string, unknown> = {}) =>
      (await db.photo.create({ data: { tripId, uploaderId: userId, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", width: 100, height: 80, tzOffsetMin: -240, ...extra } })).id;
    secondId = await mk("second", { takenAt: new Date("2025-08-12T15:00:00Z") });
    firstId = await mk("first", { takenAt: new Date("2025-08-11T15:00:00Z"), caption: "Low tide", lat: 43.8, lng: -69.5 });
    await mk("busy", { status: "PROCESSING", takenAt: new Date("2025-08-11T16:00:00Z") });
    privateTripPhoto = firstId;
  });

  it("is refused without a phone's token", async () => {
    for (const res of [await trips(req("/api/v1/album/trips")), await collections(req("/api/v1/album/collections")), await onThisDay(req("/api/v1/album/on-this-day?date=2026-08-11"))]) {
      expect(res.status).toBe(401);
    }
    expect((await trip(req("/api/v1/album/trips/coast"), { params: Promise.resolve({ slug: "coast" }) })).status).toBe(401);
  });

  it("lists the trips newest first, with their covers and counts", async () => {
    const body = await (await trips(req("/api/v1/album/trips", token))).json();
    expect(body.trips.map((t: { slug: string }) => t.slug)).toEqual(["coast", "older"]);
    expect(body.trips[0]).toMatchObject({ title: "Coast", startDate: "2025-08-10", endDate: "2025-08-16", items: 3, page: "/trips/coast" });
    expect(body.trips[0].cover.thumb).toMatch(new RegExp(`^/api/photos/${firstId}/thumb\\?v=`));
    expect(body.next).toBeNull();
    expect((await (await trips(req("/api/v1/album/trips?from=1", token))).json()).trips.map((t: { slug: string }) => t.slug)).toEqual(["older"]);
  });

  it("gives one trip's finished items in the order it happened", async () => {
    const res = await trip(req("/api/v1/album/trips/coast", token), { params: Promise.resolve({ slug: "coast" }) });
    const body = await res.json();
    expect(body.trip.title).toBe("Coast");
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([firstId, secondId]);
    expect(body.items[0]).toMatchObject({ kind: "PHOTO", day: "2025-08-11", caption: "Low tide", lat: 43.8, lng: -69.5, page: `/photos/${firstId}`, video: null, youtubeId: null });
    expect(body.items[0].full).toMatch(new RegExp(`^/api/photos/${firstId}/original\\?v=`));
    expect(body.next).toBeNull();
    expect((await trip(req("/api/v1/album/trips/nowhere", token), { params: Promise.resolve({ slug: "nowhere" }) })).status).toBe(404);
  });

  it("gives the collections and what is in them", async () => {
    const c = await db.collection.create({ data: { slug: "best", title: "Best", createdById: userId } });
    await db.collectionItem.create({ data: { collectionId: c.id, photoId: secondId, addedById: userId } });
    const list = await (await collections(req("/api/v1/album/collections", token))).json();
    expect(list.collections).toMatchObject([{ slug: "best", title: "Best", items: 1 }]);
    const one = await (await collection(req("/api/v1/album/collections/best", token), { params: Promise.resolve({ slug: "best" }) })).json();
    expect(one.items.map((i: { id: string }) => i.id)).toEqual([secondId]);
    expect(one.total).toBe(1);
  });

  it("answers On this day for the phone's date", async () => {
    const body = await (await onThisDay(req("/api/v1/album/on-this-day?date=2026-08-11", token))).json();
    expect(body.photos.map((p: { id: string }) => p.id)).toEqual([firstId]);
    expect((await onThisDay(req("/api/v1/album/on-this-day?date=tomorrow", token))).status).toBe(400);
  });

  it("lets the phone's token fetch the pictures of a private trip, as a member's browser can", async () => {
    const call = (t?: string) => bytes(req(`/api/photos/${privateTripPhoto}/thumb?v=1`, t), { params: Promise.resolve({ id: privateTripPhoto, size: "thumb" }) });
    expect((await call()).status).toBe(401);
    // Past the door: the test photo has no picture stored, so the answer is that it is not ready, not that it is forbidden.
    expect((await call(token)).status).toBe(404);
  });
});

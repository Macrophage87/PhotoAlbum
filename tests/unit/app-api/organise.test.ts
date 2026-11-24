import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => null }));

import { createDeviceToken } from "@/lib/auth/device-token";
import { GET as trips, POST as newTrip } from "@/app/api/v1/trips/route";
import { GET as activities, POST as newActivity } from "@/app/api/v1/trips/[id]/activities/route";
import { GET as collections, POST as newCollection } from "@/app/api/v1/collections/route";
import { POST as file } from "@/app/api/v1/file/route";

const req = (path: string, token?: string, body?: unknown) =>
  new Request(`http://album.test${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const at = (id: string) => ({ params: Promise.resolve({ id }) });

/** What the phone app uses to make trips, activities and collections and to put photographs on them. */
describe("arranging the album from the app", () => {
  let token: string, userId: string, otherToken: string, otherId: string;
  let n = 0;
  const photo = async (uploaderId: string, extra: Record<string, unknown> = {}) =>
    (await db.photo.create({ data: { uploaderId, originalName: `p${++n}`, mimeType: "image/jpeg", storageKey: `p${n}`, originalPath: `p${n}/o.jpg`, sizeBytes: 1, status: "READY", width: 100, height: 80, ...extra } })).id;

  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "pat@example.com", name: "Pat" } })).id;
    otherId = (await db.user.create({ data: { email: "sam@example.com", name: "Sam" } })).id;
    token = (await createDeviceToken(db, userId, "Pixel")).token;
    otherToken = (await createDeviceToken(db, otherId, "Galaxy")).token;
  });

  it("is refused without a phone's token", async () => {
    expect((await newTrip(req("/api/v1/trips", undefined, { title: "x", startDate: "2025-08-10", endDate: "2025-08-11" }))).status).toBe(401);
    expect((await activities(req("/api/v1/trips/x/activities"), at("x"))).status).toBe(401);
    expect((await newActivity(req("/api/v1/trips/x/activities", undefined, {}), at("x"))).status).toBe(401);
    expect((await collections(req("/api/v1/collections"))).status).toBe(401);
    expect((await newCollection(req("/api/v1/collections", undefined, { title: "x" }))).status).toBe(401);
    expect((await file(req("/api/v1/file", undefined, { photoIds: ["a"], tripId: "b" }))).status).toBe(401);
    expect(await db.trip.count()).toBe(0);
  });

  it("makes a trip as the website does, and says what is wrong with one it cannot make", async () => {
    const res = await newTrip(req("/api/v1/trips", token, { title: "  Acadia 2025 ", startDate: "2025-08-10", endDate: "2025-08-16", timezone: "America/New_York" }));
    expect(res.status).toBe(201);
    const { trip } = await res.json();
    expect(trip).toMatchObject({ slug: "acadia-2025", title: "Acadia 2025", startDate: "2025-08-10", endDate: "2025-08-16" });
    expect(await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).toMatchObject({ createdById: userId, timezone: "America/New_York", visibility: "PRIVATE", themeKey: "default" });
    // The same title again gets an address of its own, and is offered where photos are sent.
    const again = await (await newTrip(req("/api/v1/trips", token, { title: "Acadia 2025", startDate: "2025-09-01", endDate: "2025-09-01" }))).json();
    expect(again.trip.slug).not.toBe(trip.slug);
    expect((await (await trips(req("/api/v1/trips", token))).json()).trips).toHaveLength(2);

    const backwards = await newTrip(req("/api/v1/trips", token, { title: "Back", startDate: "2025-08-16", endDate: "2025-08-10" }));
    expect(backwards.status).toBe(400);
    expect((await backwards.json()).error).toBe("End date must be on or after the start date");
    expect((await newTrip(req("/api/v1/trips", token, { startDate: "2025-08-16", endDate: "2025-08-16" }))).status).toBe(400);
    expect((await newTrip(req("/api/v1/trips", token, { title: "Zone", startDate: "2025-08-16", endDate: "2025-08-16", timezone: "Mars/Olympus" }))).status).toBe(400);
  });

  it("makes an activity at the trip's own clock, files what was taken in it, and only for whoever arranges the trip", async () => {
    const tripId = (await db.trip.create({ data: { slug: "coast", title: "Coast", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), timezone: "America/New_York", createdById: userId } })).id;
    const during = await photo(userId, { tripId, takenAt: new Date("2025-08-12T15:00:00Z") });
    const after = await photo(userId, { tripId, takenAt: new Date("2025-08-12T22:00:00Z") });

    const empty = await (await activities(req(`/api/v1/trips/${tripId}/activities`, token), at(tripId))).json();
    expect(empty).toMatchObject({ activities: [], canAdd: true });
    expect(empty.types).toContainEqual({ type: "HIKE", label: "Hike" });
    expect((await (await activities(req(`/api/v1/trips/${tripId}/activities`, otherToken), at(tripId))).json()).canAdd).toBe(false);

    const refused = await newActivity(req(`/api/v1/trips/${tripId}/activities`, otherToken, { title: "Walk", start: "2025-08-12T10:00", end: "2025-08-12T12:00" }), at(tripId));
    expect(refused.status).toBe(403);
    const res = await newActivity(req(`/api/v1/trips/${tripId}/activities`, token, { title: "Walk", type: "HIKE", start: "2025-08-12T10:00", end: "2025-08-12T12:00" }), at(tripId));
    expect(res.status).toBe(201);
    const { activity } = await res.json();
    expect(activity).toMatchObject({ title: "Walk", type: "HIKE", label: "Hike", start: "2025-08-12T10:00", end: "2025-08-12T12:00" });
    // Ten in the morning in Maine is two in the afternoon in Greenwich.
    expect((await db.activity.findUniqueOrThrow({ where: { id: activity.id } })).startTime.toISOString()).toBe("2025-08-12T14:00:00.000Z");
    expect((await db.photo.findUniqueOrThrow({ where: { id: during } })).activityId).toBe(activity.id);
    expect((await db.photo.findUniqueOrThrow({ where: { id: after } })).activityId).toBeNull();
    expect((await (await activities(req(`/api/v1/trips/${tripId}/activities`, token), at(tripId))).json()).activities).toEqual([activity]);

    expect((await newActivity(req(`/api/v1/trips/${tripId}/activities`, token, { title: "Back", start: "2025-08-12T12:00", end: "2025-08-12T10:00" }), at(tripId))).status).toBe(400);
    expect((await newActivity(req("/api/v1/trips/nowhere/activities", token, { title: "x", start: "2025-08-12T10:00", end: "2025-08-12T12:00" }), at("nowhere"))).status).toBe(404);
  });

  it("makes a collection, and lists them all by name", async () => {
    const res = await newCollection(req("/api/v1/collections", token, { title: "Christmas mornings", description: "Every year" }));
    expect(res.status).toBe(201);
    const { collection } = await res.json();
    expect(collection).toMatchObject({ slug: "christmas-mornings", title: "Christmas mornings" });
    expect(await db.collection.findUniqueOrThrow({ where: { id: collection.id } })).toMatchObject({ createdById: userId, description: "Every year", visibility: "PRIVATE" });
    await db.collection.create({ data: { slug: "birthdays", title: "Birthdays", createdById: otherId } });
    expect((await (await collections(req("/api/v1/collections", otherToken))).json()).collections.map((c: { title: string }) => c.title)).toEqual(["Birthdays", "Christmas mornings"]);
    expect((await newCollection(req("/api/v1/collections", token, { title: " " }))).status).toBe(400);
  });

  it("puts a member's own photographs on a trip, an activity or a collection, and leaves anybody else's", async () => {
    const tripId = (await db.trip.create({ data: { slug: "coast", title: "Coast", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: otherId } })).id;
    const activityId = (await db.activity.create({ data: { tripId, title: "Walk", startTime: new Date("2025-08-12T14:00:00Z"), endTime: new Date("2025-08-12T16:00:00Z") } })).id;
    const collectionId = (await db.collection.create({ data: { slug: "best", title: "Best", createdById: otherId } })).id;
    const mine = await photo(userId);
    const mineToo = await photo(userId);
    const theirs = await photo(otherId);
    const send = async (body: unknown, as = token) => {
      const res = await file(req("/api/v1/file", as, body));
      return { status: res.status, body: await res.json() };
    };

    expect(await send({ photoIds: [mine, theirs, mine], tripId })).toEqual({ status: 200, body: { filed: 1, notYours: 1 } });
    expect((await db.photo.findUniqueOrThrow({ where: { id: mine } })).tripId).toBe(tripId);
    expect((await db.photo.findUniqueOrThrow({ where: { id: theirs } })).tripId).toBeNull();

    expect(await send({ photoIds: [mineToo], activityId })).toEqual({ status: 200, body: { filed: 1, notYours: 0 } });
    expect(await db.photo.findUniqueOrThrow({ where: { id: mineToo } })).toMatchObject({ tripId, activityId, activitySetById: userId });

    expect(await send({ photoIds: [mine, mineToo, theirs], collectionId })).toEqual({ status: 200, body: { filed: 2, notYours: 1 } });
    expect(await send({ photoIds: [mine], collectionId })).toEqual({ status: 200, body: { filed: 1, notYours: 0 } });
    expect((await db.collectionItem.findMany({ where: { collectionId }, orderBy: { position: "asc" } })).map((i) => i.photoId)).toEqual([mine, mineToo]);
    // Nothing of the trip is undone by the collection.
    expect((await db.photo.findUniqueOrThrow({ where: { id: mineToo } })).activityId).toBe(activityId);

    expect((await send({ photoIds: [mine] })).status).toBe(400);
    expect((await send({ photoIds: [], tripId })).status).toBe(400);
    expect((await send({ photoIds: [mine], tripId: "nowhere" })).status).toBe(404);
    expect((await send({ photoIds: [mine], activityId: "nowhere" })).status).toBe(404);
    expect((await send({ photoIds: [mine], collectionId: "nowhere" })).status).toBe(404);
  });
});

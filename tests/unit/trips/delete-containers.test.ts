import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";
import { dbHooks } from "../helpers/hooked-db";

const who = vi.hoisted(() => ({ role: "MEMBER" as "MEMBER" | "ADMIN", id: "", queued: [] as string[] }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: null, role: who.role }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string) => void who.queued.push(queue) }));
vi.mock("@/lib/db", async () => (await import("../helpers/hooked-db")).hookedDb());

import { deleteTrip, rotateShareToken, updateTrip } from "@/app/trips/[slug]/actions";
import { bulkPutInActivity } from "@/app/photos/activity-actions";
import { bulkAssignActivity } from "@/app/photos/bulk-actions";
import { attachToActivity } from "@/app/photos/attach-actions";
import { reassignPhotosForActivity } from "@/lib/activities/reassign";
import { deleteCollection } from "@/app/collections/actions";
import { finishPendingTripDeletions } from "@/lib/trips/delete";
import { applyPhotoInstant } from "@/lib/photos/apply-date";
import { getTripBySlug, listVisibleTrips } from "@/lib/trips/queries";
import { getSharedTrip } from "@/lib/share/queries";
import { visibleMediaWhere } from "@/lib/auth/access";
import { requireTripEditor } from "@/lib/auth/ownership";
import type { Viewer } from "@/lib/auth/viewer";

/** The worker dying part-way: the `n`th batch never runs, nor anything after it. */
const dieAt = (n: number) => {
  let calls = 0;
  dbHooks.raw = async () => {
    if (++calls === n) throw new Error("the worker died");
  };
  return { mockRestore: () => void (dbHooks.raw = null) };
};

describe("deleting trips and collections", () => {
  let photoId: string;
  beforeEach(async () => {
    dbHooks.raw = dbHooks.transaction = dbHooks.model = null;
    who.queued = [];
    await resetTestDb();
    const user = await db.user.create({ data: { email: "x@example.com", role: "ADMIN" } });
    who.id = user.id;
    const trip = await db.trip.create({ data: { slug: "gone", title: "Gone", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } });
    const activity = await db.activity.create({ data: { tripId: trip.id, title: "Walk", type: "HIKE", startTime: new Date("2025-08-11T10:00:00Z"), endTime: new Date("2025-08-11T12:00:00Z") } });
    const collection = await db.collection.create({ data: { slug: "best", title: "Best", themeKey: "default", createdById: user.id } });
    photoId = (await db.photo.create({ data: { uploaderId: user.id, tripId: trip.id, activityId: activity.id, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "a", originalPath: "a/o.jpg", sizeBytes: 1, status: "READY" } })).id;
    await db.collectionItem.create({ data: { collectionId: collection.id, photoId, position: 0, addedById: user.id } });
  });
  it("a member may not delete either", async () => {
    who.role = "MEMBER";
    await expect(deleteTrip("gone")).rejects.toThrow(/admin/);
    await expect(deleteCollection("best")).rejects.toThrow(/admin/);
    expect(await db.trip.count()).toBe(1);
    expect(await db.collection.count()).toBe(1);
  });
  it("an admin deletes the trip and its activities, and the photos stay, unassigned", async () => {
    who.role = "ADMIN";
    await expect(deleteTrip("gone")).rejects.toThrow("REDIRECT:/photos");
    expect(await db.trip.count()).toBe(0);
    expect(await db.activity.count()).toBe(0);
    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect(p).toMatchObject({ tripId: null, activityId: null, status: "READY" });
  });
  it("takes back the positions the trip's tracks gave its photos, and keeps every other", async () => {
    who.role = "ADMIN";
    const trip = await db.trip.findUniqueOrThrow({ where: { slug: "gone" } });
    const mk = (name: string, data: Record<string, unknown>) => db.photo.create({ data: { uploaderId: who.id, tripId: trip.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", takenAt: new Date("2025-08-11T11:00:00Z"), ...data } });
    const fromTrack = await mk("t.jpg", { lat: 44.3, lng: -68.2, gpsSource: "TRACK" });
    const overGuess = await mk("g.jpg", { lat: 44.3, lng: -68.2, gpsSource: "TRACK", placeEstimateName: "Bar Harbor", placeEstimatedAt: new Date() });
    const ownGps = await mk("e.jpg", { lat: 44.4, lng: -68.1, gpsSource: "EXIF" });
    await expect(deleteTrip("gone")).rejects.toThrow("REDIRECT:/photos");
    expect(await db.photo.findUniqueOrThrow({ where: { id: fromTrack.id } })).toMatchObject({ lat: null, lng: null, gpsSource: null });
    expect(await db.photo.findUniqueOrThrow({ where: { id: overGuess.id } })).toMatchObject({ lat: null, gpsSource: null, placeEstimatedAt: null });
    expect(await db.photo.findUniqueOrThrow({ where: { id: ownGps.id } })).toMatchObject({ lat: 44.4, gpsSource: "EXIF" });
  });
  it("lets go of a trip of thousands of photographs, well past a transaction's default five seconds", async () => {
    who.role = "ADMIN";
    const trip = await db.trip.findUniqueOrThrow({ where: { slug: "gone" } });
    const activity = await db.activity.findFirstOrThrow({ where: { tripId: trip.id } });
    const N = 6000;
    const rows = Array.from({ length: N }, (_, i) => ({ uploaderId: who.id, tripId: trip.id, originalName: `${i}.jpg`, mimeType: "image/jpeg", storageKey: `k${i}`, originalPath: `k${i}/o.jpg`, sizeBytes: 1, status: "READY" as const, ...(i % 3 === 0 ? { lat: 44.3, lng: -68.2, gpsSource: "TRACK" as const } : {}), ...(i % 5 === 0 ? { activityId: activity.id, activitySetById: who.id } : {}) }));
    for (let i = 0; i < N; i += 1000) await db.photo.createMany({ data: rows.slice(i, i + 1000) });
    // Far too many for the admin's request: marked there, and left to the worker, with the Admin page to say so.
    await expect(deleteTrip("gone")).rejects.toThrow("REDIRECT:/admin#being-deleted");
    expect(who.queued).toEqual(["finish-removals"]);
    expect(await db.photo.count({ where: { tripId: trip.id } })).toBe(1 + N);
    expect(await finishPendingTripDeletions()).toBe(1);
    expect(await db.trip.count()).toBe(0);
    expect(await db.photo.count({ where: { OR: [{ tripId: { not: null } }, { activityId: { not: null } }, { activitySetById: { not: null } }, { gpsSource: "TRACK" }] } })).toBe(0);
    expect(await db.photo.count({ where: { lat: null } })).toBe(1 + N);
  }, 120_000);
  it("an admin deletes the collection and the photos stay on their trip", async () => {
    who.role = "ADMIN";
    await expect(deleteCollection("best")).rejects.toThrow("REDIRECT:/");
    expect(await db.collection.count()).toBe(0);
    expect(await db.collectionItem.count()).toBe(0);
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).tripId).not.toBeNull();
  });

  it("finishes a deletion interrupted half-way from its mark, and files nothing onto the trip meanwhile", async () => {
    who.role = "ADMIN";
    const trip = await db.trip.findUniqueOrThrow({ where: { slug: "gone" } });
    const rows = Array.from({ length: 1200 }, (_, i) => ({ uploaderId: who.id, tripId: trip.id, originalName: `${i}.jpg`, mimeType: "image/jpeg", storageKey: `k${i}`, originalPath: `k${i}/o.jpg`, sizeBytes: 1, status: "READY" as const, ...(i % 3 === 0 ? { lat: 44.3, lng: -68.2, gpsSource: "TRACK" as const } : {}) }));
    await db.photo.createMany({ data: rows });
    await expect(deleteTrip("gone")).rejects.toThrow("REDIRECT:/admin#being-deleted");
    const spy = dieAt(2);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await finishPendingTripDeletions()).toBe(0);
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/could not finish deleting/), "the worker died");
    logged.mockRestore();
    spy.mockRestore();
    // Decided and under way: marked, and one batch let go of.
    expect((await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).deletingAt).toBeInstanceOf(Date);
    const left = await db.photo.count({ where: { tripId: trip.id } });
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(1201);
    // A photograph dated inside it is not filed onto it any more.
    const dated = await db.photo.create({ data: { uploaderId: who.id, originalName: "d.jpg", mimeType: "image/jpeg", storageKey: "d", originalPath: "d/o.jpg", sizeBytes: 1, status: "READY" } });
    await applyPhotoInstant({ ...dated, activityId: null, activitySetById: null }, new Date("2025-08-12T12:00:00Z"), 0, "EXIF_OFFSET", null);
    expect((await db.photo.findUniqueOrThrow({ where: { id: dated.id } })).tripId).toBeNull();

    expect(await finishPendingTripDeletions()).toBe(1);
    expect(await db.trip.count()).toBe(0);
    expect(await db.activity.count()).toBe(0);
    expect(await db.photo.count({ where: { OR: [{ tripId: { not: null } }, { activityId: { not: null } }, { gpsSource: "TRACK" }] } })).toBe(0);
    expect(await db.photo.count()).toBe(1202);
    expect(await finishPendingTripDeletions()).toBe(0);
  }, 60_000);

  it("lets go of a photograph filed onto the trip while it was being deleted", async () => {
    who.role = "ADMIN";
    const trip = await db.trip.findUniqueOrThrow({ where: { slug: "gone" } });
    const activity = await db.activity.findFirstOrThrow({ where: { tripId: trip.id } });
    await db.photo.createMany({ data: Array.from({ length: 700 }, (_, i) => ({ uploaderId: who.id, tripId: trip.id, originalName: `${i}.jpg`, mimeType: "image/jpeg", storageKey: `k${i}`, originalPath: `k${i}/o.jpg`, sizeBytes: 1, status: "READY" as const })) });
    const late = await db.photo.create({ data: { uploaderId: who.id, originalName: "late.jpg", mimeType: "image/jpeg", storageKey: "late", originalPath: "late/o.jpg", sizeBytes: 1, status: "READY" } });
    await expect(deleteTrip("gone")).rejects.toThrow("REDIRECT:/admin#being-deleted");
    // Filed by hand onto the trip and its activity (a save already past its checks) once the batches have gone by.
    dbHooks.transaction = async () => {
      dbHooks.transaction = null;
      await db.photo.update({ where: { id: late.id }, data: { tripId: trip.id, activityId: activity.id, activitySetById: who.id } });
    };
    expect(await finishPendingTripDeletions()).toBe(1);
    expect(await db.trip.count()).toBe(0);
    expect(await db.photo.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({ tripId: null, activityId: null, activitySetById: null });
  }, 60_000);

  it("is gone for visitors and members the moment it is marked, whatever it was shared as", async () => {
    who.role = "ADMIN";
    const trip = await db.trip.update({ where: { slug: "gone" }, data: { visibility: "LINK", shareToken: "trip-link" } });
    await db.activity.updateMany({ where: { tripId: trip.id }, data: { shareToken: "walk-link" } });
    await db.photo.createMany({ data: Array.from({ length: 600 }, (_, i) => ({ uploaderId: who.id, tripId: trip.id, originalName: `${i}.jpg`, mimeType: "image/jpeg", storageKey: `k${i}`, originalPath: `k${i}/o.jpg`, sizeBytes: 1, status: "READY" as const })) });
    await db.trip.update({ where: { id: trip.id }, data: { visibility: "PUBLIC" } });
    const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map([[`trip_${trip.id}`, "trip-link"]]) };
    const member: Viewer = { kind: "user", user: { id: who.id, email: "x@example.com", name: null, role: "ADMIN" }, shareTokens: new Map() };
    expect(await db.photo.count({ where: { tripId: trip.id, ...visibleMediaWhere(anon) } })).toBe(601);

    await expect(deleteTrip("gone")).rejects.toThrow("REDIRECT:/admin#being-deleted");
    // Nothing of it has been let go of yet, and already nobody finds it.
    expect(await db.photo.count({ where: { tripId: trip.id } })).toBe(601);
    expect(await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).toMatchObject({ visibility: "PRIVATE", shareToken: null });
    expect(await db.activity.count({ where: { tripId: trip.id, shareToken: { not: null } } })).toBe(0);
    expect(await db.photo.count({ where: { tripId: trip.id, ...visibleMediaWhere(anon) } })).toBe(0);
    expect(await getTripBySlug("gone")).toBeNull();
    expect(await getSharedTrip("trip-link")).toBeNull();
    expect(await listVisibleTrips(anon)).toEqual([]);
    expect(await listVisibleTrips(member)).toEqual([]);
    // Nor can it be arranged, re-shared or filed onto.
    await expect(requireTripEditor("gone")).rejects.toThrow("Trip not found");
    expect(await finishPendingTripDeletions()).toBe(1);
  }, 60_000);

  it("finishes a small trip inside the request, and queues nothing", async () => {
    who.role = "ADMIN";
    await expect(deleteTrip("gone")).rejects.toThrow("REDIRECT:/photos");
    expect(await db.trip.count()).toBe(0);
    expect(who.queued).toEqual([]);
  });

  it("never shares again a trip marked for deletion while its settings were being saved", async () => {
    who.role = "ADMIN";
    const trip = await db.trip.update({ where: { slug: "gone" }, data: { visibility: "LINK", shareToken: "old-link" } });
    const mark = () => db.$executeRaw`UPDATE "Trip" SET "deletingAt" = now(), visibility = 'PRIVATE', "shareToken" = NULL WHERE id = ${trip.id}`;
    // Each save read the trip before the mark, and writes after it.
    const markBeforeWrite = (method: string) => {
      dbHooks.model = async (model, called) => {
        if (model !== "trip" || called !== method) return;
        dbHooks.model = null;
        await mark();
      };
    };
    const fd = new FormData();
    for (const [k, v] of Object.entries({ title: "Gone", startDate: "2025-08-10", endDate: "2025-08-16", timezone: "UTC", themeKey: "default", visibility: "PUBLIC" })) fd.set(k, v);
    markBeforeWrite("update");
    await expect(updateTrip("gone", { status: "idle" }, fd)).rejects.toThrow("Trip not found");
    expect(await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).toMatchObject({ visibility: "PRIVATE", shareToken: null });

    await db.trip.update({ where: { id: trip.id }, data: { deletingAt: null, visibility: "LINK", shareToken: "old-link" } });
    markBeforeWrite("update");
    await expect(rotateShareToken("gone")).rejects.toThrow("Trip not found");
    expect(await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).toMatchObject({ shareToken: null });
    // And a trip that somehow kept a token while marked is still not shared by it.
    await db.trip.update({ where: { id: trip.id }, data: { visibility: "LINK", shareToken: "kept" } });
    expect(await getSharedTrip("kept")).toBeNull();
  });

  it("files nothing onto an activity of a trip being deleted", async () => {
    who.role = "ADMIN";
    const trip = await db.trip.findUniqueOrThrow({ where: { slug: "gone" } });
    const activity = await db.activity.findFirstOrThrow({ where: { tripId: trip.id } });
    const loose = await db.photo.create({ data: { uploaderId: who.id, originalName: "l.jpg", mimeType: "image/jpeg", storageKey: "l", originalPath: "l/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date("2025-08-11T11:00:00Z"), takenAtSource: "EXIF_OFFSET" } });
    const onTrip = await db.photo.create({ data: { uploaderId: who.id, tripId: trip.id, originalName: "t.jpg", mimeType: "image/jpeg", storageKey: "t", originalPath: "t/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date("2025-08-11T11:00:00Z"), takenAtSource: "EXIF_OFFSET" } });
    await db.trip.update({ where: { id: trip.id }, data: { deletingAt: new Date() } });
    expect(await bulkPutInActivity([loose.id], activity.id)).toMatchObject({ n: 0 });
    await bulkAssignActivity([onTrip.id], activity.id);
    await expect(attachToActivity(activity.id, [loose.id])).rejects.toThrow("Activity not found");
    await reassignPhotosForActivity(activity.id);
    expect(await db.photo.count({ where: { id: { in: [loose.id, onTrip.id] }, activityId: { not: null } } })).toBe(0);
    expect((await db.photo.findUniqueOrThrow({ where: { id: loose.id } })).tripId).toBeNull();
  });
});

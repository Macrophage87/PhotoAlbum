import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ role: "MEMBER" as "MEMBER" | "ADMIN", id: "" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: null, role: who.role }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { deleteTrip } from "@/app/trips/[slug]/actions";
import { deleteCollection } from "@/app/collections/actions";

describe("deleting trips and collections", () => {
  let photoId: string;
  beforeEach(async () => {
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
    await expect(deleteTrip("gone")).rejects.toThrow("REDIRECT:/photos");
    expect(await db.trip.count()).toBe(0);
    expect(await db.photo.count({ where: { OR: [{ tripId: { not: null } }, { activityId: { not: null } }, { activitySetById: { not: null } }, { gpsSource: "TRACK" }] } })).toBe(0);
    expect(await db.photo.count({ where: { lat: null } })).toBe(1 + N);
  }, 120_000);
  it("an admin deletes the collection and the photos stay on their trip", async () => {
    who.role = "ADMIN";
    const before = (await db.photo.findUniqueOrThrow({ where: { id: photoId } })).imageVersion;
    await expect(deleteCollection("best")).rejects.toThrow("REDIRECT:/");
    expect(await db.collection.count()).toBe(0);
    expect(await db.collectionItem.count()).toBe(0);
    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect(p.tripId).not.toBeNull();
    // Who may fetch it changed with the collection: its addresses move (the hashing review).
    expect(p.imageVersion).toBeGreaterThan(before);
  });
});

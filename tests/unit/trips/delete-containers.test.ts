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
  it("an admin deletes the collection and the photos stay on their trip", async () => {
    who.role = "ADMIN";
    await expect(deleteCollection("best")).rejects.toThrow("REDIRECT:/");
    expect(await db.collection.count()).toBe(0);
    expect(await db.collectionItem.count()).toBe(0);
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).tripId).not.toBeNull();
  });
});

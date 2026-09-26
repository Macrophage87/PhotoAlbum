import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "me@example.com", name: null, role: "ADMIN" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { setCollectionCover } from "@/app/collections/actions";
import { setCoverPhoto } from "@/app/trips/[slug]/actions";
import { setActivityCover } from "@/app/trips/[slug]/activities/actions";
import { setAsCover } from "@/app/photos/[id]/actions";
import { chosenTripCover, coverFor } from "@/lib/trips/queries";
import { chosenCollectionCover, collectionCoverFor } from "@/lib/collections/queries";
import { coverPhotoSelect } from "@/lib/photos/cover";
import { activityCover, activityCoverCandidates } from "@/lib/activities/cover";
import { collectionCoverCandidates, tripCoverCandidates } from "@/lib/covers/candidates";

/**
 * A cover is chosen once and read everywhere, so what is chosen has to be a picture, and what is read has to be one
 * that still stands: finished, out of the trash, and (for a trip) still on it. And one picture may lead more than one
 * thing, since it may sit in more than one collection.
 */
describe("covers that stand", () => {
  let acadia: string, zion: string, activity: string, best: string, christmas: string;
  let ready: string, other: string, working: string;

  const photo = (name: string, tripId: string | null, status: "READY" | "PROCESSING" | "FAILED", hour: number, activityId?: string) =>
    db.photo.create({ data: { tripId, activityId, uploaderId: who.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status, width: status === "READY" ? 1200 : null, takenAt: new Date(Date.UTC(2025, 7, 12, hour)) } });
  const trip = (id: string) => db.trip.findUniqueOrThrow({ where: { id }, include: { coverPhoto: coverPhotoSelect } });
  const collection = (id: string) => db.collection.findUniqueOrThrow({ where: { id }, include: { coverPhoto: coverPhotoSelect } });

  beforeEach(async () => {
    await resetTestDb();
    who.id = (await db.user.create({ data: { email: "me@example.com", role: "ADMIN" } })).id;
    const mk = (slug: string) => db.trip.create({ data: { slug, title: slug, startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: who.id } });
    acadia = (await mk("acadia")).id;
    zion = (await mk("zion")).id;
    activity = (await db.activity.create({ data: { tripId: acadia, title: "Walk", type: "HIKE", startTime: new Date("2025-08-12T08:00:00Z"), endTime: new Date("2025-08-12T18:00:00Z") } })).id;
    best = (await db.collection.create({ data: { slug: "best", title: "Best of", createdById: who.id } })).id;
    christmas = (await db.collection.create({ data: { slug: "christmas", title: "Christmas mornings", createdById: who.id } })).id;
    other = (await photo("early.jpg", acadia, "READY", 8, activity)).id;
    ready = (await photo("chosen.jpg", acadia, "READY", 12, activity)).id;
    working = (await photo("working.jpg", acadia, "PROCESSING", 9, activity)).id;
    for (const [collectionId, position] of [[best, 0], [christmas, 0]] as const) {
      await db.collectionItem.createMany({ data: [ready, other, working].map((photoId, i) => ({ collectionId, photoId, addedById: who.id, position: position + i })) });
    }
  });

  it("lets one photograph lead two collections it sits in", async () => {
    await setCollectionCover("christmas", ready);
    await setCollectionCover("best", ready);
    expect((await collectionCoverFor(await collection(christmas)))?.id).toBe(ready);
    expect((await collectionCoverFor(await collection(best)))?.id).toBe(ready);
  });

  it("stops leading a trip with a photograph moved off it, and lets the trip it went to choose it", async () => {
    await setCoverPhoto("acadia", ready);
    // Moved from the photograph's own page, a bulk move or filing: none of them touches the old trip's cover.
    await db.photo.update({ where: { id: ready }, data: { tripId: zion, activityId: null } });
    expect(chosenTripCover(await trip(acadia))).toBeNull();
    expect((await coverFor(await trip(acadia)))?.id).toBe(other);
    await setCoverPhoto("zion", ready);
    expect((await coverFor(await trip(zion)))?.id).toBe(ready);
    // From the photograph's page as well.
    await db.trip.update({ where: { id: zion }, data: { coverPhotoId: null } });
    await setAsCover(ready);
    expect((await coverFor(await trip(zion)))?.id).toBe(ready);
  });

  it("refuses a photograph still processing, or one that failed, as any kind of cover", async () => {
    await expect(setCollectionCover("best", working)).rejects.toThrow(/finished/);
    await expect(setCoverPhoto("acadia", working)).rejects.toThrow(/finished/);
    await expect(setActivityCover("acadia", activity, working)).rejects.toThrow(/finished/);
    await expect(setAsCover(working)).rejects.toThrow(/finished/);
    await db.photo.update({ where: { id: working }, data: { status: "FAILED" } });
    await expect(setCoverPhoto("acadia", working)).rejects.toThrow(/finished/);
    expect((await db.trip.findUniqueOrThrow({ where: { id: acadia } })).coverPhotoId).toBeNull();
    expect((await db.collection.findUniqueOrThrow({ where: { id: best } })).coverPhotoId).toBeNull();
  });

  it("does not lead with one chosen earlier that is no longer finished", async () => {
    // Chosen before the checks existed, or reprocessed since and failed.
    await db.trip.update({ where: { id: acadia }, data: { coverPhotoId: working } });
    await db.collection.update({ where: { id: best }, data: { coverPhotoId: working } });
    expect((await coverFor(await trip(acadia)))?.id).toBe(other);
    expect((await collectionCoverFor(await collection(best)))?.id).toBe(ready);
  });

  it("does not call a trashed cover chosen by hand", async () => {
    await setCollectionCover("best", ready);
    await setCoverPhoto("acadia", ready);
    await db.photo.update({ where: { id: ready }, data: { trashedAt: new Date(), trashedById: who.id, trashReason: "DUPLICATE" } });
    // What the cover and settings pages ask to say "chosen by hand".
    expect(await chosenCollectionCover(await collection(best))).toBeNull();
    expect(chosenTripCover(await trip(acadia))).toBeNull();
    // Restored, it is the cover again, as it was.
    await db.photo.update({ where: { id: ready }, data: { trashedAt: null } });
    expect((await chosenCollectionCover(await collection(best)))?.id).toBe(ready);
    expect(chosenTripCover(await trip(acadia))?.id).toBe(ready);
  });

  it("refuses a trashed photograph as a cover", async () => {
    await db.photo.update({ where: { id: ready }, data: { trashedAt: new Date(), trashedById: who.id, trashReason: "DUPLICATE" } });
    await expect(setCollectionCover("best", ready)).rejects.toThrow(/finished/);
    await expect(setCoverPhoto("acadia", ready)).rejects.toThrow(/finished/);
    await expect(setActivityCover("acadia", activity, ready)).rejects.toThrow(/finished/);
    await expect(setAsCover(ready)).rejects.toThrow(/finished/);
  });

  it("never leads with, offers or accepts a finished item that has no pictures, such as an unopened 3D scan", async () => {
    const scan = (await db.photo.create({ data: { tripId: acadia, activityId: activity, uploaderId: who.id, kind: "SCAN", originalName: "room.glb", mimeType: "model/gltf-binary", storageKey: "scan", originalPath: "scan/o.glb", sizeBytes: 1, status: "READY", takenAt: new Date(Date.UTC(2025, 7, 12, 1)) } })).id;
    await db.collectionItem.create({ data: { collectionId: best, photoId: scan, addedById: who.id, position: -1 } });
    await expect(setCoverPhoto("acadia", scan)).rejects.toThrow(/finished/);
    await expect(setCollectionCover("best", scan)).rejects.toThrow(/finished/);
    await expect(setActivityCover("acadia", activity, scan)).rejects.toThrow(/finished/);
    // Earliest on the trip and first in the collection, and still not what the album leads with by itself.
    expect((await coverFor(await trip(acadia)))?.id).toBe(other);
    expect((await collectionCoverFor(await collection(best)))?.id).toBe(ready);
    expect((await activityCover({ id: activity, coverPhotoId: null }))?.id).toBe(other);
    expect((await tripCoverCandidates(acadia)).photos.map((p) => p.id)).not.toContain(scan);
    expect((await collectionCoverCandidates(best)).photos.map((p) => p.id)).not.toContain(scan);
    expect((await activityCoverCandidates(activity)).photos.map((p) => p.id)).not.toContain(scan);
    // Chosen before this was checked: not honoured.
    await db.trip.update({ where: { id: acadia }, data: { coverPhotoId: scan } });
    expect(chosenTripCover(await trip(acadia))).toBeNull();
  });

  it("goes on leading with a cover while it is processed again, and after a re-process fails", async () => {
    await db.photo.update({ where: { id: ready }, data: { width: 4000, height: 3000 } });
    await setCoverPhoto("acadia", ready);
    await setCollectionCover("best", ready);
    await setActivityCover("acadia", activity, ready);
    for (const status of ["PENDING", "PROCESSING", "FAILED"] as const) {
      await db.photo.update({ where: { id: ready }, data: { status } });
      expect((await coverFor(await trip(acadia)))?.id).toBe(ready);
      expect((await collectionCoverFor(await collection(best)))?.id).toBe(ready);
      expect((await activityCover({ id: activity, coverPhotoId: ready }))?.id).toBe(ready);
    }
  });

  it("stops leading a collection with a photograph no longer in it", async () => {
    await setCollectionCover("best", ready);
    // Taken out some way that does not tidy the cover up after it.
    await db.collectionItem.deleteMany({ where: { collectionId: best, photoId: ready } });
    expect(await chosenCollectionCover(await collection(best))).toBeNull();
    expect((await collectionCoverFor(await collection(best)))?.id).toBe(other);
  });

  it("leaves an activity a photograph was moved from alone when it is chosen for another", async () => {
    const later = (await db.activity.create({ data: { tripId: acadia, title: "Swim", type: "OTHER", startTime: new Date("2025-08-13T08:00:00Z"), endTime: new Date("2025-08-13T18:00:00Z") } })).id;
    await setActivityCover("acadia", activity, ready);
    await db.photo.update({ where: { id: ready }, data: { activityId: later } });
    await setActivityCover("acadia", later, ready);
    expect((await activityCover({ id: later, coverPhotoId: ready }))?.id).toBe(ready);
    // The walk still names it, but it is not the walk's any more, so the walk leads with its own first photograph.
    const walk = await db.activity.findUniqueOrThrow({ where: { id: activity } });
    expect(walk.coverPhotoId).toBe(ready);
    expect((await activityCover(walk))?.id).toBe(other);
  });
});

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
import { collectionCoverFor } from "@/lib/collections/queries";
import { coverPhotoSelect, standingCover } from "@/lib/photos/cover";

/**
 * A cover is chosen once and read everywhere, so what is chosen has to be a picture, and what is read has to be one
 * that still stands: finished, out of the trash, and (for a trip) still on it. And one picture may lead more than one
 * thing, since it may sit in more than one collection.
 */
describe("covers that stand", () => {
  let acadia: string, zion: string, activity: string, best: string, christmas: string;
  let ready: string, other: string, working: string;

  const photo = (name: string, tripId: string | null, status: "READY" | "PROCESSING" | "FAILED", hour: number, activityId?: string) =>
    db.photo.create({ data: { tripId, activityId, uploaderId: who.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status, takenAt: new Date(Date.UTC(2025, 7, 12, hour)) } });
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
    expect(standingCover((await collection(best)).coverPhoto)).toBeNull();
    expect(chosenTripCover(await trip(acadia))).toBeNull();
    // Restored, it is the cover again, as it was.
    await db.photo.update({ where: { id: ready }, data: { trashedAt: null } });
    expect(standingCover((await collection(best)).coverPhoto)?.id).toBe(ready);
    expect(chosenTripCover(await trip(acadia))?.id).toBe(ready);
  });
});

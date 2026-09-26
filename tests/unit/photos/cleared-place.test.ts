import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { encodePoints } from "@/lib/tracks/encode";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "cleared-place-"));
process.env.PHOTO_STORAGE_ROOT = photoRoot;
const who = vi.hoisted(() => ({ id: "" }));
const enqueued = vi.hoisted(() => [] as { queue: string; data: unknown }[]);
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "me@example.com", name: "Nana", role: "MEMBER" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown) => { enqueued.push({ queue, data }); } }));

import { clearPhotoPlace } from "@/app/photos/[id]/actions";
import { placePhotos, restorePlaces } from "@/app/photos/bulk-actions";
import { geotagPhotos } from "@/lib/jobs/handlers/geotag-photos";
import { processPhoto } from "@/lib/jobs/handlers/process-photo";
import { applyPlaceEstimate, needsPlaceEstimate } from "@/lib/annotation/place";
import { pendingWhere } from "@/lib/jobs/handlers/annotation-batch";
import { planSidecarRepair } from "@/lib/takeout/repair";

const T0 = Date.parse("2025-08-12T13:00:00Z");

/** A place a member removed stays removed, whatever runs afterwards (#72). */
describe("a place cleared by hand", () => {
  let tripId: string, photoId: string;
  beforeEach(async () => {
    await resetTestDb();
    enqueued.length = 0;
    who.id = (await db.user.create({ data: { email: "me@example.com", name: "Nana" } })).id;
    tripId = (await db.trip.create({ data: { slug: "home", title: "Home", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: who.id, visibility: "PUBLIC" } })).id;
    // A track covering the moment, so geotagging could place it if it were allowed to.
    const points = Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * 60_000, lat: 44 + i * 0.001, lng: -68, ele: 100 }));
    const { blob, startTime, endTime } = encodePoints(points);
    await db.track.create({ data: { tripId, uploaderId: who.id, source: "GPX", name: "walk", startTime, endTime, pointCount: 10, minLat: 44, maxLat: 45, minLng: -68, maxLng: -68, simplified: [], pointsBlob: new Uint8Array(blob) } });
    const photo = await db.photo.create({ data: { tripId, uploaderId: who.id, originalName: "photo-with-gps.jpg", mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 1, status: "READY", takenAt: new Date(T0 + 4.5 * 60_000), takenAtSource: "EXIF_OFFSET", tzOffsetMin: 0, lat: 39.4, lng: -76.6, gpsSource: "EXIF" } });
    photoId = photo.id;
    const key = `photos/${photoId}`;
    mkdirSync(path.join(photoRoot, key), { recursive: true });
    copyFileSync(path.join(process.cwd(), "tests/fixtures/photo-with-gps.jpg"), path.join(photoRoot, key, "original.jpg"));
    await db.photo.update({ where: { id: photoId }, data: { storageKey: key, originalPath: `${key}/original.jpg` } });
  });
  const row = () => db.photo.findUniqueOrThrow({ where: { id: photoId } });

  it("records who removed it, says so, and asks no geotag to fill the gap", async () => {
    expect(await clearPhotoPlace(photoId)).toMatchObject({ ok: true, lat: null, setBy: "Nana" });
    expect(await row()).toMatchObject({ lat: null, gpsSource: null, placeSetById: who.id });
    expect(enqueued.filter((e) => e.queue === "geotag-photos")).toEqual([]);
  });

  it("is not placed again by a track, the helper, a Takeout repair or a re-process", async () => {
    await clearPhotoPlace(photoId);
    expect((await geotagPhotos({ tripId })).updated).toBe(0);
    const p = await row();
    expect(needsPlaceEstimate(p)).toBe(false);
    expect(await db.photo.count({ where: { id: photoId, ...pendingWhere("place") } })).toBe(0);
    expect(await applyPlaceEstimate(photoId, { name: "Towson, Maryland", precision: "city", lat: 39.4, lng: -76.6, radiusM: 5000, confidence: 0.9, evidence: "the street signs" })).toBe("skipped");
    expect(planSidecarRepair(p, { title: null, description: null, takenAt: null, lat: 39.4, lng: -76.6, googleId: null })).toBeNull();
    await processPhoto({ photoId });
    expect(await row()).toMatchObject({ status: "READY", lat: null, lng: null, gpsSource: null, placeSetById: who.id });
  });

  it("comes back removed, not merely empty, when a move on the map is undone", async () => {
    await clearPhotoPlace(photoId);
    const { before, undo } = await placePhotos([photoId], 10, 20);
    expect(before[0]).toMatchObject({ lat: null, removedByHand: true });
    await restorePlaces(before, undo);
    expect(await row()).toMatchObject({ lat: null, gpsSource: null, placeSetById: who.id });
    // An ordinary position is restored as nobody's choice.
    await restorePlaces([{ id: photoId, lat: 1, lng: 2, gpsSource: "EXIF", placeName: null, removedByHand: false }]);
    expect(await row()).toMatchObject({ lat: 1, gpsSource: "EXIF", placeSetById: null });
  });

  it("puts back who set the place from the server's note, never from the browser", async () => {
    const aunt = (await db.user.create({ data: { email: "aunt@example.com" } })).id;
    const cousin = (await db.user.create({ data: { email: "cousin@example.com" } })).id;
    await db.photo.update({ where: { id: photoId }, data: { lat: 5, lng: 6, gpsSource: "MANUAL", placeSetById: aunt } });
    const { before, undo } = await placePhotos([photoId], 10, 20);
    // The browser cannot name somebody else: the entry carries no setter at all, and a forged one is ignored.
    await restorePlaces([{ ...before[0], placeSetById: cousin } as never], undo);
    expect(await row()).toMatchObject({ lat: 5, gpsSource: "MANUAL", placeSetById: aunt });
    // Without the server's note (a restart), the member pressing Undo is recorded.
    const again = await placePhotos([photoId], 10, 20);
    await restorePlaces(again.before, "no-such-token");
    expect((await row()).placeSetById).toBe(who.id);
  });
});

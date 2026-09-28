import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

/**
 * Something a member does between the moment `applyPlaceEstimate` reads the item and the moment it writes the guess.
 * The judgement of the guess's words sits exactly there, so it stands in for "meanwhile".
 */
const meanwhile = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock("@/lib/annotation/members-only", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/annotation/members-only")>();
  return {
    ...real,
    placeFromMembersOnly: async (...args: Parameters<typeof real.placeFromMembersOnly>) => {
      const run = meanwhile.run;
      meanwhile.run = null;
      if (run) await run();
      return real.placeFromMembersOnly(...args);
    },
  };
});

import { applyPlaceEstimate } from "@/lib/annotation/place";

const vatican = { name: "St Peter's Square, Vatican City", precision: "exact" as const, lat: 41.9022, lng: 12.4568, radiusM: 200, confidence: 0.82, evidence: "the colonnade and the obelisk" };

/** A place a member cleared or set by hand while the guess was on its way is never covered by the guess. */
describe("a guess that arrives after a member chose the place", () => {
  let photoId: string, memberId: string;
  const photo = () => db.photo.findUniqueOrThrow({ where: { id: photoId } });
  beforeEach(async () => {
    await resetTestDb();
    meanwhile.run = null;
    memberId = (await db.user.create({ data: { email: "a@example.com" } })).id;
    photoId = (await db.photo.create({ data: { uploaderId: memberId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" } })).id;
  });

  it("places the item when nothing happened in between", async () => {
    expect(await applyPlaceEstimate(photoId, vatican)).toBe("placed");
    expect(await photo()).toMatchObject({ lat: vatican.lat, gpsSource: "ESTIMATE", placeEstimateName: vatican.name });
  });

  it("leaves a place cleared by hand cleared, and records that it was asked", async () => {
    // What `clearPhotoPlace` writes: no position, and who took it away.
    meanwhile.run = async () => void (await db.photo.update({ where: { id: photoId }, data: { lat: null, lng: null, gpsSource: null, placeSetById: memberId } }));
    expect(await applyPlaceEstimate(photoId, vatican)).toBe("skipped");
    const p = await photo();
    expect(p).toMatchObject({ lat: null, lng: null, gpsSource: null, placeSetById: memberId, placeEstimateName: null, placeEstimateNote: null });
    expect(p.placeEstimatedAt).not.toBeNull();
  });

  it("leaves a place set by hand where the member put it", async () => {
    meanwhile.run = async () => void (await db.photo.update({ where: { id: photoId }, data: { lat: 44.35, lng: -68.2, gpsSource: "MANUAL", placeSetById: memberId } }));
    expect(await applyPlaceEstimate(photoId, vatican)).toBe("skipped");
    expect(await photo()).toMatchObject({ lat: 44.35, lng: -68.2, gpsSource: "MANUAL", placeSetById: memberId, placeEstimateName: null });
  });

  it("leaves a position from a track alone", async () => {
    meanwhile.run = async () => void (await db.photo.update({ where: { id: photoId }, data: { lat: 44.35, lng: -68.2, gpsSource: "TRACK" } }));
    expect(await applyPlaceEstimate(photoId, vatican)).toBe("skipped");
    expect(await photo()).toMatchObject({ lat: 44.35, gpsSource: "TRACK", placeEstimateName: null });
  });

  it("still calls the answer stale when names changed as well, and writes nothing", async () => {
    const requestedAt = new Date(Date.now() - 60_000);
    meanwhile.run = async () => void (await db.photo.update({ where: { id: photoId }, data: { lat: null, gpsSource: null, placeSetById: memberId, namesScrubbedAt: new Date() } }));
    expect(await applyPlaceEstimate(photoId, vatican, { requestedAt })).toBe("stale");
    const p = await photo();
    expect(p).toMatchObject({ lat: null, placeSetById: memberId, placeEstimateName: null, placeEstimatedAt: null });
  });
});

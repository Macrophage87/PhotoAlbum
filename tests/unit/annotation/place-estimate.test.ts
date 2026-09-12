import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { applyPlaceEstimate, clampPlace, MIN_PLACE_CONFIDENCE, needsPlaceEstimate, parsePlaceContent, PLACE_ONLY_INSTRUCTIONS, placeEstimateSchema, recordPlaceFailure } from "@/lib/annotation/place";
import { describePlaceItem } from "@/lib/annotation/request";
import { pendingWhere, taskOf } from "@/lib/jobs/handlers/annotation-batch";
import { withinLabel } from "@/components/photos/PlaceEditor";
import { resetTestDb } from "../helpers/reset";

const vatican = { name: "St Peter's Square, Vatican City", lat: 41.9022, lng: 12.4568, radiusM: 200, confidence: 0.82, evidence: "the colonnade and the obelisk" };

describe("what the helper is asked for", () => {
  it("tells it to place public landmarks and to leave homes alone", () => {
    expect(PLACE_ONLY_INSTRUCTIONS).toContain("landmark or monument");
    expect(PLACE_ONLY_INSTRUCTIONS).toContain("Never estimate a private place");
    expect(PLACE_ONLY_INSTRUCTIONS).toContain("house number");
    // Above the 512-token cache minimum on Opus 5, so the block is paid for once per batch rather than per item.
    expect(PLACE_ONLY_INSTRUCTIONS.length).toBeGreaterThan(2048);
  });
  it("asks only about items with no position that nobody has asked about yet", () => {
    expect(needsPlaceEstimate({ lat: null, placeEstimatedAt: null })).toBe(true);
    expect(needsPlaceEstimate({ lat: 44.3, placeEstimatedAt: null })).toBe(false);
    expect(needsPlaceEstimate({ lat: null, placeEstimatedAt: new Date() })).toBe(false);
  });
  it("sends the family's own words and never mentions people", () => {
    const text = describePlaceItem({ kind: "PHOTO", context: "the vatican with Nana", caption: null, title: null, takenAt: null, trip: { title: "Rome", timezone: "Europe/Rome" }, collections: [] } as unknown as Parameters<typeof describePlaceItem>[0]);
    expect(text).toContain("the vatican with Nana");
    expect(text).toContain("Trip: Rome");
    expect(text).toContain("no location recorded");
    expect(text).not.toContain("names you may use");
  });
  it("reads a batch answer, and tells unusable output apart from an honest blank", () => {
    expect(parsePlaceContent([{ type: "text", text: JSON.stringify({ place: vatican }) }])?.name).toBe(vatican.name);
    expect(parsePlaceContent([{ type: "text", text: JSON.stringify({ place: null }) }])).toBeNull();
    expect(parsePlaceContent([{ type: "text", text: "not json" }])).toBeUndefined();
    expect(parsePlaceContent([{ type: "text", text: JSON.stringify({ place: { name: "x" } }) }])).toBeUndefined();
  });
  it("keeps a slightly over-long answer instead of throwing it away", () => {
    const raw = clampPlace({ place: { ...vatican, name: "x".repeat(300), evidence: "e".repeat(400), radiusM: 12 } }) as { place: Record<string, unknown> };
    expect((raw.place.name as string).length).toBe(120);
    expect((raw.place.evidence as string).length).toBe(300);
    expect(raw.place.radiusM).toBe(50);
    expect(placeEstimateSchema.safeParse(raw.place).success).toBe(true);
  });
  it("puts the radius in words a family reads", () => {
    expect(withinLabel(200)).toBe("within about 200 m");
    expect(withinLabel(2000)).toBe("within about 2 km");
    expect(withinLabel(60_000)).toBe("somewhere within about 60 km");
    expect(withinLabel(null)).toBe("");
  });
});

describe("what a backfill run has left to do", () => {
  it("asks for descriptions by default and places only when told to", () => {
    expect(taskOf({ kind: "all" })).toBe("describe");
    expect(taskOf({ kind: "all", task: "place" })).toBe("place");
    expect(pendingWhere("describe")).toEqual({ annotatedAt: null });
    expect(pendingWhere("place")).toEqual({ lat: null, placeEstimatedAt: null });
  });
});

describe("recording a guess", () => {
  let photoId: string;
  const photo = () => db.photo.findUniqueOrThrow({ where: { id: photoId } });
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "a@example.com" } });
    photoId = (await db.photo.create({ data: { uploaderId: user.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" } })).id;
  });

  it("places an item that has no position, and says what it recognised", async () => {
    expect(await applyPlaceEstimate(photoId, vatican)).toBe("placed");
    const p = await photo();
    expect([p.lat, p.lng]).toEqual([vatican.lat, vatican.lng]);
    expect(p.gpsSource).toBe("ESTIMATE");
    expect(p.placeEstimateName).toBe(vatican.name);
    expect(p.placeEstimateRadiusM).toBe(200);
    expect(p.placeEstimateNote).toBe(vatican.evidence);
    expect(p.placeEstimatedAt).not.toBeNull();
  });

  it("throws away a guess it is not sure enough of, and does not ask again", async () => {
    expect(await applyPlaceEstimate(photoId, { ...vatican, confidence: MIN_PLACE_CONFIDENCE - 0.01 })).toBe("declined");
    const p = await photo();
    expect(p.lat).toBeNull();
    expect(p.placeEstimateName).toBeNull();
    expect(p.placeEstimatedAt).not.toBeNull();
    expect(needsPlaceEstimate(p)).toBe(false);
  });

  it("records a blank answer without placing anything", async () => {
    expect(await applyPlaceEstimate(photoId, null)).toBe("declined");
    expect((await photo()).lat).toBeNull();
  });

  for (const source of ["EXIF", "TRACK", "MANUAL", "SIDECAR"] as const) {
    it(`never moves an item positioned ${source}`, async () => {
      await db.photo.update({ where: { id: photoId }, data: { lat: 44.35, lng: -68.2, gpsSource: source } });
      expect(await applyPlaceEstimate(photoId, vatican)).toBe("skipped");
      const p = await photo();
      expect([p.lat, p.gpsSource]).toEqual([44.35, source]);
      expect(p.placeEstimateName).toBeNull();
    });
  }

  it("leaves a failed run's item alone unless the failure was final", async () => {
    await recordPlaceFailure(photoId, { terminal: false });
    expect((await photo()).placeEstimatedAt).toBeNull();
    await recordPlaceFailure(photoId, { terminal: true });
    const p = await photo();
    expect(p.placeEstimatedAt).not.toBeNull();
    expect(p.annotatedAt).toBeNull();
    expect(p.annotationError).toBeNull();
  });
});

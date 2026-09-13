import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { buildCollectionMapPayload, buildMapPayload } from "@/lib/map/geojson";
import { JITTER_STEP_M, spreadOverlapping } from "@/lib/map/jitter";
import { haversine } from "@/lib/geo/haversine";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

const member: Viewer = { kind: "user", user: { id: "u", email: "m@example.com", name: null, role: "MEMBER" }, shareTokens: new Map() };
const stranger: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };

describe("pins on the same spot", () => {
  const at = (id: string, lat: number, lng: number) => ({ id, lat, lng });

  it("leaves a spot with one photo exactly where it is", () => {
    const one = [at("a", 44.35, -68.2), at("b", 44.4, -68.3)];
    expect(spreadOverlapping(one)).toEqual(one);
  });

  it("fans a stack out far enough to click, close enough to still read as one place", () => {
    const stack = Array.from({ length: 6 }, (_, i) => at(`p${i}`, 39.4015, -76.6019));
    const spread = spreadOverlapping(stack);
    // The first keeps the true position; the others move, and no two land on each other.
    expect(spread[0]).toEqual(stack[0]);
    const seen = new Set(spread.map((p) => `${p.lat},${p.lng}`));
    expect(seen.size).toBe(6);
    for (const p of spread) {
      const m = haversine(39.4015, -76.6019, p.lat, p.lng);
      expect(m).toBeLessThan(JITTER_STEP_M * 4);
    }
    // Spreading twice gives the same answer, so a pin does not wander between page loads.
    expect(spreadOverlapping(stack)).toEqual(spread);
    // …whatever order they arrive in.
    expect(spreadOverlapping([...stack].reverse()).find((p) => p.id === "p3")).toEqual(spread.find((p) => p.id === "p3"));
  });

  it("keeps photos at different spots apart from each other's stacks", () => {
    const mixed = [at("a", 10, 10), at("b", 10, 10), at("c", 20, 20)];
    const spread = spreadOverlapping(mixed);
    expect(spread.find((p) => p.id === "c")).toEqual(at("c", 20, 20));
  });

  it("does not divide by nothing at the poles", () => {
    const polar = [at("a", 89.999, 0), at("b", 89.999, 0)];
    for (const p of spreadOverlapping(polar)) {
      expect(Number.isFinite(p.lat)).toBe(true);
      expect(Number.isFinite(p.lng)).toBe(true);
    }
  });
});

describe("the map across everything", () => {
  let onTrip: string, noTrip: string, collectionOnly: string, collectionId: string;
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "m@example.com", role: "ADMIN" } });
    const trip = await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id, visibility: "PRIVATE" } });
    const base = { uploaderId: user.id, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const, gpsSource: "EXIF" as const };
    onTrip = (await db.photo.create({ data: { ...base, tripId: trip.id, originalName: "trip.jpg", lat: 44.35, lng: -68.2 } })).id;
    noTrip = (await db.photo.create({ data: { ...base, originalName: "loose.jpg", lat: 41.9, lng: 12.45 } })).id;
    collectionOnly = (await db.photo.create({ data: { ...base, originalName: "collected.jpg", lat: 39.28, lng: -76.61 } })).id;
    const collection = await db.collection.create({ data: { slug: "c", title: "C", createdById: user.id, visibility: "PUBLIC" } });
    collectionId = collection.id;
    await db.collectionItem.create({ data: { collectionId, photoId: collectionOnly, addedById: user.id } });
  });

  it("shows a member every placed photo, including ones on no trip at all", async () => {
    const ids = (await buildMapPayload(member)).photos.features.map((f) => f.properties.id);
    expect(ids.sort()).toEqual([onTrip, noTrip, collectionOnly].sort());
  });

  it("still bounds the map around photos that belong to no trip", async () => {
    const payload = await buildMapPayload(member);
    expect(payload.bounds).not.toBeNull();
    const [[minLng], [maxLng]] = payload.bounds!;
    expect(minLng).toBeLessThanOrEqual(-76.61);
    expect(maxLng).toBeGreaterThanOrEqual(12.45);
  });

  it("shows a visitor what a public collection holds, without naming the private trip", async () => {
    const features = (await buildMapPayload(stranger)).photos.features;
    expect(features.map((f) => f.properties.id)).toEqual([collectionOnly]);
    expect(features[0].properties.tripSlug).toBe("");
  });

  it("keeps one trip's map to that trip", async () => {
    const trip = await db.trip.findFirstOrThrow();
    const ids = (await buildMapPayload(member, trip.id)).photos.features.map((f) => f.properties.id);
    expect(ids).toEqual([onTrip]);
  });

  it("spreads a stack on a collection's map too", async () => {
    const user = await db.user.findFirstOrThrow();
    const twin = await db.photo.create({ data: { uploaderId: user.id, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", gpsSource: "MANUAL", originalName: "twin.jpg", lat: 39.28, lng: -76.61 } });
    await db.collectionItem.create({ data: { collectionId, photoId: twin.id, addedById: user.id } });
    const features = (await buildCollectionMapPayload(member, collectionId)).photos.features;
    expect(features).toHaveLength(2);
    expect(features[0].geometry.coordinates).not.toEqual(features[1].geometry.coordinates);
  });
});

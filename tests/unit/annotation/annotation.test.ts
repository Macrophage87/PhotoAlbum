import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { annotationSchema, toStored } from "@/lib/annotation/schema";
import { actualSpend, estimateCost } from "@/lib/annotation/pricing";
import { describeItem, needsDateEstimate, requestParams } from "@/lib/annotation/request";
import { applyAnnotation, parseMessageContent } from "@/lib/annotation/apply";
import { BATCH_CHUNK, chunk, splitByBytes } from "@/lib/jobs/handlers/annotation-batch";
import { thinkingParams } from "@/lib/annotation/client";
import { SYSTEM_INSTRUCTIONS } from "@/lib/annotation/prompt";
import { resetTestDb } from "../helpers/reset";

const fixture = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/annotation-response.json"), "utf8"));

describe("annotation schema and pricing", () => {
  it("accepts the recorded response and normalises tags", () => {
    const parsed = annotationSchema.parse({ ...fixture, tags: [...fixture.tags, "Lobster", " boat "] });
    expect(toStored(parsed).tags.filter((t) => t === "lobster")).toHaveLength(1);
    expect(toStored(parsed)).not.toHaveProperty("estimatedYear");
  });
  it("rejects a record with the wrong shape", () => {
    expect(annotationSchema.safeParse({ caption: "x" }).success).toBe(false);
    expect(parseMessageContent([{ type: "text", text: "not json" }])).toBeNull();
    expect(parseMessageContent([{ type: "text", text: JSON.stringify(fixture) }])?.caption).toBe(fixture.caption);
  });
  it("estimates cost per model with the cache-read rate only where the block caches", () => {
    const opus = estimateCost("claude-opus-5", { photos: 10000, videos: 0 }, { batch: false });
    expect(opus.usd).toBeCloseTo(10000 * ((2500 / 1e6) * 5 + (1000 / 1e6) * 0.5 + (400 / 1e6) * 25), 0);
    const haiku = estimateCost("claude-haiku-4-5", { photos: 10000, videos: 0 }, { batch: false });
    expect(haiku.usd).toBeCloseTo(10000 * ((3500 / 1e6) * 1 + (400 / 1e6) * 5), 0);
    expect(estimateCost("claude-opus-5", { photos: 100, videos: 0 }, { batch: true }).usd).toBeCloseTo(estimateCost("claude-opus-5", { photos: 100, videos: 0 }, { batch: false }).usd / 2, 2);
    expect(estimateCost("claude-opus-5", { photos: 0, videos: 1 }, { batch: false }).inputTokens).toBeGreaterThan(estimateCost("claude-opus-5", { photos: 1, videos: 0 }, { batch: false }).inputTokens);
  });
  it("uses adaptive thinking at low effort except on Haiku", () => {
    expect(thinkingParams("claude-opus-5")).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    expect(thinkingParams("claude-haiku-4-5")).toEqual({});
  });
  it("keeps the effort level next to the output format in a built request", () => {
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/webp" as const, data: "AAAA" } };
    const req = requestParams("claude-opus-5", [image], "notes");
    expect((req.output_config as { effort?: string }).effort).toBe("low");
    expect((req.output_config as { format?: unknown }).format).toBeTruthy();
    expect(req.thinking).toEqual({ type: "adaptive" });
    const haiku = requestParams("claude-haiku-4-5", [image], "notes");
    expect((haiku.output_config as { effort?: string }).effort).toBeUndefined();
    expect(haiku.thinking).toBeUndefined();
  });
  it("clamps over-long fields instead of rejecting a good answer", () => {
    const raw = { caption: "x".repeat(250), description: "d", tags: Array.from({ length: 30 }, (_, i) => `t${i}`), place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "s", estimatedYear: null, estimatedPlace: null };
    const parsed = parseMessageContent([{ type: "text", text: JSON.stringify(raw) }]);
    expect(parsed?.caption).toHaveLength(200);
    expect(parsed?.tags).toHaveLength(25);
    expect(parseMessageContent([{ type: "text", text: "not json" }])).toBeNull();
  });
  it("splits a backfill into batches of at most BATCH_CHUNK items", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
    expect(BATCH_CHUNK).toBeLessThanOrEqual(500);
  });
  it("keeps the instruction block above the Opus 5 and Sonnet 5 cache minimums", () => {
    // Roughly four characters per token: comfortably over 1,024 tokens.
    expect(SYSTEM_INSTRUCTIONS.length).toBeGreaterThan(4500);
  });
});

describe("the text block", () => {
  const base = { id: "p", kind: "PHOTO" as const, status: "READY" as const, storageKey: "k", renditions: null, videoRenditions: null, takenAt: new Date("2025-08-12T12:00:00Z"), takenAtSource: "EXIF_OFFSET" as const, tzOffsetMin: -240, camera: "iPhone 15", lat: null, lng: null, placeEstimatedAt: null, context: "lobster rolls on the mail boat", caption: null, title: null, durationS: null, trip: { title: "Acadia", timezone: "America/New_York" }, collections: [{ collection: { title: "Summer" } }] };
  it("includes notes, containers and the names rule, and asks for a date only when needed", () => {
    const text = describeItem(base, ["Sam"], false);
    expect(text).toContain("Notes from the person who uploaded it: lobster rolls");
    expect(text).toContain("Trip: Acadia");
    expect(text).toContain("Collections: Summer");
    // Asked for, not merely permitted: "names you may use" left the family's parents called "an older couple".
    expect(text).toContain("call them by these names rather than by age or role: Sam");
    expect(text).not.toContain("estimate a year");
    expect(describeItem(base, [], true)).toContain("do not name anyone");
    expect(describeItem(base, [], true)).toContain("Please estimate a year range");
  });
  it("wants a date estimate when the only date is the file or upload time", () => {
    expect(needsDateEstimate({ takenAt: new Date(), takenAtSource: "EXIF_OFFSET" })).toBe(false);
    expect(needsDateEstimate({ takenAt: new Date(), takenAtSource: "FILE_MTIME" })).toBe(true);
    expect(needsDateEstimate({ takenAt: null, takenAtSource: null })).toBe(true);
  });
});

describe("applying a record", () => {
  let photoId: string;
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "a@example.com" } });
    photoId = (await db.photo.create({ data: { uploaderId: user.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date(), takenAtSource: "FILE_MTIME" } })).id;
  });
  it("stores the record, the raw response, and a model estimate for an undated item, then makes it searchable", async () => {
    const parsed = annotationSchema.parse({ ...fixture, estimatedYear: { from: 1990, to: 1994, confidence: 0.55, evidence: "print border" } });
    await applyAnnotation(photoId, "claude-opus-5", parsed, { content: [] });
    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect(p.annotationSource).toBe("MACHINE");
    expect((p.annotation as { caption: string }).caption).toBe(fixture.caption);
    expect(p.estimatedDate?.getUTCFullYear()).toBe(1992);
    expect(p.estimatedDateSource).toBe("MODEL");
    expect(await db.mediaAnnotationRaw.count({ where: { photoId } })).toBe(1);
    const hit = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Photo" WHERE "searchVector" @@ websearch_to_tsquery('english', 'seafood harbour')`;
    expect(hit.map((h) => h.id)).toEqual([photoId]);
  });
  it("fills in a title only where the item has none, and never for an embedded video", async () => {
    const parsed = annotationSchema.parse(fixture);
    await applyAnnotation(photoId, "claude-opus-5", parsed, {});
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).title).toBe("Mail boat lunch");
    await db.photo.update({ where: { id: photoId }, data: { title: "Nana's boat day" } });
    await applyAnnotation(photoId, "claude-opus-5", parsed, {});
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).title).toBe("Nana's boat day");
    await db.photo.update({ where: { id: photoId }, data: { title: null, kind: "EXTERNAL_VIDEO" } });
    await applyAnnotation(photoId, "claude-opus-5", parsed, {});
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).title).toBeNull();
  });
  it("places an item the helper recognised, and asks only when the item has no position", async () => {
    const withPlace = { ...fixture, estimatedPlace: { name: "Inner Harbor, Baltimore", precision: "exact", lat: 39.2853, lng: -76.6093, radiusM: 800, confidence: 0.75, evidence: "the Domino Sugar sign" } };
    await applyAnnotation(photoId, "claude-opus-5", annotationSchema.parse(withPlace), {});
    const placed = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect(placed.gpsSource).toBe("ESTIMATE");
    expect(placed.placeEstimateName).toBe("Inner Harbor, Baltimore");

    // A second pass over an item that now has a position must not move it, whatever comes back.
    await db.photo.update({ where: { id: photoId }, data: { lat: 44.35, lng: -68.2, gpsSource: "EXIF", placeEstimatedAt: null, placeEstimateName: null } });
    await applyAnnotation(photoId, "claude-opus-5", annotationSchema.parse(withPlace), {});
    const kept = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect([kept.lat, kept.gpsSource]).toEqual([44.35, "EXIF"]);
    expect(kept.placeEstimatedAt).toBeNull();
  });
  it("never overwrites a member's edits and never replaces a member's date", async () => {
    await db.photo.update({ where: { id: photoId }, data: { annotationSource: "EDITED", estimatedDateSource: "MEMBER", estimatedDate: new Date("1980-01-01") } });
    await applyAnnotation(photoId, "claude-opus-5", annotationSchema.parse({ ...fixture, estimatedYear: { from: 1990, to: 1994, confidence: 0.9, evidence: "x" } }), {});
    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect(p.annotationSource).toBe("EDITED");
    expect(p.estimatedDate?.getUTCFullYear()).toBe(1980);
  });
});

describe("real spend and byte budgets", () => {
  it("prices each row by its own model and never subtracts cache reads from input tokens", () => {
    const rows = [
      { model: "claude-haiku-4-5", input: 1000, cacheRead: 1000, output: 100, batched: false },
      { model: "claude-opus-5", input: 1000, cacheRead: 0, output: 100, batched: true },
    ];
    const spend = actualSpend("claude-opus-5", rows);
    const haiku = (1000 * 1 + 1000 * 1 * 0.1 + 100 * 5) / 1e6;
    const opus = 0.5 * ((1000 * 5 + 100 * 25) / 1e6);
    expect(spend.usd).toBeCloseTo(Math.round((haiku + opus) * 100) / 100, 2);
    expect(spend.inputTokens).toBe(2000);
    expect(spend.cacheReadTokens).toBe(1000);
  });
  it("splits requests so no batch exceeds the byte budget", () => {
    const items = [{ bytes: 60 }, { bytes: 60 }, { bytes: 60 }, { bytes: 10 }];
    expect(splitByBytes(items, 100).map((g) => g.length)).toEqual([1, 1, 2]);
    expect(splitByBytes([{ bytes: 500 }], 100)).toHaveLength(1);
  });
});

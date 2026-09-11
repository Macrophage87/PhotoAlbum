import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { annotationSchema, toStored } from "@/lib/annotation/schema";
import { estimateCost } from "@/lib/annotation/pricing";
import { describeItem, needsDateEstimate } from "@/lib/annotation/request";
import { applyAnnotation, parseMessageContent } from "@/lib/annotation/apply";
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
  it("keeps the instruction block above the Opus 5 and Sonnet 5 cache minimums", () => {
    // Roughly four characters per token: comfortably over 1,024 tokens.
    expect(SYSTEM_INSTRUCTIONS.length).toBeGreaterThan(4500);
  });
});

describe("the text block", () => {
  const base = { id: "p", kind: "PHOTO" as const, status: "READY" as const, storageKey: "k", renditions: null, videoRenditions: null, takenAt: new Date("2025-08-12T12:00:00Z"), takenAtSource: "EXIF_OFFSET" as const, tzOffsetMin: -240, camera: "iPhone 15", context: "lobster rolls on the mail boat", caption: null, title: null, durationS: null, trip: { title: "Acadia", timezone: "America/New_York" }, collections: [{ collection: { title: "Summer" } }] };
  it("includes notes, containers and the names rule, and asks for a date only when needed", () => {
    const text = describeItem(base, ["Sam"], false);
    expect(text).toContain("Notes from the person who uploaded it: lobster rolls");
    expect(text).toContain("Trip: Acadia");
    expect(text).toContain("Collections: Summer");
    expect(text).toContain("whose names you may use: Sam");
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
  it("never overwrites a member's edits and never replaces a member's date", async () => {
    await db.photo.update({ where: { id: photoId }, data: { annotationSource: "EDITED", estimatedDateSource: "MEMBER", estimatedDate: new Date("1980-01-01") } });
    await applyAnnotation(photoId, "claude-opus-5", annotationSchema.parse({ ...fixture, estimatedYear: { from: 1990, to: 1994, confidence: 0.9, evidence: "x" } }), {});
    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect(p.annotationSource).toBe("EDITED");
    expect(p.estimatedDate?.getUTCFullYear()).toBe(1980);
  });
});

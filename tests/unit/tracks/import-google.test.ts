import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { importTrackFile } from "@/lib/tracks/import";
import { resetTestDb } from "../helpers/reset";

describe("importing a Google export", () => {
  let tripId: string, userId: string;
  const key = "imports/test/Timeline.json";
  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "i@example.com", role: "ADMIN" } })).id;
    tripId = (await db.trip.create({ data: { slug: "i", title: "I", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: userId, timezone: "America/New_York" } })).id;
    const file = storage().localPath!(key);
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(path.join(__dirname, "../../fixtures/google-timeline-android.json"), file);
  });

  it("counts only the points the export holds, and replaces the day's trace when imported again", async () => {
    const photo = await db.photo.create({
      data: { tripId, uploaderId: userId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date("2025-08-12T14:40:00Z"), takenAtSource: "EXIF_OFFSET" },
    });
    const args = { importKey: key, tripId, userId, sourceHint: "google" as const, originalName: "Timeline.json" };
    const first = await importTrackFile(args);
    expect(first.pointsRead).toBe(5);
    expect(first.tracks.map((t) => t.pointCount)).toEqual([5]);

    const second = await importTrackFile(args);
    const tracks = await db.track.findMany({ where: { tripId } });
    expect(tracks.map((t) => t.id)).toEqual([second.tracks[0].trackId]);
    // The photo taken during the visit is placed from the trace that is left.
    const p = await db.photo.findUniqueOrThrow({ where: { id: photo.id } });
    expect([p.gpsSource, p.lat]).toEqual(["TRACK", 44.353]);
  });

  it("leaves another member's trace for the same day alone", async () => {
    const other = (await db.user.create({ data: { email: "o@example.com", role: "MEMBER" } })).id;
    await importTrackFile({ importKey: key, tripId, userId: other, sourceHint: "google", originalName: "Timeline.json" });
    await importTrackFile({ importKey: key, tripId, userId, sourceHint: "google", originalName: "Timeline.json" });
    expect(await db.track.count({ where: { tripId } })).toBe(2);
  });
});

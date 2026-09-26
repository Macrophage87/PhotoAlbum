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

  const args = (userId: string, replaceGoogle?: boolean) => ({ importKey: key, tripId, userId, sourceHint: "google" as const, originalName: "Timeline.json", replaceGoogle });

  it("counts only the points the export holds, and keeps both traces when imported twice by default", async () => {
    const first = await importTrackFile(args(userId));
    expect(first.pointsRead).toBe(5);
    expect(first.tracks.map((t) => t.pointCount)).toEqual([5]);
    // One account importing two family members' exports keeps them both.
    await importTrackFile(args(userId));
    expect(await db.track.count({ where: { tripId } })).toBe(2);
  });

  it("replaces the member's earlier trace for the day when asked, and places photos from what is left", async () => {
    const photo = await db.photo.create({
      data: { tripId, uploaderId: userId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date("2025-08-12T14:40:00Z"), takenAtSource: "EXIF_OFFSET" },
    });
    await importTrackFile(args(userId));
    const second = await importTrackFile(args(userId, true));
    const tracks = await db.track.findMany({ where: { tripId } });
    expect(tracks.map((t) => t.id)).toEqual([second.tracks[0].trackId]);
    const p = await db.photo.findUniqueOrThrow({ where: { id: photo.id } });
    expect([p.gpsSource, p.lat]).toEqual(["TRACK", 44.353]);
  });

  it("never replaces another member's trace", async () => {
    const other = (await db.user.create({ data: { email: "o@example.com", role: "MEMBER" } })).id;
    await importTrackFile(args(other));
    await importTrackFile(args(userId, true));
    expect(await db.track.count({ where: { tripId } })).toBe(2);
  });
});

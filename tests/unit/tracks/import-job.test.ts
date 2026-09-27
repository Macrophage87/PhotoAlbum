import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const root = mkdtempSync(path.join(tmpdir(), "track-import-"));
process.env.PHOTO_STORAGE_ROOT = root;
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => "job" }));

import { importTrack } from "@/lib/jobs/handlers/import-track";
import { forgetGoogleExports, forgetTrackFiles } from "@/lib/tracks/files";

/** Put a file where the import route would have streamed it. */
function uploaded(fixture: string | null, key: string, text?: string): string {
  mkdirSync(path.join(root, "imports"), { recursive: true });
  if (fixture) copyFileSync(path.join(process.cwd(), "tests/fixtures", fixture), path.join(root, key));
  else writeFileSync(path.join(root, key), text ?? "");
  return key;
}
const stillThere = (key: string) => existsSync(path.join(root, key));

describe("the files an import leaves behind", () => {
  let userId: string, tripId: string;
  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "t@example.com", role: "MEMBER" } })).id;
    tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), timezone: "America/New_York", createdById: userId } })).id;
  });
  const job = (importKey: string, originalName: string) => ({ importKey, tripId, userId, sourceHint: "auto" as const, originalName });

  it("deletes a whole Google export once the trip's days are read out of it, and keeps no pointer to it", async () => {
    const key = uploaded("google-records.json", "imports/records.json");
    const summary = (await importTrack(job(key, "Records.json"))) as { tracks: unknown[] };
    expect(summary.tracks.length).toBeGreaterThan(0);
    expect(stillThere(key)).toBe(false);
    expect(await db.track.count({ where: { originalFile: { not: null } } })).toBe(0);
  });
  it("saves nothing once pg-boss has stopped the job, and does not keep the file", async () => {
    const key = uploaded("sample.gpx", "imports/late.gpx");
    const expired = AbortSignal.abort(new Error("handler execution exceeded 3600s"));
    await expect(importTrack(job(key, "late.gpx"), expired)).rejects.toThrow(/exceeded/);
    expect(await db.track.count()).toBe(0);
    expect(stillThere(key)).toBe(false);
  });
  it("deletes a file that could not be read, and one that gave no tracks", async () => {
    const junk = uploaded(null, "imports/junk.tcx", "not a track");
    await expect(importTrack(job(junk, "junk.tcx"))).rejects.toThrow();
    expect(stillThere(junk)).toBe(false);
    const empty = uploaded(null, "imports/empty.gpx", `<?xml version="1.0"?><gpx version="1.1" creator="t"><trk><name>x</name><trkseg></trkseg></trk></gpx>`);
    await importTrack(job(empty, "empty.gpx"));
    expect(stillThere(empty)).toBe(false);
  });
  it("keeps a GPX file while a track made from it is kept, and deletes it with the last one", async () => {
    const key = uploaded("sample.gpx", "imports/walk.gpx");
    await importTrack(job(key, "walk.gpx"));
    expect(stillThere(key)).toBe(true);
    const tracks = await db.track.findMany({ where: { originalFile: key }, select: { id: true } });
    expect(tracks.length).toBeGreaterThan(0);
    await forgetTrackFiles([key]);
    expect(stillThere(key)).toBe(true);
    await db.track.deleteMany({ where: { originalFile: key } });
    await forgetTrackFiles([key]);
    expect(stillThere(key)).toBe(false);
  });
  it("deletes the Google exports earlier imports kept, once, and forgets them on their tracks", async () => {
    const key = uploaded("google-records.json", "imports/old-export.json");
    const gpx = uploaded("sample.gpx", "imports/kept.gpx");
    const base = { tripId, uploaderId: userId, name: "t", startTime: new Date(), endTime: new Date(), pointCount: 2, minLat: 0, maxLat: 0, minLng: 0, maxLng: 0, simplified: [], pointsBlob: new Uint8Array(0) };
    await db.track.create({ data: { ...base, source: "GOOGLE", originalFile: key } as never });
    await db.track.create({ data: { ...base, source: "GPX", originalFile: gpx } as never });
    expect(await forgetGoogleExports()).toBe(1);
    expect(stillThere(key)).toBe(false);
    expect(stillThere(gpx)).toBe(true);
    expect(await db.track.count({ where: { source: "GOOGLE", originalFile: { not: null } } })).toBe(0);
    expect(await forgetGoogleExports()).toBe(0);
  });
});

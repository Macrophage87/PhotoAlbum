import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "process-race-"));
process.env.PHOTO_STORAGE_ROOT = photoRoot;
const queued = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string) => void queued.push(queue) }));

/**
 * Something a member does while a job renders: after the job read the row, before it writes back. Rendering is the
 * slow part of both jobs (for a clip it comes after ffmpeg, minutes after the read), so it stands in for "meanwhile".
 */
const meanwhile = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock("@/lib/images/renditions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/images/renditions")>();
  return {
    ...real,
    makeRenditions: async (...args: Parameters<typeof real.makeRenditions>) => {
      const run = meanwhile.run;
      meanwhile.run = null;
      if (run) await run();
      return real.makeRenditions(...args);
    },
  };
});

import { processPhoto } from "@/lib/jobs/handlers/process-photo";
import { transcodeVideo } from "@/lib/jobs/handlers/transcode-video";

/** A member's date, place and filing given while a photo or clip is being processed are not written over. */
describe("choices a member makes while an item is processed", () => {
  let memberId: string, tripId: string, walkId: string;
  const handDate = new Date("1985-06-01T15:00:00Z");
  beforeEach(async () => {
    await resetTestDb();
    meanwhile.run = null;
    queued.length = 0;
    memberId = (await db.user.create({ data: { email: "m@example.com", role: "ADMIN" } })).id;
    tripId = (await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("1985-05-30"), endDate: new Date("1985-06-03"), createdById: memberId } })).id;
    // Far from the hand-set hour, so only the member's filing can put anything on it.
    walkId = (await db.activity.create({ data: { tripId, title: "Walk", startTime: new Date("1985-06-02T09:00:00Z"), endTime: new Date("1985-06-02T10:00:00Z") } })).id;
  });
  async function stage(fixture: string, data: Record<string, unknown>, file: string) {
    const photo = await db.photo.create({ data: { uploaderId: memberId, originalName: fixture, mimeType: file.endsWith(".mp4") ? "video/mp4" : "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 1, status: "PENDING", ...data } });
    const key = `photos/${photo.id}`;
    mkdirSync(path.join(photoRoot, key), { recursive: true });
    copyFileSync(path.join(process.cwd(), "tests/fixtures", fixture), path.join(photoRoot, key, file));
    await db.photo.update({ where: { id: photo.id }, data: { storageKey: key, originalPath: `${key}/${file}` } });
    return photo.id;
  }
  // What the photo page's actions write: a date typed by hand, a place cleared, the item filed on an activity.
  const datedByHand = (id: string) => db.photo.update({ where: { id }, data: { takenAt: handDate, takenAtSource: "MANUAL", tzOffsetMin: 0, dateSetById: memberId, tripId } });
  const placeCleared = (id: string) => db.photo.update({ where: { id }, data: { lat: null, lng: null, altitude: null, gpsSource: null, placeSetById: memberId } });
  const filed = (id: string) => db.photo.update({ where: { id }, data: { activityId: walkId, activitySetById: memberId, tripId } });

  it("keeps a photo's hand-set date, cleared place and filing, and still stores its renditions", async () => {
    const id = await stage("photo-with-gps.jpg", {}, "original.jpg");
    meanwhile.run = async () => {
      await placeCleared(id);
      await datedByHand(id);
      await filed(id);
    };
    await processPhoto({ photoId: id });
    const p = await db.photo.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ status: "READY", lat: null, lng: null, gpsSource: null, placeSetById: memberId, takenAtSource: "MANUAL", tzOffsetMin: 0, dateSetById: memberId, tripId, activityId: walkId, activitySetById: memberId });
    expect(p.takenAt?.toISOString()).toBe(handDate.toISOString());
    expect(p.width).toBeGreaterThan(0);
    expect(p.renditions).not.toBeNull();
  });

  it("keeps a place pinned by hand while the photo was processed", async () => {
    const id = await stage("photo-with-gps.jpg", {}, "original.jpg");
    meanwhile.run = async () => void (await db.photo.update({ where: { id }, data: { lat: 10, lng: 20, altitude: null, gpsSource: "MANUAL", placeSetById: memberId } }));
    await processPhoto({ photoId: id });
    expect(await db.photo.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "READY", lat: 10, lng: 20, gpsSource: "MANUAL", placeSetById: memberId });
  });

  it("keeps a clip's hand-set date and filing through a transcode", async () => {
    const id = await stage("clip.mp4", { kind: "VIDEO" }, "original.mp4");
    meanwhile.run = async () => {
      await datedByHand(id);
      await filed(id);
    };
    await transcodeVideo({ photoId: id });
    const p = await db.photo.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ status: "READY", kind: "VIDEO", takenAtSource: "MANUAL", tzOffsetMin: 0, dateSetById: memberId, tripId, activityId: walkId, activitySetById: memberId });
    expect(p.takenAt?.toISOString()).toBe(handDate.toISOString());
    expect(p.videoRenditions).not.toBeNull();
  }, 120_000);

  describe("a date set by hand with no zone recorded", () => {
    // 15:00 UTC on 1 June 1985 is 09:00 in Denver, six hours behind in summer.
    const inDenver = async () => (await db.trip.create({ data: { slug: "d", title: "D", startDate: new Date("1985-05-30"), endDate: new Date("1985-06-03"), timezone: "America/Denver", createdById: memberId } })).id;
    const zoneless = (tripId: string | null) => ({ takenAt: handDate, takenAtSource: "MANUAL", tzOffsetMin: null, dateSetById: memberId, tripId });

    it("takes a clip's trip's zone through a transcode, and keeps the date", async () => {
      const denver = await inDenver();
      const id = await stage("clip.mp4", { kind: "VIDEO", ...zoneless(denver) }, "original.mp4");
      await transcodeVideo({ photoId: id });
      const p = await db.photo.findUniqueOrThrow({ where: { id } });
      expect(p).toMatchObject({ status: "READY", takenAtSource: "MANUAL", tzOffsetMin: -360, dateSetById: memberId, tripId: denver });
      expect(p.takenAt?.toISOString()).toBe(handDate.toISOString());
    }, 120_000);

    it("takes a photo's trip's zone too", async () => {
      const denver = await inDenver();
      const id = await stage("photo-with-gps.jpg", zoneless(denver), "original.jpg");
      await processPhoto({ photoId: id });
      const p = await db.photo.findUniqueOrThrow({ where: { id } });
      expect(p).toMatchObject({ status: "READY", takenAtSource: "MANUAL", tzOffsetMin: -360, tripId: denver });
      expect(p.takenAt?.toISOString()).toBe(handDate.toISOString());
    });

    it("takes the zone of the trip a member moved the clip to meanwhile, and a zone a member gave meanwhile stands", async () => {
      const denver = await inDenver();
      const moved = await stage("clip.mp4", { kind: "VIDEO", ...zoneless(null) }, "original.mp4");
      meanwhile.run = async () => void (await db.photo.update({ where: { id: moved }, data: { tripId: denver } }));
      await transcodeVideo({ photoId: moved });
      expect(await db.photo.findUniqueOrThrow({ where: { id: moved } })).toMatchObject({ tzOffsetMin: -360, tripId: denver });
      const zoned = await stage("clip.mp4", { kind: "VIDEO", ...zoneless(denver) }, "original.mp4");
      meanwhile.run = async () => void (await db.photo.update({ where: { id: zoned }, data: { tzOffsetMin: 120 } }));
      await transcodeVideo({ photoId: zoned });
      expect(await db.photo.findUniqueOrThrow({ where: { id: zoned } })).toMatchObject({ tzOffsetMin: 120, takenAtSource: "MANUAL" });
    }, 120_000);

    it("stays without one when the clip is on no trip", async () => {
      // None to be filed on by its day either.
      await db.activity.deleteMany();
      await db.trip.deleteMany();
      const id = await stage("clip.mp4", { kind: "VIDEO", ...zoneless(null) }, "original.mp4");
      await transcodeVideo({ photoId: id });
      const p = await db.photo.findUniqueOrThrow({ where: { id } });
      expect(p).toMatchObject({ status: "READY", takenAtSource: "MANUAL", tzOffsetMin: null, tripId: null });
      expect(p.takenAt?.toISOString()).toBe(handDate.toISOString());
    }, 120_000);
  });

  describe("a place a member pinned or cleared meanwhile", () => {
    // Dated by hand before the job, so the photo (whose file has no position) is one a track could place.
    const dated = () => ({ takenAt: handDate, takenAtSource: "MANUAL", tzOffsetMin: 0, dateSetById: memberId, tripId });

    it("asks for no track position, which geotagging would not give it anyway", async () => {
      const pinned = await stage("photo-no-gps.jpg", dated(), "original.jpg");
      meanwhile.run = async () => void (await db.photo.update({ where: { id: pinned }, data: { lat: 10, lng: 20, gpsSource: "MANUAL", placeSetById: memberId } }));
      await processPhoto({ photoId: pinned });
      const cleared = await stage("photo-no-gps.jpg", dated(), "original.jpg");
      meanwhile.run = () => placeCleared(cleared).then(() => undefined);
      await processPhoto({ photoId: cleared });
      expect(queued).not.toContain("geotag-photos");
      expect(await db.photo.findUniqueOrThrow({ where: { id: pinned } })).toMatchObject({ status: "READY", lat: 10, lng: 20, gpsSource: "MANUAL" });
    });

    it("still asks for one when nobody set its place", async () => {
      const id = await stage("photo-no-gps.jpg", dated(), "original.jpg");
      await processPhoto({ photoId: id });
      expect(queued).toContain("geotag-photos");
    });
  });
});

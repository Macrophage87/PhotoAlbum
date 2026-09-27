import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const queued = vi.hoisted(() => [] as { queue: string; data: { photoId: string }; opts: { singletonKey?: string } }[]);
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: { photoId: string }, opts: { singletonKey?: string }) => { queued.push({ queue, data, opts }); return "job"; } }));

import { processAgainIfStuck, requeueStuckPending } from "@/lib/media/requeue";
import { hasLiveProcessingJob, withLiveProcessingJob } from "@/lib/jobs/live";

const MIN = 60_000;
const noJob = async () => false;

describe("queueing processing again for a photo that never became a picture", () => {
  let userId: string;
  beforeEach(async () => {
    await resetTestDb();
    queued.length = 0;
    userId = (await db.user.create({ data: { email: "r@example.com", role: "MEMBER" } })).id;
  });
  const row = async (status: "PENDING" | "FAILED", ago: number, kind: "PHOTO" | "VIDEO" = "PHOTO") => {
    const p = await db.photo.create({ data: { uploaderId: userId, kind, status, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "photos/x", originalPath: "photos/x/original.jpg", sizeBytes: 1, updatedAt: new Date(Date.now() - ago) } });
    return db.photo.findUniqueOrThrow({ where: { id: p.id } });
  };

  it("queues a PENDING one an hour on with no job for it, once", async () => {
    const p = await row("PENDING", 90 * MIN);
    expect(await processAgainIfStuck(p, { liveJob: noJob })).toBe(true);
    expect(queued).toEqual([{ queue: "process-photo", data: { photoId: p.id, tripId: null }, opts: undefined }]);
    // Read before the first went through: it has changed since, so nothing more is queued.
    expect(await processAgainIfStuck(p, { liveJob: noJob })).toBe(false);
    expect(queued).toHaveLength(1);
  });
  it("leaves a PENDING one that is recent, or has a job waiting for it", async () => {
    expect(await processAgainIfStuck(await row("PENDING", 10 * MIN), { liveJob: noJob })).toBe(false);
    expect(await processAgainIfStuck(await row("PENDING", 90 * MIN), { liveJob: async () => true })).toBe(false);
    expect(queued).toHaveLength(0);
  });
  it("leaves a FAILED one to pg-boss's own retries, then queues it (a clip to transcoding)", async () => {
    expect(await processAgainIfStuck(await row("FAILED", 1 * MIN, "VIDEO"), { liveJob: noJob })).toBe(false);
    // Old enough, but a retry is still waiting for it.
    expect(await processAgainIfStuck(await row("FAILED", 10 * MIN, "VIDEO"), { liveJob: async () => true })).toBe(false);
    const old = await row("FAILED", 10 * MIN, "VIDEO");
    expect(await processAgainIfStuck(old, { liveJob: noJob })).toBe(true);
    expect(queued).toEqual([{ queue: "transcode-video", data: { photoId: old.id, tripId: null }, opts: undefined }]);
  });
  it("queues once when the same file arrives twice at the same moment", async () => {
    const p = await row("FAILED", 10 * MIN);
    const results = await Promise.all([processAgainIfStuck(p, { liveJob: noJob }), processAgainIfStuck(p, { liveJob: noJob })]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(queued).toHaveLength(1);
  });
  it("counts an unreadable job table as a job waiting, so nothing is queued twice", async () => {
    // The unit-test database has no pg-boss schema, which is exactly the unreadable case.
    expect(await hasLiveProcessingJob("anything")).toBe(true);
  });
});

describe("the quarter-hourly pass over photos left waiting with no job", () => {
  let userId: string;
  const noJobs = async () => new Set<string>();
  beforeEach(async () => {
    await resetTestDb();
    queued.length = 0;
    userId = (await db.user.create({ data: { email: "q@example.com", role: "MEMBER" } })).id;
  });
  const row = async (over: Record<string, unknown>, ago = 90 * MIN) => {
    const p = await db.photo.create({ data: { uploaderId: userId, kind: "PHOTO", status: "PENDING", originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "photos/x", originalPath: "photos/x/original.jpg", sizeBytes: 1, ...over } });
    // Set last: every write stamps updatedAt.
    await db.$executeRaw`UPDATE "Photo" SET "updatedAt" = ${new Date(Date.now() - ago)} WHERE id = ${p.id}`;
    return p.id;
  };

  it("queues each one an hour on with its file in place and no job, by kind, and nothing else", async () => {
    const photo = await row({});
    const clip = await row({ kind: "VIDEO", mimeType: "video/mp4" });
    const scan = await row({ kind: "SCAN", mimeType: "model/gltf-binary" });
    // A Google Photos row whose download arrived, then the process died before queueing it.
    const picked = await row({ sourceKind: "GOOGLE_PICKER" });
    // Left alone: still waiting for its download (no file), recent, waiting its turn behind a backlog, or not PENDING.
    await row({ sourceKind: "GOOGLE_PICKER", storageKey: "pending", originalPath: "pending", sizeBytes: 0 }, 48 * 60 * MIN);
    await row({ storageKey: "pending", originalPath: "pending" }, 48 * 60 * MIN);
    await row({}, 10 * MIN);
    const waiting = await row({});
    await row({ status: "PROCESSING" });
    await row({ status: "READY" });
    await row({ status: "FAILED" });
    const liveJobs = async (ids: string[]) => new Set(ids.filter((id) => id === waiting));
    expect(await requeueStuckPending(Date.now(), { liveJobs })).toBe(4);
    expect(queued.map((q) => [q.queue, q.data.photoId]).sort()).toEqual(
      [["process-photo", photo], ["transcode-video", clip], ["process-photo", scan], ["process-photo", picked]].sort(),
    );
    // Queued once: they now look freshly queued, and the next pass leaves them to their job.
    expect(await requeueStuckPending(Date.now(), { liveJobs })).toBe(0);
    expect(queued).toHaveLength(4);
  });

  // The job only uses it while the row still has it: a member who moves the photo while the job waits wins (see
  // "a trip changed while the job waited" in process-race.test.ts). It is sent so that a photo taken off its trip
  // meanwhile can be told from one that never had one.
  it("sends the trip the row has, as the upload did", async () => {
    const tripId = (await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: userId } })).id;
    const id = await row({ tripId });
    expect(await requeueStuckPending(Date.now(), { liveJobs: noJobs })).toBe(1);
    expect(queued).toEqual([{ queue: "process-photo", data: { photoId: id, tripId }, opts: undefined }]);
  });

  it("leaves one a member pressed Re-process on, or deleted, after the pass listed it", async () => {
    const reprocessed = await row({});
    const deleted = await row({});
    const liveJobs = async () => {
      // What Re-process writes before it queues its own job; and deleting for good.
      await db.photo.update({ where: { id: reprocessed }, data: { status: "PENDING", error: null } });
      await db.photo.delete({ where: { id: deleted } });
      return new Set<string>();
    };
    expect(await requeueStuckPending(Date.now(), { liveJobs })).toBe(0);
    expect(queued).toHaveLength(0);
  });

  it("queues nothing when the queue cannot be read", async () => {
    await row({});
    // No pg-boss schema in the unit-test database: the real check cannot read it and counts every row as queued.
    expect([...(await withLiveProcessingJob(["a", "b"]))].sort()).toEqual(["a", "b"]);
    expect(await requeueStuckPending()).toBe(0);
    expect(queued).toHaveLength(0);
  });
});

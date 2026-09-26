import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const queued = vi.hoisted(() => [] as { queue: string; data: { photoId: string }; opts: { singletonKey?: string } }[]);
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: { photoId: string }, opts: { singletonKey?: string }) => { queued.push({ queue, data, opts }); return "job"; } }));

import { processAgainIfStuck } from "@/lib/media/requeue";
import { hasLiveProcessingJob } from "@/lib/jobs/live";

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

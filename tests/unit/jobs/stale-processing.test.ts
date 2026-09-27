import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

/** No failure may leave an item in PROCESSING for good: the uploader would see a spinner with no Re-process. */
const fsFail = vi.hoisted(() => ({ mkdtemp: false }));
vi.mock("node:fs/promises", async (orig) => {
  const real = (await orig()) as typeof import("node:fs/promises");
  const mkdtemp = (async (...args: Parameters<typeof real.mkdtemp>) => {
    if (fsFail.mkdtemp) throw new Error("ENOSPC: no space left on device");
    return real.mkdtemp(...args);
  }) as typeof real.mkdtemp;
  return { ...real, default: { ...real, mkdtemp }, mkdtemp };
});
vi.mock("@/lib/jobs/boss", async (orig) => ({ ...((await orig()) as object), enqueue: async () => {} }));
const stopping = vi.hoisted(() => ({ now: false }));
vi.mock("@/lib/jobs/shutdown", () => ({ workerStopping: () => stopping.now, markStopping: () => { stopping.now = true; } }));

import { transcodeVideo } from "@/lib/jobs/handlers/transcode-video";
import { reconcileStalePhotos } from "@/lib/jobs/worker";

describe("items stuck in PROCESSING", () => {
  let userId: string;
  beforeEach(async () => {
    await resetTestDb();
    fsFail.mkdtemp = false;
    stopping.now = false;
    userId = (await db.user.create({ data: { email: "st@example.com", role: "ADMIN" } })).id;
  });
  const clip = () => db.photo.create({ data: { uploaderId: userId, kind: "VIDEO", originalName: "c.mp4", mimeType: "video/mp4", storageKey: "c", originalPath: "c/original.mp4", sizeBytes: 1, status: "PENDING" } });

  it("a clip whose scratch directory cannot be made is marked FAILED", async () => {
    const row = await clip();
    fsFail.mkdtemp = true;
    await expect(transcodeVideo({ photoId: row.id })).rejects.toThrow(/ENOSPC/);
    const after = await db.photo.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("FAILED");
    expect(after.error).toMatch(/ENOSPC/);
  });

  it("reconciliation fails only rows no job can still own", async () => {
    const photo = (status: "PROCESSING" | "PENDING", kind: "PHOTO" | "VIDEO") => db.photo.create({ data: { uploaderId: userId, kind, originalName: "a", mimeType: "image/jpeg", storageKey: "a", originalPath: "a/o", sizeBytes: 1, status } });
    const stuck = await photo("PROCESSING", "PHOTO");
    const queued = await photo("PENDING", "PHOTO");
    const fresh = await photo("PROCESSING", "PHOTO");
    const long = new Date(Date.now() - 2 * 3_600_000);
    await db.$executeRaw`UPDATE "Photo" SET "updatedAt" = ${long} WHERE id IN (${stuck.id}, ${queued.id})`;
    expect(await reconcileStalePhotos()).toBe(1);
    const status = async (id: string) => (await db.photo.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(stuck.id)).toBe("FAILED");
    expect(await status(queued.id)).toBe("PENDING");
    expect(await status(fresh.id)).toBe("PROCESSING");
  });

  it("leaves a Picker download that died holding its row to the stranded-upload sweep, which says to pick it again", async () => {
    const { sweepStrandedUploads } = await import("@/lib/media/stranded");
    const row = await db.photo.create({ data: { uploaderId: userId, kind: "PHOTO", sourceKind: "GOOGLE_PICKER", originalName: "p.jpg", mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 0, status: "PROCESSING" } });
    await db.$executeRaw`UPDATE "Photo" SET "updatedAt" = ${new Date(Date.now() - 2 * 3_600_000)} WHERE id = ${row.id}`;
    expect(await reconcileStalePhotos()).toBe(0);
    await sweepStrandedUploads(new Date(), { livePickerJobs: async () => new Set() });
    expect(await db.photo.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Pick it again/) });
  });

  it("gives clips the heavy queues' longer window before calling them stale", async () => {
    const photo = (kind: "PHOTO" | "VIDEO") => db.photo.create({ data: { uploaderId: userId, kind, originalName: "a", mimeType: "video/mp4", storageKey: "a", originalPath: "a/o", sizeBytes: 1, status: "PROCESSING" } });
    const clip = await photo("VIDEO");
    const still = await photo("PHOTO");
    // Two hours: long past a photo's window, well inside a clip's (four times the 40-minute heavy expiry).
    const twoHours = new Date(Date.now() - 2 * 3_600_000);
    await db.$executeRaw`UPDATE "Photo" SET "updatedAt" = ${twoHours}`;
    expect(await reconcileStalePhotos()).toBe(1);
    expect((await db.photo.findUniqueOrThrow({ where: { id: clip.id } })).status).toBe("PROCESSING");
    expect((await db.photo.findUniqueOrThrow({ where: { id: still.id } })).status).toBe("FAILED");
    const fourHours = new Date(Date.now() - 4 * 3_600_000);
    await db.$executeRaw`UPDATE "Photo" SET "updatedAt" = ${fourHours} WHERE id = ${clip.id}`;
    expect(await reconcileStalePhotos()).toBe(1);
    expect((await db.photo.findUniqueOrThrow({ where: { id: clip.id } })).status).toBe("FAILED");
  });

  it("a clip whose job timed out is marked FAILED as too long; one cut short by a shutdown is left for its retry", async () => {
    const timedOut = await clip();
    const ac = new AbortController();
    ac.abort();
    await expect(transcodeVideo({ photoId: timedOut.id }, ac.signal)).rejects.toThrow();
    const after = await db.photo.findUniqueOrThrow({ where: { id: timedOut.id } });
    expect(after).toMatchObject({ status: "FAILED", error: "Transcoding took too long and was stopped." });

    const interrupted = await clip();
    stopping.now = true;
    await expect(transcodeVideo({ photoId: interrupted.id }, ac.signal)).rejects.toThrow();
    expect((await db.photo.findUniqueOrThrow({ where: { id: interrupted.id } })).status).toBe("PROCESSING");
  });
});

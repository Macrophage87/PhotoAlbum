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

import { transcodeVideo } from "@/lib/jobs/handlers/transcode-video";
import { reconcileStalePhotos } from "@/lib/jobs/worker";

describe("items stuck in PROCESSING", () => {
  let userId: string;
  beforeEach(async () => {
    await resetTestDb();
    fsFail.mkdtemp = false;
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
});

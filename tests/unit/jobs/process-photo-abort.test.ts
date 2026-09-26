import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

/** A run pg-boss has timed out writes nothing more; a run cut short by a shutdown leaves the row for its retry. */
const photoRoot = mkdtempSync(path.join(tmpdir(), "process-abort-"));
process.env.PHOTO_STORAGE_ROOT = photoRoot;
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));
const stopping = vi.hoisted(() => ({ now: false }));
vi.mock("@/lib/jobs/shutdown", () => ({ workerStopping: () => stopping.now, markStopping: () => undefined }));

import { processPhoto } from "@/lib/jobs/handlers/process-photo";

describe("a process-photo run whose job was aborted", () => {
  let userId: string;
  beforeEach(async () => {
    await resetTestDb();
    stopping.now = false;
    userId = (await db.user.create({ data: { email: "pa@example.com", role: "ADMIN" } })).id;
  });
  async function stage() {
    const photo = await db.photo.create({ data: { uploaderId: userId, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 1, status: "PENDING" } });
    const key = `photos/${photo.id}`;
    mkdirSync(path.join(photoRoot, key), { recursive: true });
    copyFileSync(path.join(process.cwd(), "tests/fixtures/photo-no-exif.jpg"), path.join(photoRoot, key, "original.jpg"));
    await db.photo.update({ where: { id: photo.id }, data: { storageKey: key, originalPath: `${key}/original.jpg` } });
    return photo.id;
  }
  const aborted = () => {
    const ac = new AbortController();
    ac.abort();
    return ac.signal;
  };

  it("is marked FAILED as too long rather than READY", async () => {
    const id = await stage();
    await expect(processPhoto({ photoId: id }, aborted())).rejects.toThrow();
    expect(await db.photo.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "FAILED", error: "Processing took too long and was stopped." });
  });

  it("is left in PROCESSING for its retry when the worker is shutting down", async () => {
    const id = await stage();
    stopping.now = true;
    await expect(processPhoto({ photoId: id, mode: "renditions" }, aborted())).rejects.toThrow();
    expect((await db.photo.findUniqueOrThrow({ where: { id } })).status).toBe("PROCESSING");
  });
});

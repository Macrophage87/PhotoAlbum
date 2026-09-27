import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "deleted-while-rendering-"));
process.env.PHOTO_STORAGE_ROOT = photoRoot;
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

/**
 * An item deleted for good while its job renders it: the delete's file job has already removed the folder, and then
 * the renditions arrive. Rendering is the slow part of both jobs, so the delete is done there, as a member would.
 */
const meanwhile = vi.hoisted(() => ({ run: null as null | (() => Promise<void>), fail: false }));
vi.mock("@/lib/images/renditions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/images/renditions")>();
  return {
    ...real,
    makeRenditions: async (...args: Parameters<typeof real.makeRenditions>) => {
      const run = meanwhile.run;
      meanwhile.run = null;
      if (run) await run();
      const made = await real.makeRenditions(...args);
      if (meanwhile.fail) throw new Error("rendering failed");
      return made;
    },
  };
});

// A 3D scan's slow part is its visitor copy, which streams the whole file.
vi.mock("@/lib/scans/public-copy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/scans/public-copy")>();
  return {
    ...real,
    publicScanCopy: async (...args: Parameters<typeof real.publicScanCopy>) => {
      const run = meanwhile.run;
      meanwhile.run = null;
      if (run) await run();
      return real.publicScanCopy(...args);
    },
  };
});

import { processPhoto } from "@/lib/jobs/handlers/process-photo";
import { transcodeVideo } from "@/lib/jobs/handlers/transcode-video";
import { deletePhoto } from "@/lib/jobs/handlers/delete-photo";

describe("an item deleted for good while it is processed", () => {
  let memberId: string;
  beforeEach(async () => {
    await resetTestDb();
    meanwhile.run = null;
    meanwhile.fail = false;
    memberId = (await db.user.create({ data: { email: "m@example.com", role: "ADMIN" } })).id;
  });
  async function stage(fixture: string, file: string) {
    const photo = await db.photo.create({ data: { uploaderId: memberId, originalName: fixture, mimeType: file.endsWith(".mp4") ? "video/mp4" : "image/jpeg", kind: file.endsWith(".mp4") ? "VIDEO" : "PHOTO", storageKey: "pending", originalPath: "pending", sizeBytes: 1, status: "PENDING" } });
    const key = `photos/${photo.id}`;
    mkdirSync(path.join(photoRoot, key), { recursive: true });
    copyFileSync(path.join(process.cwd(), "tests/fixtures", fixture), path.join(photoRoot, key, file));
    await db.photo.update({ where: { id: photo.id }, data: { storageKey: key, originalPath: `${key}/${file}` } });
    return { id: photo.id, folder: path.join(photoRoot, key) };
  }
  /** What deleting from the trash does: the row goes, then the file job empties the folder. */
  const deletedForGood = async (id: string) => {
    await db.photo.delete({ where: { id } });
    await deletePhoto({ storageKey: `photos/${id}` });
  };

  it("leaves no renditions of a photo behind", async () => {
    const { id, folder } = await stage("photo-with-gps.jpg", "original.jpg");
    meanwhile.run = () => deletedForGood(id);
    await processPhoto({ photoId: id });
    expect(existsSync(folder)).toBe(false);
  });

  it("leaves none behind when it is re-rendered after an edit", async () => {
    const { id, folder } = await stage("photo-with-gps.jpg", "original.jpg");
    meanwhile.run = () => deletedForGood(id);
    await processPhoto({ photoId: id, mode: "renditions" });
    expect(existsSync(folder)).toBe(false);
  });

  it("leaves none behind when the job then fails, and does not ask to be retried", async () => {
    const { id, folder } = await stage("photo-with-gps.jpg", "original.jpg");
    meanwhile.run = () => deletedForGood(id);
    meanwhile.fail = true;
    await processPhoto({ photoId: id });
    expect(existsSync(folder)).toBe(false);
  });

  it("leaves no transcoded clip or poster behind", async () => {
    const { id, folder } = await stage("clip.mp4", "original.mp4");
    meanwhile.run = () => deletedForGood(id);
    await transcodeVideo({ photoId: id });
    expect(existsSync(folder)).toBe(false);
  });

  it("cleans up after an earlier run when its retry finds no row", async () => {
    const { id, folder } = await stage("photo-with-gps.jpg", "original.jpg");
    await db.photo.delete({ where: { id } });
    await processPhoto({ photoId: id });
    expect(existsSync(folder)).toBe(false);
  });

  // Guards behaviour the code already had: before the scan's row was read again after its copy, the failed write
  // that followed removed the folder the same way. The copy is made where the delete lands, as rendering is above.
  it("leaves no visitor copy of a 3D scan behind", async () => {
    const { id, folder } = await stage("scan.glb", "original.glb");
    await db.photo.update({ where: { id }, data: { kind: "SCAN", mimeType: "model/gltf-binary", scanFormat: "GLB" } });
    meanwhile.run = () => deletedForGood(id);
    await processPhoto({ photoId: id });
    expect(existsSync(folder)).toBe(false);
  });

  it("still keeps the files of one that was not deleted", async () => {
    const { id, folder } = await stage("photo-with-gps.jpg", "original.jpg");
    await processPhoto({ photoId: id });
    expect(existsSync(path.join(folder, "medium.webp"))).toBe(true);
    expect((await db.photo.findUniqueOrThrow({ where: { id } })).status).toBe("READY");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "trash-pending-"));
process.env.PHOTO_STORAGE_ROOT = photoRoot;
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/viewer", () => ({ requireAdminOrThrow: async () => ({ id: "a", role: "ADMIN" }) }));
const queued = vi.hoisted(() => [] as { storageKey: string }[]);
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (_q: string, data: { storageKey: string }) => void queued.push(data) }));

import { deleteFromTrash } from "@/app/admin/trash/actions";
import { deletePhoto } from "@/lib/jobs/handlers/delete-photo";

/** A Google Photos item whose download failed has no file, only the "pending" placeholder for a key. */
describe("deleting a failed Picker item for good", () => {
  beforeEach(async () => {
    await resetTestDb();
    queued.length = 0;
  });

  it("removes its own empty folder rather than asking to delete the placeholder", async () => {
    const uploaderId = (await db.user.create({ data: { email: "p@example.com" } })).id;
    const row = await db.photo.create({ data: { uploaderId, sourceKind: "GOOGLE_PICKER", status: "FAILED", originalName: "p.jpg", mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 0, trashedAt: new Date() } });
    // What a download that failed part-way leaves: the item's folder, with nothing in it.
    mkdirSync(path.join(photoRoot, "photos", row.id), { recursive: true });
    expect(await deleteFromTrash([row.id])).toBe(1);
    expect(queued).toEqual([{ storageKey: `photos/${row.id}` }]);
    for (const job of queued) await deletePhoto(job);
    expect(existsSync(path.join(photoRoot, "photos", row.id))).toBe(false);
  });
});

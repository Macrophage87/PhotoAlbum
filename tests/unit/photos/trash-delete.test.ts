import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const queued = vi.hoisted(() => [] as { queue: string; data: unknown }[]);
vi.mock("@/lib/auth/viewer", () => ({ requireAdminOrThrow: async () => ({ id: "admin", role: "ADMIN" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown) => void queued.push({ queue, data }) }));

import { deleteFromTrash } from "@/app/admin/trash/actions";

describe("deleting for good from the trash", () => {
  let uploaderId: string;
  const photo = (name: string, data: Record<string, unknown> = {}) =>
    db.photo.create({ data: { uploaderId, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", ...data } });

  beforeEach(async () => {
    await resetTestDb();
    queued.length = 0;
    uploaderId = (await db.user.create({ data: { email: "a@example.com", role: "ADMIN" } })).id;
  });

  it("deletes only what is still in the trash when it runs, and only those files", async () => {
    const trashed = await photo("gone", { trashedAt: new Date() });
    const collection = await db.collection.create({ data: { slug: "c", title: "C", createdById: uploaderId } });
    await db.collectionItem.create({ data: { collectionId: collection.id, photoId: trashed.id, addedById: uploaderId } });
    // Put in the trash when the page was drawn, restored by somebody else before the click.
    const restored = await photo("back");
    const never = await photo("never");
    expect(await deleteFromTrash([trashed.id, restored.id, never.id])).toBe(1);
    expect(await db.photo.findMany({ select: { id: true }, orderBy: { originalName: "asc" } })).toEqual([{ id: restored.id }, { id: never.id }]);
    expect(queued).toEqual([{ queue: "delete-photo", data: { storageKey: "gone" } }]);
    expect(await db.collectionItem.count()).toBe(0);
  });
});

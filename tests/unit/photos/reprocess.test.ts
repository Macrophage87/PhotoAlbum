import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "" }));
const enqueued = vi.hoisted(() => [] as { queue: string; data: unknown }[]);
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "me@example.com", name: null, role: "MEMBER" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown) => { enqueued.push({ queue, data }); } }));

import { reprocessPhoto } from "@/app/photos/[id]/actions";

/** Re-process sends each kind back through what made it (#42). */
describe("the Re-process button", () => {
  beforeEach(async () => {
    await resetTestDb();
    enqueued.length = 0;
    who.id = (await db.user.create({ data: { email: "me@example.com" } })).id;
  });
  const item = (kind: "PHOTO" | "VIDEO" | "EXTERNAL_VIDEO") =>
    db.photo.create({ data: { uploaderId: who.id, kind, originalName: "x", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o", sizeBytes: 1, status: "READY" }, select: { id: true } });

  it("transcodes a clip again rather than running sharp over it", async () => {
    const clip = await item("VIDEO");
    await reprocessPhoto(clip.id);
    expect(enqueued).toEqual([{ queue: "transcode-video", data: { photoId: clip.id, tripId: null } }]);
  });

  it("only re-renders an embedded video's poster, and fully re-processes a photo", async () => {
    const poster = await item("EXTERNAL_VIDEO");
    const photo = await item("PHOTO");
    await reprocessPhoto(poster.id);
    await reprocessPhoto(photo.id);
    expect(enqueued).toEqual([
      { queue: "process-photo", data: { photoId: poster.id, mode: "renditions" } },
      { queue: "process-photo", data: { photoId: photo.id, tripId: null } },
    ]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "" }));
const enqueued = vi.hoisted(() => [] as { queue: string; data: unknown; opts?: unknown }[]);
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "me@example.com", name: null, role: "MEMBER" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown, opts?: unknown) => { enqueued.push({ queue, data, ...(opts ? { opts } : {}) }); } }));

import { reprocessPhoto } from "@/app/photos/[id]/actions";
import { reannotate } from "@/app/annotation/actions";
vi.mock("@/lib/annotation/eligibility", () => ({ annotationGates: async () => ({ active: true, model: "m" }) }));

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
    expect(enqueued).toEqual([{ queue: "transcode-video", data: { photoId: clip.id, tripId: null }, opts: { singletonKey: `transcode:${clip.id}` } }]);
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

  it("asks the helper to replace the family's description only when the member confirmed it (#43)", async () => {
    const p = await item("PHOTO");
    await reannotate(p.id);
    await reannotate(p.id, true);
    // A form posting to the action hands it FormData, which is never taken as a yes.
    await (reannotate as unknown as (id: string, fd: FormData) => Promise<void>)(p.id, new FormData());
    expect(enqueued.map((e) => e.data)).toEqual([{ photoId: p.id }, { photoId: p.id, replace: true }, { photoId: p.id }]);
  });
});

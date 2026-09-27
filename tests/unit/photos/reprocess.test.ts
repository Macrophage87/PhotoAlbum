import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { publicScanKey, withheldScanKey } from "@/lib/scans/public-copy";
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

  it("makes a scan's visitor copy, or its refusal, again from the file", async () => {
    const scan = { storageKey: "reprocess-test/scan", originalPath: "reprocess-test/scan/original.glb", scanFormat: "GLB" };
    const { id } = await db.photo.create({ data: { uploaderId: who.id, kind: "SCAN", ...scan, originalName: "x.glb", mimeType: "model/gltf-binary", sizeBytes: 1, status: "READY" }, select: { id: true } });
    const store = storage();
    await store.putBuffer(scan.originalPath, Buffer.from("glb"));
    await store.putBuffer(publicScanKey(scan), Buffer.from("copy"));
    await store.putBuffer(withheldScanKey(scan), Buffer.from("{}"));
    await store.putBuffer("reprocess-test/scan/model-public.glb", Buffer.from("older copy"));
    await reprocessPhoto(id);
    for (const key of [publicScanKey(scan), withheldScanKey(scan), "reprocess-test/scan/model-public.glb"]) expect(await store.exists(key), key).toBe(false);
    expect(await store.exists(scan.originalPath)).toBe(true);
    expect(enqueued).toEqual([{ queue: "process-photo", data: { photoId: id, tripId: null } }]);
    await store.deletePrefix("reprocess-test/scan");
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

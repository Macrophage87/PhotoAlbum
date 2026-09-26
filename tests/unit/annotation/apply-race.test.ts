import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const enqueued = vi.hoisted(() => [] as { queue: string; data: unknown; opts: { singletonKey?: string } | undefined }[]);
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown, opts?: { singletonKey?: string }) => void enqueued.push({ queue, data, opts }) }));

/**
 * Something a member does between the moment `applyAnnotation` reads the item and the moment it writes the answer.
 * The judgement of the answer's words sits exactly there, so it stands in for "meanwhile".
 */
const meanwhile = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock("@/lib/annotation/members-only", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/annotation/members-only")>();
  return {
    ...real,
    judgeHelperText: async (...args: Parameters<typeof real.judgeHelperText>) => {
      const run = meanwhile.run;
      meanwhile.run = null;
      if (run) await run();
      return real.judgeHelperText(...args);
    },
  };
});

import { annotationSchema, toStored } from "@/lib/annotation/schema";
import { applyAnnotation } from "@/lib/annotation/apply";

const fixture = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/annotation-response.json"), "utf8"));
const answer = annotationSchema.parse({ ...fixture, caption: "A fresh caption from the helper" });

/** A member's edit made while an answer was being judged is not written over by it. */
describe("an answer that arrives after a member edited the text", () => {
  let photoId: string;
  const photo = () => db.photo.findUniqueOrThrow({ where: { id: photoId } });
  // What `updateAnnotation` writes.
  const edit = () => db.photo.update({ where: { id: photoId }, data: { annotation: { ...toStored(annotationSchema.parse(fixture)), caption: "Grandma's own words" }, annotationSource: "EDITED" } });
  beforeEach(async () => {
    await resetTestDb();
    meanwhile.run = null;
    enqueued.length = 0;
    const user = await db.user.create({ data: { email: "a@example.com" } });
    photoId = (await db.photo.create({ data: { uploaderId: user.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", annotation: toStored(annotationSchema.parse(fixture)), annotationSource: "MACHINE", annotatedAt: null } })).id;
  });

  it("stores the answer when nothing happened in between", async () => {
    await applyAnnotation(photoId, "claude-opus-5", answer, {});
    expect(await photo()).toMatchObject({ annotationSource: "MACHINE", annotation: expect.objectContaining({ caption: "A fresh caption from the helper" }) });
  });

  it("keeps the member's words and asks again, rather than writing over them", async () => {
    meanwhile.run = async () => void (await edit());
    await applyAnnotation(photoId, "claude-opus-5", answer, {});
    const p = await photo();
    expect(p.annotationSource).toBe("EDITED");
    expect((p.annotation as { caption: string }).caption).toBe("Grandma's own words");
    expect(p.annotatedAt).toBeNull();
    expect(await db.mediaAnnotationRaw.count({ where: { photoId } })).toBe(0);
    expect(enqueued.filter((e) => e.queue === "annotate-photo")).toEqual([{ queue: "annotate-photo", data: { photoId }, opts: expect.objectContaining({ singletonKey: `annotate:${photoId}` }) }]);
  });

  it("does not turn a \"replace ours\" into a replacement of words written after it was asked", async () => {
    meanwhile.run = async () => void (await edit());
    await applyAnnotation(photoId, "claude-opus-5", answer, {}, { replaceEdited: true });
    expect((await photo()).annotationSource).toBe("EDITED");
    expect(enqueued.filter((e) => e.queue === "annotate-photo")).toEqual([{ queue: "annotate-photo", data: { photoId }, opts: expect.objectContaining({ singletonKey: `annotate:${photoId}` }) }]);
  });
});

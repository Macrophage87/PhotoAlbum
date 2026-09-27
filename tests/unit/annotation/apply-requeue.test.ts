import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const enqueued = vi.hoisted(() => [] as { queue: string; data: unknown; opts: { singletonKey?: string } | undefined }[]);
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown, opts?: { singletonKey?: string }) => void enqueued.push({ queue, data, opts }) }));

import { annotationSchema } from "@/lib/annotation/schema";
import { applyAnnotation } from "@/lib/annotation/apply";

const fixture = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/annotation-response.json"), "utf8"));
const answer = annotationSchema.parse(fixture);

/** An answer thrown away because names changed meanwhile is asked for again the way it was asked for the first time. */
describe("asking again after a stale answer", () => {
  let photoId: string;
  const requestedAt = new Date(Date.now() - 60_000);
  const again = () => enqueued.filter((e) => e.queue === "annotate-photo");
  beforeEach(async () => {
    await resetTestDb();
    enqueued.length = 0;
    const user = await db.user.create({ data: { email: "a@example.com" } });
    // A forgotten name was taken out of the item after the request was built: the answer may name them again.
    photoId = (await db.photo.create({ data: { uploaderId: user.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", namesScrubbedAt: new Date() } })).id;
  });

  it("keeps a member's \"replace ours\" when it asks again", async () => {
    await applyAnnotation(photoId, "claude-opus-5", answer, {}, { requestedAt, replaceEdited: true });
    expect(again()).toEqual([{ queue: "annotate-photo", data: { photoId, replace: true }, opts: expect.objectContaining({ singletonKey: `annotate-replace:${photoId}` }) }]);
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).annotatedAt).toBeNull();
  });

  it("asks an ordinary pass again as an ordinary pass", async () => {
    await applyAnnotation(photoId, "claude-opus-5", answer, {}, { requestedAt });
    expect(again()).toEqual([{ queue: "annotate-photo", data: { photoId }, opts: expect.objectContaining({ singletonKey: `annotate:${photoId}` }) }]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Follow-up jobs after an edit are debounced, not throttled: pg-boss keeps a finished job in its singleton slot, so a
 * plain throttle silently drops a second edit made within the minute and leaves faces, animals and the embedding on
 * the superseded rendition.
 */
vi.hoisted(() => {
  process.env.ML_URL = "http://ml.test";
  process.env.ML_TOKEN = "t";
  process.env.PET_MATCHING_ENABLED = "true";
  process.env.FACE_INDEXING_ENABLED = "true";
});
const sent = vi.hoisted(() => [] as { queue: string; data: unknown; options: Record<string, unknown> }[]);
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown, options: Record<string, unknown>) => { sent.push({ queue, data, options }); } }));

import { db } from "@/lib/db";
import { enqueueEmbedding } from "@/lib/jobs/handlers/embed-photo";
import { enqueueFaceDetection } from "@/lib/jobs/handlers/detect-faces";
import { enqueueAnimalDetection } from "@/lib/jobs/handlers/detect-animals";
import { resetTestDb } from "../helpers/reset";

describe("follow-up jobs after an edit", () => {
  beforeEach(async () => {
    await resetTestDb();
    sent.length = 0;
    const admin = await db.user.create({ data: { email: "f@example.com", role: "ADMIN" } });
    await db.appSetting.create({ data: { id: "app", faceDetectionOptInAt: new Date(), faceDetectionOptInById: admin.id } });
  });

  it("defer a repeat within the minute to the next slot instead of dropping it", async () => {
    await enqueueEmbedding("p1");
    await enqueueEmbedding("p1", true);
    await enqueueFaceDetection("p1");
    await enqueueAnimalDetection("p1");
    expect(sent.map((s) => s.queue)).toEqual(["embed-photo", "embed-photo", "detect-faces", "detect-animals"]);
    for (const s of sent) expect(s.options).toMatchObject({ singletonSeconds: 60, singletonNextSlot: true });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueued: string[] = [];
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (_q: string, data: { photoId: string }) => { enqueued.push(data.photoId); } }));
// env() is parsed once at first use, so the gates must be set before any module reads it.
vi.hoisted(() => {
  process.env.ANNOTATION_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "sk-test";
});

import { db } from "@/lib/db";
import { annotationSweep } from "@/lib/jobs/handlers/annotation-sweep";
import { applyAnnotation } from "@/lib/annotation/apply";
import { annotationSchema } from "@/lib/annotation/schema";
import { forgetPerson } from "@/lib/people/forget-person";
import { resetTestDb } from "../helpers/reset";

describe("the annotation sweep", () => {
  beforeEach(async () => {
    await resetTestDb();
    enqueued.length = 0;
    const admin = await db.user.create({ data: { email: "s@example.com", role: "ADMIN" } });
    await db.appSetting.create({ data: { id: "app", annotationOptInAt: new Date(), annotationOptInById: admin.id } });
  });

  it("skips an item whose only opt-out is on its trip, and sends its neighbor", async () => {
    const admin = await db.user.findFirstOrThrow();
    const quiet = await db.trip.create({ data: { slug: "q", title: "Quiet", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), annotationOptOut: true, createdById: admin.id } });
    const loud = await db.trip.create({ data: { slug: "l", title: "Loud", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: admin.id } });
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    const base = { uploaderId: admin.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const };
    const skipped = await db.photo.create({ data: { ...base, tripId: quiet.id } });
    const sent = await db.photo.create({ data: { ...base, tripId: loud.id } });
    await db.$executeRaw`UPDATE "Photo" SET "updatedAt" = ${old}`;
    const n = await annotationSweep();
    expect(n).toBe(1);
    expect(enqueued).toEqual([sent.id]);
    expect(enqueued).not.toContain(skipped.id);
  });

  it("leaves a batch-failed item for the next backfill unless its notes were edited since", async () => {
    const admin = await db.user.findFirstOrThrow();
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    const base = { uploaderId: admin.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const };
    const waiting = await db.photo.create({ data: { ...base, annotationError: "batch:expired" } });
    const edited = await db.photo.create({ data: { ...base, annotationError: "batch:expired" } });
    await db.$executeRaw`UPDATE "Photo" SET "updatedAt" = ${old}`;
    // Editing notes (setContext / updatePhoto) clears the flag; the sweep then treats the item like any other.
    await db.photo.update({ where: { id: edited.id }, data: { context: "Sam at the lake", contextUpdatedAt: new Date(), annotationError: null } });
    await db.$executeRaw`UPDATE "Photo" SET "updatedAt" = ${old}`;
    await annotationSweep();
    expect(enqueued).toContain(edited.id);
    expect(enqueued).not.toContain(waiting.id);
  });

  it("leaves a backfill's item whose answer a forget since threw away for the next backfill (the forget review's A)", async () => {
    const admin = await db.user.findFirstOrThrow();
    const base = { uploaderId: admin.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const };
    const asked = new Date(Date.now() - 60_000);
    const batched = await db.photo.create({ data: base });
    const single = await db.photo.create({ data: base });
    const ada = await db.person.create({ data: { name: "Ada Byron", createdById: admin.id } });
    await forgetPerson(ada.id, { keepName: false, byUserId: admin.id });
    const answer = annotationSchema.parse({ title: "", caption: "A lake", description: "", tags: [], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "", estimatedYear: null, estimatedPlace: null });
    await applyAnnotation(batched.id, "m", answer, { content: [], batched: true }, { requestedAt: asked });
    expect((await db.photo.findUniqueOrThrow({ where: { id: batched.id } })).annotationError).toBe("batch:names_changed");
    // The sweep's own filter: the backfill's item waits for the next backfill; one asked for alone is asked again.
    enqueued.length = 0;
    await db.$executeRaw`UPDATE "Photo" SET "updatedAt" = ${new Date(Date.now() - 2 * 60 * 60_000)}`;
    await annotationSweep();
    expect(enqueued).toContain(single.id);
    expect(enqueued).not.toContain(batched.id);
  });
});

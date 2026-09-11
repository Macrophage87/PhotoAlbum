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
import { resetTestDb } from "../helpers/reset";

describe("the annotation sweep", () => {
  beforeEach(async () => {
    await resetTestDb();
    enqueued.length = 0;
    const admin = await db.user.create({ data: { email: "s@example.com", role: "ADMIN" } });
    await db.appSetting.create({ data: { id: "app", annotationOptInAt: new Date(), annotationOptInById: admin.id } });
  });

  it("skips an item whose only opt-out is on its trip, and sends its neighbour", async () => {
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
});

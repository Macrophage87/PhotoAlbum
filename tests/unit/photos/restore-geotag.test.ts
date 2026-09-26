import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const enqueued = vi.hoisted(() => [] as { queue: string; data: unknown }[]);
vi.mock("@/lib/auth/viewer", () => ({ requireAdminOrThrow: async () => ({ id: "a", role: "ADMIN" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown) => { enqueued.push({ queue, data }); } }));

import { restoreFromTrash } from "@/app/admin/trash/actions";
import { QUEUES } from "@/lib/jobs/queues";

describe("restoring from the trash", () => {
  beforeEach(async () => { await resetTestDb(); enqueued.length = 0; });

  it("asks for the trip's photos to be placed again, since a track may have gone while they were away", async () => {
    const user = await db.user.create({ data: { email: "r@example.com", role: "ADMIN" } });
    const trip = await db.trip.create({ data: { slug: "r", title: "R", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id } });
    const base = { uploaderId: user.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const, trashedAt: new Date() };
    const a = await db.photo.create({ data: { ...base, tripId: trip.id } });
    const b = await db.photo.create({ data: { ...base, tripId: trip.id } });
    const loose = await db.photo.create({ data: base });
    expect(await restoreFromTrash([a.id, b.id, loose.id])).toBe(3);
    expect(enqueued.map((e) => [e.queue, e.data])).toEqual([[QUEUES.geotagPhotos, { tripId: trip.id }]]);
  });
});

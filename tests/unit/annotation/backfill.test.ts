import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The backfill state machine against a real database, with the Anthropic client and request building replaced:
 * chunk rows, cancel semantics, the error path, the stale-placeholder sweep and result handling.
 */
vi.hoisted(() => {
  process.env.ANNOTATION_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "sk-test";
});
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

const api = vi.hoisted(() => ({
  created: [] as { id: string; n: number }[],
  cancelled: [] as string[],
  createBehaviour: [] as (("ok" | "throw"))[],
  results: new Map<string, { custom_id: string; result: { type: string; message?: unknown } }[]>(),
  counter: 0,
}));
vi.mock("@/lib/annotation/client", () => ({
  anthropic: () => ({
    messages: {
      batches: {
        create: async (body: { requests: unknown[] }) => {
          const behaviour = api.createBehaviour.shift() ?? "ok";
          if (behaviour === "throw") throw new Error("upload failed");
          const id = `msgbatch_${++api.counter}`;
          api.created.push({ id, n: body.requests.length });
          return { id };
        },
        cancel: async (id: string) => { api.cancelled.push(id); },
        retrieve: async () => ({ processing_status: "ended", request_counts: { canceled: 0 } }),
        results: async (id: string) => (async function* () { for (const r of api.results.get(id) ?? []) yield r; })(),
      },
    },
  }),
  thinkingParams: () => ({}),
}));
vi.mock("@/lib/annotation/request", () => ({
  loadItem: async (id: string) => ({ id }),
  buildRequest: async (item: { id: string }) => ({ model: "m", max_tokens: 1, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/webp", data: "A".repeat(10) } }, { type: "text", text: item.id }] }] }),
}));

import { db } from "@/lib/db";
import { annotationBackfill, annotationBatchPoll, BATCH_CHUNK, familyCancelled } from "@/lib/jobs/handlers/annotation-batch";
import { resetTestDb } from "../helpers/reset";

async function seed(count: number) {
  const admin = await db.user.create({ data: { email: "b@example.com", role: "ADMIN" } });
  await db.appSetting.create({ data: { id: "app", annotationOptInAt: new Date(), annotationOptInById: admin.id } });
  const base = { uploaderId: admin.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const };
  await db.photo.createMany({ data: Array.from({ length: count }, () => base) });
  const origin = await db.annotationBatch.create({ data: { anthropicBatchId: `pending-x`, scope: { kind: "all" }, requested: 0, createdById: admin.id } });
  await db.annotationBatch.update({ where: { id: origin.id }, data: { anthropicBatchId: `pending-${origin.id}` } });
  return origin.id;
}
const family = (originId: string) => db.annotationBatch.findMany({ where: { OR: [{ id: originId }, { parentId: originId }] }, orderBy: { createdAt: "asc" } });

describe("the backfill run", () => {
  beforeEach(async () => {
    await resetTestDb();
    api.created.length = 0;
    api.cancelled.length = 0;
    api.createBehaviour.length = 0;
    api.results.clear();
    api.counter = 0;
  });

  it("submits chunks as a family, stamps the run's start and end, and keeps counts once per part", async () => {
    const originId = await seed(BATCH_CHUNK + 5);
    await annotationBackfill({ batchId: originId });
    const rows = await family(originId);
    expect(rows.map((r) => r.requested)).toEqual([BATCH_CHUNK, 5]);
    expect(rows[1].parentId).toBe(originId);
    expect(rows[0].startedAt).not.toBeNull();
    expect(rows[0].runEndedAt).not.toBeNull();
    expect(api.created.map((c) => c.n)).toEqual([BATCH_CHUNK, 5]);
  });

  it("stops before the next chunk once the origin carries a cancel request", async () => {
    const originId = await seed(BATCH_CHUNK + 5);
    await db.annotationBatch.update({ where: { id: originId }, data: { cancelRequestedAt: new Date() } });
    expect(await familyCancelled(originId)).toBe(true);
    await annotationBackfill({ batchId: originId });
    expect(api.created).toEqual([]);
    expect((await db.annotationBatch.findUniqueOrThrow({ where: { id: originId } })).runEndedAt).not.toBeNull();
  });

  it("fails a placeholder in place when the first upload throws, but never a live row", async () => {
    const originId = await seed(BATCH_CHUNK + 5);
    api.createBehaviour.push("ok", "throw");
    await annotationBackfill({ batchId: originId });
    const rows = await family(originId);
    // The first chunk's row is live and untouched; the second placeholder is failed in place.
    expect(rows[0].status).toBe("SUBMITTED");
    expect(rows[0].anthropicBatchId).toBe("msgbatch_1");
    expect(rows[1].status).toBe("FAILED");
    expect(rows[1].anthropicBatchId.startsWith("pending-")).toBe(true);
    expect(rows[0].runEndedAt).not.toBeNull();

    const originId2 = await (async () => { await resetTestDb(); return seed(3); })();
    api.createBehaviour.push("throw");
    await annotationBackfill({ batchId: originId2 });
    const only = await family(originId2);
    expect(only).toHaveLength(1);
    expect(only[0].status).toBe("FAILED");
  });

  it("records a cut-short run when pg-boss re-delivers it after a worker restart", async () => {
    const originId = await seed(3);
    await db.annotationBatch.update({ where: { id: originId }, data: { anthropicBatchId: "msgbatch_old" } });
    await annotationBackfill({ batchId: originId });
    const rows = await family(originId);
    expect(rows[0].runEndedAt).not.toBeNull();
    expect(rows[1].anthropicBatchId).toBe(`failed-${originId}-retry`);
    expect(rows[1].status).toBe("FAILED");
  });

  it("applies results, counting cancelled requests apart from failures, and ends the family's run for stale placeholders", async () => {
    const originId = await seed(3);
    await annotationBackfill({ batchId: originId });
    const [row] = await family(originId);
    const ids = (await db.photo.findMany({ select: { id: true } })).map((p) => p.id);
    api.results.set(row.anthropicBatchId, [
      { custom_id: ids[0], result: { type: "errored" } },
      { custom_id: ids[1], result: { type: "canceled" } },
      { custom_id: ids[2], result: { type: "expired" } },
    ]);
    // A dead run's placeholder: started long ago, still pending.
    const stale = await db.annotationBatch.create({ data: { anthropicBatchId: "pending-stale", scope: { kind: "all" }, requested: 0, createdById: row.createdById, startedAt: new Date(Date.now() - 2 * 3_600_000) } });
    await db.annotationBatch.create({ data: { anthropicBatchId: `pending-${stale.id}-1`, parentId: stale.id, scope: { kind: "all" }, requested: 0, createdById: row.createdById, createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    await annotationBatchPoll();
    const done = await db.annotationBatch.findUniqueOrThrow({ where: { id: row.id } });
    expect(done.status).toBe("ENDED");
    expect(done.errored).toBe(2);
    expect(done.canceled).toBe(1);
    const photos = await db.photo.findMany({ where: { id: { in: ids } }, select: { annotationError: true, annotatedAt: true } });
    expect(photos.every((p) => p.annotatedAt === null && p.annotationError?.startsWith("batch:"))).toBe(true);
    const staleRows = await family(stale.id);
    expect(staleRows.every((r) => r.status === "FAILED")).toBe(true);
    expect(staleRows[0].runEndedAt).not.toBeNull();
  });
});

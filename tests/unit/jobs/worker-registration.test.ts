import { beforeAll, describe, expect, it, vi } from "vitest";

/** What the worker asks of pg-boss: the stale-item sweep on a schedule, and heartbeats and signals for heavy work. */
const fake = vi.hoisted(() => ({
  work: [] as { queue: string; options: Record<string, unknown>; handler: () => Promise<unknown> }[],
  schedules: [] as { queue: string; cron: string }[],
}));
vi.mock("@/lib/jobs/boss", async (orig) => ({
  ...((await orig()) as object),
  // What the worker queues as it starts (the members-only sweep) goes nowhere: the real queue is never started here,
  // and its schema must not appear in the test database (see requeue.test.ts).
  enqueue: async () => null,
  getBoss: async () => ({
    work: async (queue: string, options: Record<string, unknown>, handler: () => Promise<unknown>) => { fake.work.push({ queue, options, handler }); },
    schedule: async (queue: string, cron: string) => { fake.schedules.push({ queue, cron }); },
  }),
}));

const requeued = vi.hoisted(() => ({ runs: 0 }));
vi.mock("@/lib/media/requeue", async (orig) => ({ ...((await orig()) as object), requeueStuckPending: async () => (requeued.runs++, 0) }));

// The two slow start-up passes never finish here: registration must not wait for them.
vi.mock("@/lib/people/forget", async (orig) => ({ ...((await orig()) as object), scrubWithdrawnNames: () => new Promise(() => {}) }));
vi.mock("@/lib/people/forget-person", async (orig) => ({ ...((await orig()) as object), completePendingForgets: () => new Promise(() => {}) }));
vi.mock("@/lib/people/names-changed", async (orig) => ({ ...((await orig()) as object), withNamePassesLock: async (fn: () => Promise<void>) => (await fn(), true) }));

import { startWorker } from "@/lib/jobs/worker";
import { HEAVY_HEARTBEAT_REFRESH_SECONDS, HEAVY_HEARTBEAT_SECONDS, HEAVY_QUEUES, LONG_QUEUES, queueOptions } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";

describe("the worker's registration", () => {
  beforeAll(async () => {
    await startWorker();
  });

  it("reconciles stale items every quarter hour, not only at startup", async () => {
    expect(fake.work.map((w) => w.queue)).toContain(QUEUES.reconcilePhotos);
    expect(fake.schedules).toContainEqual({ queue: QUEUES.reconcilePhotos, cron: "*/15 * * * *" });
    // Every queue that has a schedule also has a handler.
    for (const s of fake.schedules) expect(fake.work.map((w) => w.queue)).toContain(s.queue);
  });

  it("queues again, on that quarter-hourly run, photos left waiting with no job", async () => {
    await fake.work.find((w) => w.queue === QUEUES.reconcilePhotos)!.handler();
    expect(requeued.runs).toBe(1);
  });

  it("registers every schedule without waiting for the slow start-up passes, and no two nightly jobs share a minute", async () => {
    expect(fake.schedules.map((s) => s.queue)).toEqual(expect.arrayContaining([QUEUES.sweepStrandedUploads, QUEUES.reconcilePhotos]));
    const nightly = fake.schedules.filter((s) => /^\d+ \d+ \* \* \*$/.test(s.cron)).map((s) => s.cron);
    expect(new Set(nightly).size).toBe(nightly.length);
  });

  it("refreshes heavy jobs' heartbeats often enough for the queue's heartbeat window", async () => {
    for (const q of HEAVY_QUEUES) {
      expect(queueOptions(q).heartbeatSeconds).toBe(HEAVY_HEARTBEAT_SECONDS);
      expect(fake.work.find((w) => w.queue === q)?.options.heartbeatRefreshSeconds).toBe(HEAVY_HEARTBEAT_REFRESH_SECONDS);
    }
    expect(HEAVY_HEARTBEAT_SECONDS / HEAVY_HEARTBEAT_REFRESH_SECONDS).toBeGreaterThanOrEqual(4);
    expect(queueOptions(QUEUES.processPhoto).heartbeatSeconds).toBeUndefined();
  });

  it("keeps the album-wide passes alive by heartbeat, and finishes interrupted removals every quarter hour", async () => {
    for (const q of LONG_QUEUES) {
      expect(queueOptions(q).heartbeatSeconds).toBe(HEAVY_HEARTBEAT_SECONDS);
      expect(fake.work.find((w) => w.queue === q)?.options.heartbeatRefreshSeconds).toBe(HEAVY_HEARTBEAT_REFRESH_SECONDS);
    }
    expect(fake.schedules.find((s) => s.queue === QUEUES.finishRemovals)?.cron).toMatch(/\/15 \* \* \* \*$/);
  });
});

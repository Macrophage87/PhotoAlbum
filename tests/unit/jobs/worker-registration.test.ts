import { beforeAll, describe, expect, it, vi } from "vitest";

/** What the worker asks of pg-boss: the stale-item sweep on a schedule, and heartbeats and signals for heavy work. */
const fake = vi.hoisted(() => ({
  work: [] as { queue: string; options: Record<string, unknown> }[],
  schedules: [] as { queue: string; cron: string }[],
}));
vi.mock("@/lib/jobs/boss", async (orig) => ({
  ...((await orig()) as object),
  getBoss: async () => ({
    work: async (queue: string, options: Record<string, unknown>) => { fake.work.push({ queue, options }); },
    schedule: async (queue: string, cron: string) => { fake.schedules.push({ queue, cron }); },
  }),
}));

import { startWorker } from "@/lib/jobs/worker";
import { HEAVY_HEARTBEAT_REFRESH_SECONDS, HEAVY_HEARTBEAT_SECONDS, HEAVY_QUEUES, queueOptions } from "@/lib/jobs/boss";
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

  it("refreshes heavy jobs' heartbeats often enough for the queue's heartbeat window", async () => {
    for (const q of HEAVY_QUEUES) {
      expect(queueOptions(q).heartbeatSeconds).toBe(HEAVY_HEARTBEAT_SECONDS);
      expect(fake.work.find((w) => w.queue === q)?.options.heartbeatRefreshSeconds).toBe(HEAVY_HEARTBEAT_REFRESH_SECONDS);
    }
    expect(HEAVY_HEARTBEAT_SECONDS / HEAVY_HEARTBEAT_REFRESH_SECONDS).toBeGreaterThanOrEqual(4);
    expect(queueOptions(QUEUES.processPhoto).heartbeatSeconds).toBeUndefined();
  });
});

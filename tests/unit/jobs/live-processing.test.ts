import { describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";

import { PgBoss } from "pg-boss";
import { hasLiveProcessingJob, withLiveProcessingJob } from "@/lib/jobs/live";
import { QUEUES } from "@/lib/jobs/queues";

// A real queue in a schema of this run's own (see bossSchema), dropped afterwards.
const SCHEMA = vi.hoisted(() => {
  const schema = `pgboss_unit_live_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  process.env.PGBOSS_SCHEMA = schema;
  return schema;
});

describe("which photos a processing job still names", () => {
  it("counts waiting jobs on either queue, and not finished ones, on a real queue", async () => {
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema: SCHEMA, supervise: false, schedule: false });
    try {
      await boss.start();
      await boss.createQueue(QUEUES.processPhoto);
      await boss.createQueue(QUEUES.transcodeVideo);
      // One that has finished names nobody still waiting.
      await boss.send(QUEUES.processPhoto, { photoId: "done" });
      const [done] = await boss.fetch(QUEUES.processPhoto);
      await boss.complete(QUEUES.processPhoto, done.id);
      await boss.send(QUEUES.processPhoto, { photoId: "photo" });
      await boss.send(QUEUES.transcodeVideo, { photoId: "clip" });
      expect([...(await withLiveProcessingJob(["photo", "clip", "done", "none"]))].sort()).toEqual(["clip", "photo"]);
      // The single check agrees.
      expect(await hasLiveProcessingJob("clip")).toBe(true);
      expect(await hasLiveProcessingJob("done")).toBe(false);
    } finally {
      await boss.stop({ graceful: false });
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    }
  });
});

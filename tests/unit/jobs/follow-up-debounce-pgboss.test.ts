import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PgBoss } from "pg-boss";

/**
 * The same debounce against a real pg-boss in the test database: a job that already ran in this minute's slot must
 * not swallow a second edit. Uses its own schema so nothing else in the suite sees these queues.
 */
vi.hoisted(() => {
  process.env.ML_URL = "http://ml.test";
  process.env.ML_TOKEN = "t";
});
const real = vi.hoisted(() => ({ boss: null as unknown as import("pg-boss").PgBoss }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: (queue: string, data: object, options: object) => real.boss.send(queue, data, options) }));

import { enqueueEmbedding } from "@/lib/jobs/handlers/embed-photo";
import { QUEUES } from "@/lib/jobs/queues";
import { db } from "@/lib/db";

// One schema per run, dropped afterwards, so an interrupted run never leaves jobs behind for the next.
const SCHEMA = `pgboss_unit_debounce_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

describe("follow-up jobs on a real queue", () => {
  beforeAll(async () => {
    real.boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema: SCHEMA, supervise: false, schedule: false });
    await real.boss.start();
    await real.boss.createQueue(QUEUES.embedPhoto);
  });
  afterAll(async () => {
    await real.boss.stop({ graceful: false });
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  });

  it("queues a re-run after one that already finished in the same minute, and folds a third request into it", async () => {
    // Keep all three sends inside one 60-second slot.
    const intoSlot = Date.now() % 60_000;
    if (intoSlot > 50_000) await new Promise((r) => setTimeout(r, 61_000 - intoSlot));
    await enqueueEmbedding("photo-1");
    const [first] = await real.boss.fetch(QUEUES.embedPhoto);
    expect(first).toBeDefined();
    await real.boss.complete(QUEUES.embedPhoto, first.id);
    // The member straightens the photo a few seconds later: its renditions change again.
    await enqueueEmbedding("photo-1");
    await enqueueEmbedding("photo-1");
    const jobs = await real.boss.findJobs(QUEUES.embedPhoto, { key: "embed:photo-1:i" });
    expect(jobs).toHaveLength(2);
    const rerun = jobs.find((j) => j.id !== first.id)!;
    expect(rerun.state).toBe("created");
    expect(rerun.startAfter.getTime()).toBeGreaterThan(Date.now());
  }, 75_000);
});

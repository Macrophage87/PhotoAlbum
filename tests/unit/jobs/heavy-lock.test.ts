import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";

import { withHeavyLock } from "@/lib/jobs/heavy-lock";
import { HEAVY_JOB_EXPIRE_SECONDS, JOB_EXPIRE_SECONDS, queueOptions } from "@/lib/jobs/boss";
import { ffmpeg, FFMPEG_TIMEOUT_MS } from "@/lib/video/ffmpeg";
import { QUEUES } from "@/lib/jobs/queues";

/**
 * pg-boss fires a job's signal when it times the job out and then retries it. A timed-out heavy job must stop, not
 * run beside its retry.
 */
describe("the heavy-work lock", () => {
  it("lets a job that timed out while waiting give up, without letting the next one jump the queue", async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const a = withHeavyLock(() => new Promise<void>((r) => (releaseA = () => { order.push("a"); r(); })));
    const ac = new AbortController();
    const ranB = vi.fn();
    const b = withHeavyLock(async () => ranB(), ac.signal);
    const c = withHeavyLock(async () => { order.push("c"); });
    ac.abort(new Error("timed out"));
    await expect(b).rejects.toThrow("timed out");
    // c is still behind a, which has not finished.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    releaseA();
    await Promise.all([a, c]);
    expect(order).toEqual(["a", "c"]);
    expect(ranB).not.toHaveBeenCalled();
  });

  it("does not start work for a job that has already timed out", async () => {
    const ac = new AbortController();
    ac.abort(new Error("timed out"));
    const ran = vi.fn();
    await expect(withHeavyLock(async () => ran(), ac.signal)).rejects.toThrow("timed out");
    expect(ran).not.toHaveBeenCalled();
    // The lock is free again afterwards.
    await expect(withHeavyLock(async () => 7)).resolves.toBe(7);
  });

  it("gives the heavy queues time for two full ffmpeg runs plus the wait", () => {
    expect(HEAVY_JOB_EXPIRE_SECONDS * 1000).toBeGreaterThan(2 * FFMPEG_TIMEOUT_MS);
    for (const q of [QUEUES.transcodeVideo, QUEUES.embedPhoto, QUEUES.detectFaces, QUEUES.detectAnimals]) expect(queueOptions(q).expireInSeconds).toBe(HEAVY_JOB_EXPIRE_SECONDS);
    expect(queueOptions(QUEUES.processPhoto).expireInSeconds).toBe(JOB_EXPIRE_SECONDS);
  });
});

describe.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0)("ffmpeg under a job's signal", () => {
  it("is killed when the job times out", async () => {
    const ac = new AbortController();
    // Endless silence: only the signal can end it.
    const run = ffmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc", "-f", "null", "-"], ac.signal);
    const started = Date.now();
    setTimeout(() => ac.abort(), 200);
    await expect(run).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

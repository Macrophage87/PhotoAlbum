import { describe, expect, it } from "vitest";
import { withNamePassesLock } from "@/lib/people/names-changed";

describe("the album's own name passes", () => {
  it("run one at a time: a second start while one runs is skipped, not queued, and the lock is freed after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const first = withNamePassesLock(async () => {
      runs++;
      await gate;
    });
    // Wait until the first holds it.
    while (runs === 0) await new Promise((r) => setTimeout(r, 10));
    expect(await withNamePassesLock(async () => void runs++)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await withNamePassesLock(async () => void runs++)).toBe(true);
    expect(runs).toBe(2);
    // A run that fails frees it too.
    await expect(withNamePassesLock(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withNamePassesLock(async () => undefined)).toBe(true);
  });
});

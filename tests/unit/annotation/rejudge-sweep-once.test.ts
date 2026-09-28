import { beforeEach, describe, expect, it, vi } from "vitest";

/** Holds the first sweep still once it has taken its lock, as a sweep over half a million photographs would be. */
const gate = vi.hoisted(() => ({ wait: null as Promise<void> | null, entered: null as (() => void) | null }));
vi.mock("@/lib/annotation/members-only", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/annotation/members-only");
  return {
    ...real,
    knownNameEntries: async (...args: Parameters<typeof real.knownNameEntries>) => {
      if (gate.wait) {
        gate.entered?.();
        await gate.wait;
      }
      return real.knownNameEntries(...args);
    },
  };
});

import { db } from "@/lib/db";
import { MATCHER_VERSION, rejudgeSweep } from "@/lib/annotation/rejudge";
import { LONG_JOB_EXPIRE_SECONDS, queueOptions } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { resetTestDb } from "../helpers/reset";

/**
 * The sweep reads every photograph, about 1.7 ms each, so on a big album it outlasts pg-boss's usual quarter hour.
 * It must never run twice at once — pg-boss starts a retry beside a run it has given up on, and does not stop the
 * first — and it stops by itself once pg-boss has given up on it.
 */
describe("the members-only sweep, one at a time", () => {
  let rex: string;
  beforeEach(async () => {
    gate.wait = gate.entered = null;
    await resetTestDb();
    const dana = await db.user.create({ data: { email: "dana@example.com", name: "Dana", role: "MEMBER" } });
    await db.person.create({ data: { name: "Rex", kind: "PET", createdById: dana.id } });
    rex = (await db.photo.create({ data: { uploaderId: dana.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", annotation: { title: "", caption: "Rex on the rug", description: "", tags: [], searchSummary: "" } } })).id;
  });

  it("skips a second sweep while one is running, and the running one records what it judged", async () => {
    let release!: () => void;
    gate.wait = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (gate.entered = resolve));
    const first = rejudgeSweep();
    await entered;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const second = await rejudgeSweep();
    expect(second).toMatchObject({ photos: 0, missed: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/already running/));
    warn.mockRestore();
    expect(await db.appSetting.findUnique({ where: { id: "app" } })).toBeNull();
    gate.wait = null;
    release();
    expect((await first).photos).toBe(1);
    expect((await db.appSetting.findUniqueOrThrow({ where: { id: "app" } })).membersOnlyMatcher).toBe(MATCHER_VERSION);
    expect((await db.photo.findUniqueOrThrow({ where: { id: rex } })).annotationMembersOnly).toBe(true);
  });

  it("stops at the next photograph once pg-boss has given up on it, records nothing, and lets the next one run", async () => {
    const given = new AbortController();
    given.abort();
    await expect(rejudgeSweep(given.signal)).rejects.toThrow();
    expect(await db.appSetting.findUnique({ where: { id: "app" } })).toBeNull();
    expect((await db.photo.findUniqueOrThrow({ where: { id: rex } })).annotationMembersOnly).toBe(false);
    expect((await rejudgeSweep()).photos).toBe(1);
    expect((await db.appSetting.findUniqueOrThrow({ where: { id: "app" } })).membersOnlyMatcher).toBe(MATCHER_VERSION);
  });

  it("gives its queue hours, not a quarter hour, with a heartbeat to notice a worker that died", () => {
    for (const q of [QUEUES.rejudgeText, QUEUES.finishRemovals]) {
      expect(queueOptions(q).expireInSeconds).toBe(LONG_JOB_EXPIRE_SECONDS);
      expect(queueOptions(q).heartbeatSeconds).toBeGreaterThan(0);
    }
    expect(LONG_JOB_EXPIRE_SECONDS).toBeGreaterThanOrEqual(4 * 3600);
  });
});

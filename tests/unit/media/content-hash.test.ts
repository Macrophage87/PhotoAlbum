import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";
import { claimContentHash } from "@/lib/media/content-hash";

/** The client behind the `db` proxy, whose methods can be spied on. */
const client = () => { void db.photo; return (globalThis as unknown as { prisma: typeof db }).prisma; };

/**
 * Two claims of the same hash, held at the moment each looks for the other until both have got there (or a moment
 * has passed). Without the lock both look before either writes, both find nothing, and both keep their copy — every
 * time. With it, the second cannot look until the first has written, so it always finds the first.
 */
function meetAtTheLookup() {
  let arrived = 0;
  let release!: () => void;
  const everyone = new Promise<void>((r) => { release = r; });
  const c = client();
  const real = c.$transaction.bind(c) as (...a: unknown[]) => Promise<unknown>;
  return vi.spyOn(c, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
    real(async (tx: typeof db) => {
      const photo = new Proxy(tx.photo, {
        get(target, key, receiver) {
          if (key !== "findFirst") return Reflect.get(target, key, receiver);
          return async (args: unknown) => {
            if (++arrived === 2) release();
            await Promise.race([everyone, new Promise((r) => setTimeout(r, 400))]);
            return target.findFirst(args as never);
          };
        },
      });
      return fn(new Proxy(tx, { get: (t, k, r) => (k === "photo" ? photo : Reflect.get(t, k, r)) }));
    }, opts)) as never);
}

describe("claiming a file's hash", () => {
  let userId: string;
  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "h@example.com", role: "MEMBER" } })).id;
  });
  const row = () => db.photo.create({ data: { uploaderId: userId, status: "PENDING", originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 0 } });

  it("lets only one of two rows with the same bytes have them, however the two overlap", async () => {
    const [a, b] = [await row(), await row()];
    const spy = meetAtTheLookup();
    try {
      const results = await Promise.all([claimContentHash(a.id, "h".repeat(64)), claimContentHash(b.id, "h".repeat(64))]);
      expect(results.filter((r) => r === null)).toHaveLength(1);
      expect(await db.photo.count({ where: { contentHash: "h".repeat(64) } })).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
  it("tries once more when the transaction could not start in time", async () => {
    const a = await row();
    const c = client();
    const real = c.$transaction.bind(c) as (...args: unknown[]) => Promise<unknown>;
    let calls = 0;
    const spy = vi.spyOn(c, "$transaction").mockImplementation(((...args: unknown[]) => {
      if (++calls === 1) return Promise.reject(Object.assign(new Error("Transaction API error: Unable to start a transaction in the given time."), { code: "P2028" }));
      return real(...args);
    }) as never);
    try {
      expect(await claimContentHash(a.id, "k".repeat(64))).toBeNull();
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

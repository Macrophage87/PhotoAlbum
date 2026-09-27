import { vi } from "vitest";

/**
 * Something that happens just before the application's next raw statement, or its next transaction: the worker
 * dying there (throw), or somebody else's write landing first. The client is a proxy, so it cannot be spied on;
 * a test file routes it through here with
 *   vi.mock("@/lib/db", async () => (await import("../helpers/hooked-db")).hookedDb());
 * and clears the hooks when it is done.
 */
export const dbHooks: { raw: (() => Promise<void>) | null; transaction: (() => Promise<void>) | null } = { raw: null, transaction: null };

export async function hookedDb() {
  const { db } = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  const wrapped = new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function") return value;
      const hook = key === "$executeRaw" ? "raw" : key === "$transaction" ? "transaction" : null;
      if (!hook) return value.bind(target);
      return async (...args: unknown[]) => {
        await dbHooks[hook]?.();
        return value.apply(target, args);
      };
    },
  });
  return { db: wrapped };
}

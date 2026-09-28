import { vi } from "vitest";

/**
 * Something that happens just before the application's next raw statement, its next transaction, or its next call
 * on a model (`model`, told which): the worker dying there (throw), or somebody else's write landing first. The client is a proxy, so it cannot be spied on;
 * a test file routes it through here with
 *   vi.mock("@/lib/db", async () => (await import("../helpers/hooked-db")).hookedDb());
 * and clears the hooks when it is done.
 */
export const dbHooks: { raw: (() => Promise<void>) | null; transaction: (() => Promise<void>) | null; model: ((model: string, method: string) => Promise<void>) | null } = { raw: null, transaction: null, model: null };

export async function hookedDb() {
  const { db } = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  const wrapped = new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      // A model's delegate: its calls are hooked by name.
      if (value && typeof value === "object" && typeof key === "string" && !key.startsWith("$")) {
        return new Proxy(value, {
          get(delegate, method) {
            const fn = Reflect.get(delegate, method) as unknown;
            if (typeof fn !== "function" || typeof method !== "string") return fn;
            // Untouched while no hook is set, so the lazy Prisma promise itself is handed back (array-form
            // $transaction needs it); a test that sets a hook gets an ordinary promise for that call.
            if (!dbHooks.model) return fn.bind(delegate);
            return async (...args: unknown[]) => {
              await dbHooks.model?.(key, method);
              return fn.apply(delegate, args);
            };
          },
        });
      }
      if (typeof value !== "function") return value;
      const hook = key === "$executeRaw" ? "raw" : key === "$transaction" ? "transaction" : null;
      if (!hook || !dbHooks[hook]) return value.bind(target);
      return async (...args: unknown[]) => {
        await dbHooks[hook]?.();
        return value.apply(target, args);
      };
    },
  });
  return { db: wrapped };
}

import { Client } from "pg";
import { env } from "@/lib/env";

/** Which lock: a number of its own, or one per row of a kind (the kind's number and the row's id). */
export type LockKey = { space: number; id?: string };

/**
 * Run `fn` holding a session-level advisory lock, unless somebody else holds it: tried, not waited for, and
 * `{ ran: false }` when it is taken (`fn` never runs). Held on a connection of its own, so it goes with the
 * connection however the run ends — a crash included — and never blocks on the pool the work itself uses.
 */
export async function withTryLock<T>(key: LockKey, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const client = new Client({ connectionString: env().DATABASE_URL });
  client.on("error", () => undefined);
  await client.connect();
  // The two-number form for a row, so it never shares a key with a lock of its own number.
  const [take, give, args] = key.id === undefined
    ? ["SELECT pg_try_advisory_lock($1::bigint) AS got", "SELECT pg_advisory_unlock($1::bigint)", [key.space]]
    : ["SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS got", "SELECT pg_advisory_unlock($1::int, hashtext($2))", [key.space, key.id]];
  try {
    const { rows } = await client.query<{ got: boolean }>(take, args);
    if (!rows[0]?.got) return { ran: false };
    try {
      return { ran: true, value: await fn() };
    } finally {
      await client.query(give, args).catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

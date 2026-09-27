import { Prisma } from "@/generated/prisma/client";

/**
 * pg-boss's schema: "pgboss", unless PGBOSS_SCHEMA names another. Unit tests that run a real queue set a schema of
 * their own, so a run cut short never leaves one under the real name for the next run to trip over.
 */
export function bossSchema(): string {
  const schema = process.env.PGBOSS_SCHEMA?.trim() || "pgboss";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("PGBOSS_SCHEMA must be a lower-case SQL identifier");
  return schema;
}

/** pg-boss's job table, for the few raw queries that read or clear it. */
export const bossJobs = (): Prisma.Sql => Prisma.raw(`"${bossSchema()}".job`);

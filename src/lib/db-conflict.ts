/**
 * A deadlock or a serialization failure: the other transaction won, and running this one again is safe. Prisma's own
 * code, or Postgres's through a raw statement, which the driver adapter nests under `meta.driverAdapterError`.
 */
export function isWriteConflict(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } } | null;
  const pg = e?.meta?.code ?? e?.meta?.driverAdapterError?.cause?.originalCode;
  return e?.code === "P2034" || pg === "40P01" || pg === "40001";
}

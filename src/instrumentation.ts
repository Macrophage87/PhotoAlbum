export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { env } = await import("@/lib/env");
  if (!env().RUN_WORKER) return;
  const { startWorker } = await import("@/lib/jobs/worker");
  const { installShutdownHandlers } = await import("@/lib/jobs/boss");
  // The Next server exits on SIGTERM; stop the queue first so in-flight jobs finish or are released.
  installShutdownHandlers();
  startWorker().catch((err) => console.error("[worker] failed to start", err));
}

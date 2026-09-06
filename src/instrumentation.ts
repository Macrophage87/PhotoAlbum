export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { env } = await import("@/lib/env");
  if (!env().RUN_WORKER) return;
  const { startWorker } = await import("@/lib/jobs/worker");
  startWorker().catch((err) => console.error("[worker] failed to start", err));
}

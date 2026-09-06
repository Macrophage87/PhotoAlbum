import { PgBoss } from "pg-boss";
import { env } from "@/lib/env";
import { QUEUES, type QueueName } from "./queues";

const globalForBoss = globalThis as unknown as { boss?: Promise<PgBoss> };

/**
 * A job that has not completed within this window is handed back for retry. Kept short so a
 * photo whose worker died mid-job is retried within minutes rather than an hour.
 */
export const JOB_EXPIRE_SECONDS = 15 * 60;
const QUEUE_OPTIONS = { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: JOB_EXPIRE_SECONDS };

async function create(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: env().DATABASE_URL, schema: "pgboss" });
  boss.on("error", (err) => console.error("[pg-boss]", err));
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    // createQueue is a no-op for an existing queue, so apply the options explicitly as well.
    await boss.createQueue(name, QUEUE_OPTIONS);
    await boss.updateQueue(name, QUEUE_OPTIONS);
  }
  return boss;
}

/** Shared pg-boss instance (started on first use). Safe to call from web requests and the worker alike. */
export function getBoss(): Promise<PgBoss> {
  if (!globalForBoss.boss) globalForBoss.boss = create();
  return globalForBoss.boss;
}

export async function enqueue<T extends object>(queue: QueueName, data: T, options?: Parameters<PgBoss["send"]>[2]) {
  const boss = await getBoss();
  return boss.send(queue, data, options);
}

export async function getJobState(queue: QueueName, id: string) {
  const boss = await getBoss();
  const job = await boss.getJobById(queue, id);
  if (!job) return null;
  return { state: job.state, output: job.output as unknown };
}

/**
 * Stop the queue if it was started. With graceful=true pg-boss waits (up to timeout) for
 * in-flight handlers to finish, so a deploy does not abandon a half-processed photo.
 */
export async function stopBoss(timeoutMs = 30_000): Promise<void> {
  if (!globalForBoss.boss) return;
  const pending = globalForBoss.boss;
  globalForBoss.boss = undefined;
  const boss = await pending;
  await boss.stop({ graceful: true, timeout: timeoutMs });
}

let shutdownInstalled = false;

/** Stop pg-boss gracefully on SIGTERM/SIGINT, then let the process exit. Idempotent. */
export function installShutdownHandlers(opts: { exit?: boolean } = {}): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  let stopping = false;
  const stop = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal} received, finishing in-flight jobs`);
    try {
      await stopBoss();
    } catch (err) {
      console.error("[worker] error while stopping pg-boss", err);
    }
    if (opts.exit) process.exit(0);
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void stop(sig));
}

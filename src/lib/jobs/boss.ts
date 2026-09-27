import { PgBoss } from "pg-boss";
import { env } from "@/lib/env";
import { QUEUES, type QueueName } from "./queues";
import { FFMPEG_TIMEOUT_MS } from "@/lib/video/ffmpeg";
import { markStopping } from "./shutdown";
import { bossSchema } from "./schema";

const globalForBoss = globalThis as unknown as { boss?: Promise<PgBoss> };

/**
 * A job that has not completed within this window is handed back for retry. Kept short so a
 * photo whose worker died mid-job is retried within minutes rather than an hour.
 */
export const JOB_EXPIRE_SECONDS = 15 * 60;
/**
 * The heavy queues share one lock, so their clock also runs while they wait behind a transcode: two ffmpeg runs of
 * up to FFMPEG_TIMEOUT_MS each, plus the lock wait and the uploads. A job that still overruns is told so through its
 * signal and stops, so its retry never runs beside it.
 */
export const HEAVY_JOB_EXPIRE_SECONDS = (2 * FFMPEG_TIMEOUT_MS) / 1000 + 20 * 60;
/**
 * That long a window would also leave a job whose worker died waiting 40 minutes for its retry. A live heavy job
 * instead touches its row every HEAVY_HEARTBEAT_REFRESH_SECONDS, and pg-boss fails (and retries) one that has not
 * been touched for HEAVY_HEARTBEAT_SECONDS, so a crash is noticed within a few minutes. Six touches per window, so
 * one slow database round trip never fails a job that is still running.
 */
// A live handler whose heartbeat pg-boss nevertheless failed (a database outage longer than the window) is not
// aborted; with the one worker process its retry then waits behind it on the heavy lock, so the work is repeated
// once but never concurrently.
export const HEAVY_HEARTBEAT_SECONDS = 180;
export const HEAVY_HEARTBEAT_REFRESH_SECONDS = 30;
export const HEAVY_QUEUES: readonly QueueName[] = [QUEUES.transcodeVideo, QUEUES.embedPhoto, QUEUES.detectFaces, QUEUES.detectAnimals];
const QUEUE_OPTIONS = { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: JOB_EXPIRE_SECONDS };

export function queueOptions(name: QueueName): typeof QUEUE_OPTIONS & { heartbeatSeconds?: number } {
  return HEAVY_QUEUES.includes(name) ? { ...QUEUE_OPTIONS, expireInSeconds: HEAVY_JOB_EXPIRE_SECONDS, heartbeatSeconds: HEAVY_HEARTBEAT_SECONDS } : QUEUE_OPTIONS;
}

async function create(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: env().DATABASE_URL, schema: bossSchema() });
  boss.on("error", (err) => console.error("[pg-boss]", err));
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    // createQueue is a no-op for an existing queue, so apply the options explicitly as well.
    await boss.createQueue(name, queueOptions(name));
    await boss.updateQueue(name, queueOptions(name));
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
  markStopping();
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

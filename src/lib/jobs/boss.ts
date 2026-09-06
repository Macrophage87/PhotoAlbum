import { PgBoss } from "pg-boss";
import { env } from "@/lib/env";
import { QUEUES, type QueueName } from "./queues";

const globalForBoss = globalThis as unknown as { boss?: Promise<PgBoss> };

async function create(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: env().DATABASE_URL, schema: "pgboss" });
  boss.on("error", (err) => console.error("[pg-boss]", err));
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    await boss.createQueue(name, { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 * 60 });
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

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgBoss } from "pg-boss";

/**
 * Forgetting somebody leaves their name nowhere in the database: not in the names the sweep recorded as judged, and
 * not in the judging jobs queued (or finished) for them. Against a real pg-boss in the `pgboss` schema of the test
 * database, the one the forget clears, dropped afterwards.
 */
const real = vi.hoisted(() => ({ boss: null as unknown as import("pg-boss").PgBoss, admin: "" }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: (queue: string, data: object, options: object) => real.boss.send(queue, data, options) }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: real.admin, email: "admin@example.com", name: null, role: "ADMIN" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: () => undefined }) }));

import { db } from "@/lib/db";
import { QUEUES } from "@/lib/jobs/queues";
import { tagPersonAt } from "@/app/people/actions";
import { rejudgeSweep, rejudgeText, type RejudgeJob } from "@/lib/annotation/rejudge";
import { forgetPerson } from "@/lib/people/forget-person";
import { applyAnnotation } from "@/lib/annotation/apply";
import { annotationSchema } from "@/lib/annotation/schema";
import { resetTestDb } from "../helpers/reset";

const NAME = "Zebulon Quince";

/** Every table, in the album's schema and pg-boss's, whose rows mention the name anywhere. */
async function tablesMentioning(word: string): Promise<string[]> {
  const tables = await db.$queryRaw<{ s: string; t: string }[]>`
    SELECT table_schema AS s, table_name AS t FROM information_schema.tables
    WHERE table_schema IN ('public', 'pgboss') AND table_type = 'BASE TABLE'`;
  const found: string[] = [];
  for (const { s, t } of tables) {
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${s}"."${t}" x WHERE x::text ILIKE $1`, `%${word}%`);
    if (n) found.push(`${s}.${t}`);
  }
  return found;
}

describe("forgetting somebody leaves their name nowhere", () => {
  beforeAll(async () => {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS pgboss CASCADE`);
    real.boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema: "pgboss", supervise: false, schedule: false });
    await real.boss.start();
    for (const q of Object.values(QUEUES)) await real.boss.createQueue(q);
  });
  afterAll(async () => {
    await real.boss.stop({ graceful: false });
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS pgboss CASCADE`);
  });
  beforeEach(async () => {
    await resetTestDb();
    real.admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });

  it("after tagging, judging and forgetting, no table holds the name, the queue included", async () => {
    const annotation = { title: "", caption: `${NAME} at the pier`, description: "", tags: [], searchSummary: "" };
    const photoId = (await db.photo.create({ data: { uploaderId: real.admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", annotation } })).id;
    const fd = new FormData();
    fd.set("name", NAME);
    fd.set("box", JSON.stringify([0.1, 0.1, 0.2, 0.2]));
    await tagPersonAt(photoId, fd);
    const person = await db.person.findFirstOrThrow({ where: { name: NAME } });
    // The judging asked for carries who, not the name.
    const [queued] = await real.boss.findJobs(QUEUES.rejudgeText);
    expect(queued.data).toEqual({ people: [person.id] });
    expect(JSON.stringify(queued)).not.toContain("Zebulon");
    // One queued before names were asked for by id, as staging may still hold.
    await real.boss.send(QUEUES.rejudgeText, { names: [NAME] }, { singletonKey: `rejudge:names:${NAME}` });
    // The job runs, and finishes (its row is kept for days), and so does the sweep.
    const [job] = await real.boss.fetch<RejudgeJob>(QUEUES.rejudgeText);
    expect((await rejudgeText(job.data)).photos).toBe(1);
    await real.boss.complete(QUEUES.rejudgeText, job.id);
    await rejudgeSweep();
    expect((await db.appSetting.findUniqueOrThrow({ where: { id: "app" } })).membersOnlyNames).toContain(`person:${person.id}:${NAME}`);
    expect(await tablesMentioning("Zebulon")).toEqual(expect.arrayContaining(["public.AppSetting", "public.Person"]));

    // A raw answer kept about a photograph the forget has no other reason to touch: the helper named them in a
    // caption since replaced.
    const elsewhere = (await db.photo.create({ data: { uploaderId: real.admin, originalName: "y.jpg", mimeType: "image/jpeg", storageKey: "k2", originalPath: "k2/o.jpg", sizeBytes: 1, status: "READY", annotation: { title: "", caption: "A pier", description: "", tags: [], searchSummary: "" } } })).id;
    await db.mediaAnnotationRaw.create({ data: { photoId: elsewhere, model: "m", response: { content: [{ type: "text", text: JSON.stringify({ title: "Pier", caption: `${NAME} on the pier`, tags: ["zebulon quince"] }) }] } } });

    await forgetPerson(person.id, { keepName: false, byUserId: real.admin });
    expect(await tablesMentioning("Zebulon")).toEqual([]);
    expect(await tablesMentioning("Quince")).toEqual([]);
    expect(await real.boss.findJobs(QUEUES.rejudgeText)).toEqual([]);

    // An answer that comes back afterwards naming them, about another photograph: stored without the name, the raw
    // answer included, whose title still says what went on the item.
    const later = (await db.photo.create({ data: { uploaderId: real.admin, originalName: "z.jpg", mimeType: "image/jpeg", storageKey: "k3", originalPath: "k3/o.jpg", sizeBytes: 1, status: "READY" } })).id;
    const answer = annotationSchema.parse({ title: `${NAME}'s cake`, caption: `${NAME} blows out the candles`, description: "", tags: ["cake", "zebulon quince"], place: null, activity: null, objects: [], visibleText: "HAPPY 80TH ZEBULON QUINCE", season: "summer", mood: null, searchSummary: "cake zebulon quince", estimatedYear: { from: 1990, to: 1995, confidence: 0.5, evidence: `${NAME} looks eighty` }, estimatedPlace: null });
    await applyAnnotation(later, "m", answer, { content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 1, output_tokens: 1 } });
    const kept = await db.mediaAnnotationRaw.findFirstOrThrow({ where: { photoId: later } });
    const stored = await db.photo.findUniqueOrThrow({ where: { id: later } });
    expect(JSON.parse((kept.response as { content: { text: string }[] }).content[0].text).title).toBe((stored.annotation as { title: string }).title);
    expect(await tablesMentioning("Zebulon")).toEqual([]);
    expect(await tablesMentioning("Quince")).toEqual([]);
  }, 30_000);

  it("clears every judging job that carries names with each sweep, finished ones too, and leaves the rest", async () => {
    await real.boss.deleteAllJobs(QUEUES.rejudgeText);
    await real.boss.send(QUEUES.rejudgeText, { names: ["Old Name"] }, { singletonKey: "rejudge:names:Old Name" });
    const [finished] = await real.boss.fetch(QUEUES.rejudgeText);
    await real.boss.complete(QUEUES.rejudgeText, finished.id);
    await real.boss.send(QUEUES.rejudgeText, { names: ["Other Name"] });
    await real.boss.send(QUEUES.rejudgeText, { people: ["p1"] });
    await rejudgeSweep();
    expect((await real.boss.findJobs(QUEUES.rejudgeText)).map((j) => j.data)).toEqual([{ people: ["p1"] }]);
  });

  it("runs a job for somebody forgotten since it was queued as nothing to do", async () => {
    const person = await db.person.create({ data: { name: NAME, createdById: real.admin } });
    await forgetPerson(person.id, { keepName: false, byUserId: real.admin });
    expect(await rejudgeText({ people: [person.id] })).toMatchObject({ photos: 0, missed: 0 });
    expect((await db.appSetting.findUnique({ where: { id: "app" } }))?.membersOnlyNames ?? []).toEqual([]);
  });
});

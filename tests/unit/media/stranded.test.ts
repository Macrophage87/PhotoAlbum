import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const root = mkdtempSync(path.join(tmpdir(), "stranded-"));
process.env.PHOTO_STORAGE_ROOT = root;

import { PgBoss } from "pg-boss";
import { STRANDED_AFTER_MS, sweepStrandedUploads } from "@/lib/media/stranded";
import { withLivePickerJob } from "@/lib/jobs/live";
import { QUEUES } from "@/lib/jobs/queues";

const noJobs = async () => new Set<string>();
// A real queue in a schema of this run's own (see bossSchema), dropped afterwards.
const SCHEMA = vi.hoisted(() => {
  const schema = `pgboss_unit_stranded_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  process.env.PGBOSS_SCHEMA = schema;
  return schema;
});

describe("rows whose file never arrived", () => {
  let userId: string;
  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "s@example.com", role: "MEMBER" } })).id;
  });
  const row = (over: Record<string, unknown>) =>
    db.photo.create({ data: { uploaderId: userId, status: "PENDING", originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 0, ...over } });

  it("are removed, with any part of a file, once nothing could still be bringing it; nothing else is", async () => {
    const old = new Date(Date.now() - STRANDED_AFTER_MS - 60_000);
    const stranded = await row({ createdAt: old, updatedAt: old });
    mkdirSync(path.join(root, "photos", stranded.id), { recursive: true });
    writeFileSync(path.join(root, "photos", stranded.id, "original.jpg"), "part");
    const recent = await row({});
    // Made long ago but picked again just now, so a download is on its way for it.
    const repicked = await row({ createdAt: old, sourceKind: "GOOGLE_PICKER" });
    const queued = await row({ createdAt: old, updatedAt: old, storageKey: "photos/q", originalPath: "photos/q/original.jpg", sizeBytes: 9 });
    const failed = await row({ createdAt: old, updatedAt: old, status: "FAILED", sourceKind: "GOOGLE_PICKER" });
    expect(await sweepStrandedUploads()).toBe(1);
    expect(existsSync(path.join(root, "photos", stranded.id))).toBe(false);
    expect((await db.photo.findMany({ select: { id: true } })).map((p) => p.id).sort()).toEqual([recent.id, repicked.id, queued.id, failed.id].sort());
  });
  it("says a Picker download lost with its worker failed, with what to do, and keeps the row", async () => {
    const lost = await row({ sourceKind: "GOOGLE_PICKER", status: "PROCESSING", updatedAt: new Date(Date.now() - 60 * 60_000) });
    const going = await row({ sourceKind: "GOOGLE_PICKER", status: "PROCESSING" });
    await sweepStrandedUploads(new Date(), { livePickerJobs: noJobs });
    expect(await db.photo.findUniqueOrThrow({ where: { id: lost.id } })).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Pick it again/) });
    expect((await db.photo.findUniqueOrThrow({ where: { id: going.id } })).status).toBe("PROCESSING");
  });
  it("never deletes a Picker row whose download never came: it says to pick it again, unless a job is still bringing it", async () => {
    const old = new Date(Date.now() - STRANDED_AFTER_MS - 60_000);
    const never = await row({ createdAt: old, updatedAt: old, sourceKind: "GOOGLE_PICKER" });
    const waiting = await row({ createdAt: old, updatedAt: old, sourceKind: "GOOGLE_PICKER" });
    const dying = await row({ sourceKind: "GOOGLE_PICKER", status: "PROCESSING", updatedAt: new Date(Date.now() - 60 * 60_000) });
    // The worker was down for a day: the download job naming these two is still in the queue.
    expect(await sweepStrandedUploads(new Date(), { livePickerJobs: async (ids) => new Set(ids.filter((id) => id === waiting.id || id === dying.id)) })).toBe(1);
    expect(await db.photo.findUniqueOrThrow({ where: { id: never.id } })).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Pick it again/) });
    expect(await db.photo.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: "PENDING", error: null });
    expect((await db.photo.findUniqueOrThrow({ where: { id: dying.id } })).status).toBe("PROCESSING");
    // Unable to tell (the queue cannot be read): nothing is failed.
    await db.photo.update({ where: { id: never.id }, data: { status: "PENDING", error: null, updatedAt: old } });
    expect(await sweepStrandedUploads(new Date(), { livePickerJobs: async (ids) => new Set(ids) })).toBe(0);
    expect((await db.photo.findUniqueOrThrow({ where: { id: never.id } })).status).toBe("PENDING");
  });

  it("finds the rows a queued Picker download names, on a real queue", async () => {
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema: SCHEMA, supervise: false, schedule: false });
    try {
      await boss.start();
      await boss.createQueue(QUEUES.googlePickerImport);
      // One that has finished names nobody still waiting.
      await boss.send(QUEUES.googlePickerImport, { userId, sessionId: "t", photoIds: ["c"], items: {} });
      const [done] = await boss.fetch(QUEUES.googlePickerImport);
      await boss.complete(QUEUES.googlePickerImport, done.id);
      await boss.send(QUEUES.googlePickerImport, { userId, sessionId: "s", photoIds: ["a", "b"], items: {} });
      expect([...(await withLivePickerJob(["a", "c", "d"]))].sort()).toEqual(["a"]);
    } finally {
      await boss.stop({ graceful: false });
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    }
  });

  it("leaves a row that a download took between being listed and being deleted", async () => {
    const old = new Date(Date.now() - STRANDED_AFTER_MS - 60_000);
    const p = await row({ createdAt: old, updatedAt: old });
    // Taken just as the sweep lists it: the conditional delete must then find nothing to take.
    const realFindMany = db.photo.findMany;
    const c = (globalThis as unknown as { prisma: typeof db }).prisma;
    const spy = vi.spyOn(c.photo, "findMany").mockImplementationOnce((async (args: unknown) => {
      const listed = await (realFindMany as (a: unknown) => Promise<unknown[]>)(args);
      await db.photo.update({ where: { id: p.id }, data: { status: "PROCESSING" } });
      return listed;
    }) as never);
    try {
      expect(await sweepStrandedUploads()).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(await db.photo.count({ where: { id: p.id } })).toBe(1);
  });
});

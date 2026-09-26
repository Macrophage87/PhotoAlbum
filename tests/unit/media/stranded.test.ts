import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const root = mkdtempSync(path.join(tmpdir(), "stranded-"));
process.env.PHOTO_STORAGE_ROOT = root;

import { STRANDED_AFTER_MS, sweepStrandedUploads } from "@/lib/media/stranded";

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
    await sweepStrandedUploads();
    expect(await db.photo.findUniqueOrThrow({ where: { id: lost.id } })).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Pick it again/) });
    expect((await db.photo.findUniqueOrThrow({ where: { id: going.id } })).status).toBe("PROCESSING");
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

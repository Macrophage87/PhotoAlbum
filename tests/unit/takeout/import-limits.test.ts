import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWriteStream, mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { ZipFile } from "yazl";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const inbox = mkdtempSync(path.join(tmpdir(), "takeout-limits-inbox-"));
const photoRoot = mkdtempSync(path.join(tmpdir(), "takeout-limits-photos-"));
process.env.IMPORT_INBOX_DIR = inbox;
process.env.PHOTO_STORAGE_ROOT = photoRoot;
// Small enough to build an archive over it in a test; env is read once, on first use, so this holds for the file.
process.env.MAX_UPLOAD_BYTES = String(1024 * 1024);
const who = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/jobs/live", () => ({ hasLiveProcessingJob: async () => false }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => "job" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "a@example.com", name: null, role: "ADMIN" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { importTakeoutArchive, NOT_A_ZIP, OWNER_REMOVED, TOO_MUCH_UNPACKED, UNPACK_LIMIT } from "@/lib/takeout/import";
import { markRunReviewed, unreviewedFromRun } from "@/lib/takeout/review";
import { markTakeoutImportReviewed, startTakeoutImport } from "@/app/admin/actions";

type Report = { failures: { file: string; reason: string }[]; noSidecar: number; total?: number; duplicates: number; repairs: string[] };

async function archive(name: string, entries: [string, Buffer][]) {
  const zip = new ZipFile();
  for (const [p, b] of entries) zip.addBuffer(b, p);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path.join(inbox, name)));
}
const png = (seed: number) => sharp({ create: { width: 12, height: 9, channels: 3, background: { r: seed, g: 40, b: 200 - seed } } }).png().toBuffer();

describe("Takeout import limits, owner and edge cases", () => {
  let adminId: string;
  beforeEach(async () => {
    await resetTestDb();
    UNPACK_LIMIT.factor = 4;
    UNPACK_LIMIT.slackBytes = 256 * 1024 * 1024;
    adminId = who.id = (await db.user.create({ data: { email: "a@example.com", role: "ADMIN" } })).id;
  });
  async function run(archiveName: string, ownerId?: string) {
    const row = await db.takeoutImport.create({ data: { archiveName, startedById: adminId, ownerId } });
    await importTakeoutArchive(row.id);
    return db.takeoutImport.findUniqueOrThrow({ where: { id: row.id } });
  }

  it("fails a file larger than the album takes for its kind, with a reason, and imports the rest (#13)", async () => {
    await archive("big.zip", [
      ["Takeout/Google Photos/Photos from 2025/huge.jpg", randomBytes(2 * 1024 * 1024)],
      ["Takeout/Google Photos/Photos from 2025/small.png", await png(1)],
    ]);
    const r = await run("big.zip");
    expect(r).toMatchObject({ status: "ENDED", imported: 1, failed: 1 });
    const report = r.report as Report;
    expect(report.failures).toEqual([{ file: "huge.jpg", reason: expect.stringMatching(/up to 1 MB/) }]);
    expect(await db.photo.count()).toBe(1);
  });

  it("stops an archive that unpacks to far more than its own size, leaving nothing half-done (#13)", async () => {
    UNPACK_LIMIT.slackBytes = 0;
    // Zeros deflate to almost nothing: three of these are a few kilobytes in the archive and megabytes unpacked.
    await archive("bomb.zip", [1, 2, 3].map((n) => [`Takeout/Google Photos/Photos from 2025/z${n}.jpg`, Buffer.alloc(900 * 1024)] as [string, Buffer]));
    const r = await run("bomb.zip");
    expect(r.status).toBe("FAILED");
    expect((r.report as Report).failures).toContainEqual({ file: "bomb.zip", reason: TOO_MUCH_UNPACKED });
    expect(await db.photo.count()).toBe(0);
  });

  it("counts photos that came without Google's metadata, and how many the archive holds (#18)", async () => {
    await archive("bare.zip", [
      ["Takeout/Google Photos/Photos from 2025/a.png", await png(2)],
      ["Takeout/Google Photos/Photos from 2025/b.png", await png(3)],
      ["Takeout/Google Photos/Photos from 2025/b.png.supplemental-metadata.json", Buffer.from(JSON.stringify({ title: "b.png", photoTakenTime: { timestamp: "1735732800" } }))],
    ]);
    const r = await run("bare.zip");
    expect(r.imported).toBe(2);
    expect(r.report as Report).toMatchObject({ noSidecar: 1, total: 2 });
  });

  it("fails a damaged archive with a reason a person can act on (#18)", async () => {
    writeFileSync(path.join(inbox, "broken.zip"), Buffer.from("PK\u0003\u0004 this is not really a zip file at all"));
    const r = await run("broken.zip");
    expect(r.status).toBe("FAILED");
    const [failure] = (r.report as Report).failures;
    expect(failure.file).toBe("broken.zip");
    expect(failure.reason.startsWith(NOT_A_ZIP)).toBe(true);
  });

  it("leaves a run that is not RUNNING alone (#18)", async () => {
    copyFileSync(path.join(process.cwd(), "tests/fixtures/takeout.zip"), path.join(inbox, "done.zip"));
    for (const status of ["ENDED", "FAILED"] as const) {
      const row = await db.takeoutImport.create({ data: { archiveName: "done.zip", startedById: adminId, status, endedAt: new Date() } });
      await importTakeoutArchive(row.id);
      expect(await db.takeoutImport.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status, imported: 0, report: null });
    }
    await importTakeoutArchive("no-such-run");
    expect(await db.photo.count()).toBe(0);
  });

  it("uploads the photos as the member chosen, and makes the albums their collections (#29)", async () => {
    const mum = await db.user.create({ data: { email: "mum@example.com", role: "MEMBER" } });
    copyFileSync(path.join(process.cwd(), "tests/fixtures/takeout.zip"), path.join(inbox, "mum.zip"));
    await startTakeoutImport("mum.zip", mum.id);
    const queued = await db.takeoutImport.findFirstOrThrow({ where: { archiveName: "mum.zip" } });
    expect(queued).toMatchObject({ startedById: adminId, ownerId: mum.id });
    await importTakeoutArchive(queued.id);
    expect(await db.photo.findMany({ select: { uploaderId: true } })).toEqual(Array(4).fill({ uploaderId: mum.id }));
    const album = await db.collection.findFirstOrThrow({ where: { title: "Lake House" }, include: { items: true } });
    expect(album.createdById).toBe(mum.id);
    expect(album.items.every((i) => i.addedById === mum.id)).toBe(true);
  });

  it("defaults to the admin, refuses a member being removed, and stops if the owner's removal begins (#29)", async () => {
    copyFileSync(path.join(process.cwd(), "tests/fixtures/takeout.zip"), path.join(inbox, "mine.zip"));
    await startTakeoutImport("mine.zip");
    expect(await db.takeoutImport.findFirstOrThrow({ where: { archiveName: "mine.zip" } })).toMatchObject({ ownerId: adminId });
    await db.takeoutImport.deleteMany();
    const gone = await db.user.create({ data: { email: "gone@example.com", role: "MEMBER", removingAt: new Date() } });
    await expect(startTakeoutImport("mine.zip", gone.id)).rejects.toThrow(/no longer in the album/);
    const r = await run("mine.zip", gone.id);
    expect(r.status).toBe("FAILED");
    expect((r.report as Report).failures).toContainEqual({ file: "mine.zip", reason: OWNER_REMOVED });
    expect(await db.photo.count()).toBe(0);
  });

  it("marks only the photos one finished import brought in as reviewed, in one step (#12)", async () => {
    copyFileSync(path.join(process.cwd(), "tests/fixtures/takeout.zip"), path.join(inbox, "rev.zip"));
    // Somebody's own upload, unreviewed, which the import's button must not touch.
    const upload = await db.photo.create({ data: { uploaderId: adminId, status: "READY", originalName: "phone.jpg", mimeType: "image/jpeg", storageKey: "photos/x", originalPath: "photos/x/original.jpg", sizeBytes: 1 } });
    const r = await run("rev.zip");
    expect(await db.photo.count({ where: unreviewedFromRun(r) })).toBe(4);
    expect(await markTakeoutImportReviewed(r.id)).toBe(4);
    expect(await db.photo.count({ where: { sourceKind: "TAKEOUT", reviewedAt: null } })).toBe(0);
    expect((await db.photo.findUniqueOrThrow({ where: { id: upload.id } })).reviewedAt).toBeNull();
    expect(await markRunReviewed(r.id)).toBe(0);
    // A run still going is not marked: its photos are still arriving.
    const live = await db.takeoutImport.create({ data: { archiveName: "rev.zip", startedById: adminId } });
    expect(await markRunReviewed(live.id)).toBe(0);
  });
});

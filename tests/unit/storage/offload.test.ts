import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";
import type { FakeRemote } from "./fake-remote";

/** Option 2's hourly pass: originals to S3, and the disk's copies freed once S3 is seen to hold them. */
const root = mkdtempSync(path.join(tmpdir(), "offload-"));
process.env.PHOTO_STORAGE_ROOT = root;
process.env.STORAGE_DRIVER = "tiered";
process.env.ORIGINALS_S3_BUCKET = "album-originals-test";
process.env.ORIGINALS_S3_PREFIX = "live/";
vi.mock("@/lib/jobs/live", () => ({ liveImportKeys: async () => new Set<string>() }));
const held = vi.hoisted(() => ({ remote: null as FakeRemote | null }));
vi.mock("@/lib/storage", async () => {
  const { TieredStorage } = await import("@/lib/storage/tiered");
  const { FakeRemote } = await import("./fake-remote");
  held.remote = new FakeRemote();
  // Made on first use, as the real one is: this file's root is set only after the imports have run.
  let store: InstanceType<typeof TieredStorage> | undefined;
  return { storage: () => (store ??= new TieredStorage(process.env.PHOTO_STORAGE_ROOT!, held.remote!, "live/")), localFileOf: (s: { localFile: (k: string) => Promise<string> }, k: string) => s.localFile(k) };
});

import { offloadOriginals } from "@/lib/storage/offload";
import { ensureInstallIdentity, forgetCoverage } from "@/lib/storage/identity";

const remote = held.remote!;

const DAY = 86_400_000;
/** Two days on: everything made now has settled past ORIGINALS_OFFLOAD_AFTER_HOURS. */
const later = () => new Date(Date.now() + 2 * DAY);
let uploader = "";

async function item(data: { kind?: "PHOTO" | "VIDEO" | "SCAN" | "EXTERNAL_VIDEO"; status?: "READY" | "PROCESSING"; createdAt?: Date } = {}) {
  const row = await db.photo.create({ data: { uploaderId: uploader, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 5, status: data.status ?? "READY", kind: data.kind ?? "PHOTO", createdAt: data.createdAt } });
  const originalPath = `photos/${row.id}/original.jpg`;
  const file = path.join(root, originalPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "bytes");
  writeFileSync(path.join(root, `photos/${row.id}/medium.webp`), "small");
  await db.photo.update({ where: { id: row.id }, data: { storageKey: `photos/${row.id}`, originalPath } });
  return { id: row.id, originalPath, file };
}

describe("moving originals to S3", { timeout: 30_000 }, () => {
  beforeEach(async () => {
    await resetTestDb();
    for (const entry of readdirSync(root)) rmSync(path.join(root, entry), { recursive: true, force: true });
    remote.objects.clear();
    forgetCoverage();
    expect(await ensureInstallIdentity()).toMatchObject({ ok: true });
    uploader = (await db.user.create({ data: { email: "dana@example.com" } })).id;
  });

  it("moves a settled original up, records it, frees the disk and keeps the renditions", async () => {
    const a = await item();
    const r = await offloadOriginals(later());
    expect(r).toMatchObject({ offloaded: 1, evicted: 1, failed: 0 });
    expect(remote.objects.get(`live/${a.originalPath}`)?.storageClass).toBe("STANDARD");
    expect(existsSync(a.file)).toBe(false);
    expect(existsSync(path.join(root, `photos/${a.id}/medium.webp`))).toBe(true);
    expect(await db.originalCopy.findUniqueOrThrow({ where: { photoId: a.id } })).toMatchObject({ key: a.originalPath, bytes: BigInt(5), storageClass: "STANDARD" });
    // Nothing left to do on the next run.
    expect(await offloadOriginals(later())).toMatchObject({ offloaded: 0, evicted: 0 });
  });

  it("sends an old album's backlog straight to Glacier Instant Retrieval", async () => {
    const old = await item({ createdAt: new Date(Date.now() - 400 * DAY) });
    await offloadOriginals(later());
    expect(remote.objects.get(`live/${old.originalPath}`)?.storageClass).toBe("GLACIER_IR");
  });

  it("leaves alone what is still being processed, what was just processed, and an external video's poster", async () => {
    await item({ status: "PROCESSING" });
    await item({ kind: "EXTERNAL_VIDEO" });
    const fresh = await item();
    expect(await offloadOriginals(new Date())).toMatchObject({ offloaded: 0 });
    expect(await offloadOriginals(later())).toMatchObject({ offloaded: 1 });
    expect(remote.objects.has(`live/${fresh.originalPath}`)).toBe(true);
    expect(remote.objects.size).toBe(1);
  });

  it("frees a copy fetched back for work once it has sat unused, but not before", async () => {
    const a = await item();
    await offloadOriginals(later());
    const { storage, localFileOf } = await import("@/lib/storage");
    await localFileOf(storage() as never, a.originalPath);
    expect(existsSync(a.file)).toBe(true);
    expect(await offloadOriginals(new Date())).toMatchObject({ evicted: 0 });
    expect(existsSync(a.file)).toBe(true);
    expect(await offloadOriginals(later())).toMatchObject({ evicted: 1 });
    expect(existsSync(a.file)).toBe(false);
  });

  it("records an original already in S3 from a run that died before recording it, and reports one that is nowhere", async () => {
    const a = await item();
    remote.objects.set(`live/${a.originalPath}`, { body: Buffer.from("bytes"), storageClass: "STANDARD" });
    rmSync(a.file);
    const lost = await item();
    rmSync(lost.file);
    const r = await offloadOriginals(later());
    expect(r).toMatchObject({ recorded: 1, failed: 1 });
    expect(await db.originalCopy.findUnique({ where: { photoId: a.id } })).not.toBeNull();
    expect(await db.originalCopy.findUnique({ where: { photoId: lost.id } })).toBeNull();
  });

  it("does nothing on a storage root that is not this database's", async () => {
    const a = await item();
    rmSync(path.join(root, ".album-install-id"));
    utimesSync(root, new Date(), new Date());
    expect(await offloadOriginals(later())).toMatchObject({ offloaded: 0 });
    expect(existsSync(a.file)).toBe(true);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
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
    const stranded = await row({ createdAt: old });
    mkdirSync(path.join(root, "photos", stranded.id), { recursive: true });
    writeFileSync(path.join(root, "photos", stranded.id, "original.jpg"), "part");
    const recent = await row({});
    const queued = await row({ createdAt: old, storageKey: "photos/q", originalPath: "photos/q/original.jpg", sizeBytes: 9 });
    const failed = await row({ createdAt: old, status: "FAILED", sourceKind: "GOOGLE_PICKER" });
    expect(await sweepStrandedUploads()).toBe(1);
    expect(existsSync(path.join(root, "photos", stranded.id))).toBe(false);
    expect((await db.photo.findMany({ select: { id: true } })).map((p) => p.id).sort()).toEqual([recent.id, queued.id, failed.id].sort());
  });
});

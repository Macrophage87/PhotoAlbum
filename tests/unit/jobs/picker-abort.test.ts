import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

/** A Picker download pg-boss has timed out stops at the next item, leaving the rest (and the session) to its retry. */
const photoRoot = mkdtempSync(path.join(tmpdir(), "picker-abort-"));
process.env.PHOTO_STORAGE_ROOT = photoRoot;
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));
const google = vi.hoisted(() => ({ download: vi.fn(), deleted: [] as string[] }));
vi.mock("@/lib/google/account", () => ({ accessTokenFor: async () => "tok", noteAuthFailure: async () => false }));
vi.mock("@/lib/google/picker", async (orig) => ({ ...(await orig()) as object, openDownload: google.download, deletePickerSession: async (_t: string, id: string) => { google.deleted.push(id); } }));

import { googlePickerImport } from "@/lib/jobs/handlers/google-picker-import";

describe("a timed-out Picker download", () => {
  beforeEach(async () => {
    await resetTestDb();
    google.download.mockReset();
    google.deleted.length = 0;
  });

  it("stops before the next item and keeps the session for the retry", async () => {
    const userId = (await db.user.create({ data: { email: "pa@example.com", role: "MEMBER" } })).id;
    const ids: string[] = [];
    const items: Record<string, unknown> = {};
    for (const n of [1, 2]) {
      const row = await db.photo.create({ data: { uploaderId: userId, kind: "PHOTO", sourceKind: "GOOGLE_PICKER", sourceId: `gp-${n}`, status: "PENDING", originalName: `p${n}.jpg`, mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 0 }, select: { id: true } });
      ids.push(row.id);
      items[row.id] = { id: `gp-${n}`, type: "PHOTO", baseUrl: `https://lh3.test/${n}`, mimeType: "", filename: "", createTime: null, width: null, height: null };
    }
    const ac = new AbortController();
    google.download.mockImplementation(async () => {
      ac.abort();
      return new Response(new Uint8Array(10).fill(1), { status: 200 });
    });
    await googlePickerImport({ userId, sessionId: "s1", photoIds: ids, items }, ac.signal);
    expect(google.download).toHaveBeenCalledTimes(1);
    // One item was stored; the other is still waiting for the retry, untouched.
    expect(await db.photo.count({ where: { id: { in: ids }, status: "PENDING", originalPath: "pending" } })).toBe(1);
    expect(google.deleted).toEqual([]);
  });

  it("fails the items it never reached when it was the last attempt", async () => {
    const userId = (await db.user.create({ data: { email: "pa@example.com", role: "MEMBER" } })).id;
    const ids: string[] = [];
    const items: Record<string, unknown> = {};
    for (const n of [1, 2]) {
      const row = await db.photo.create({ data: { uploaderId: userId, kind: "PHOTO", sourceKind: "GOOGLE_PICKER", sourceId: `gp-${n}`, status: "PENDING", originalName: `p${n}.jpg`, mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 0 }, select: { id: true } });
      ids.push(row.id);
      items[row.id] = { id: `gp-${n}`, type: "PHOTO", baseUrl: `https://lh3.test/${n}`, mimeType: "", filename: "", createTime: null, width: null, height: null };
    }
    const ac = new AbortController();
    google.download.mockImplementation(async () => {
      ac.abort();
      return new Response(new Uint8Array(10).fill(1), { status: 200 });
    });
    await googlePickerImport({ userId, sessionId: "s1", photoIds: ids, items }, ac.signal, { finalAttempt: true });
    const rows = await db.photo.findMany({ where: { id: { in: ids } }, select: { status: true, error: true } });
    expect(rows.filter((r) => r.status === "FAILED")).toEqual([{ status: "FAILED", error: "Download from Google Photos took too long. Pick it again in Google Photos to fetch it." }]);
    expect(await db.photo.count({ where: { id: { in: ids }, originalPath: "pending" } })).toBe(1);
  });
});

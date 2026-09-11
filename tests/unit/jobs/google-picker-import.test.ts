import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "picker-photos-"));
process.env.PHOTO_STORAGE_ROOT = photoRoot;
process.env.MAX_UPLOAD_BYTES = "1000";
const enqueued = vi.hoisted(() => [] as { queue: string; data: unknown }[]);
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown) => { enqueued.push({ queue, data }); } }));
const google = vi.hoisted(() => ({ token: vi.fn(), download: vi.fn(), deleted: [] as string[], noted: [] as unknown[] }));
vi.mock("@/lib/google/account", () => ({
  accessTokenFor: google.token,
  noteAuthFailure: async (_u: string, err: unknown) => { const hit = (err as { needsReconnect?: boolean })?.needsReconnect === true; if (hit) google.noted.push(err); return hit; },
}));
vi.mock("@/lib/google/picker", async (orig) => ({ ...(await orig()) as object, openDownload: google.download, deletePickerSession: async (_t: string, id: string) => { google.deleted.push(id); } }));

import { googlePickerImport } from "@/lib/jobs/handlers/google-picker-import";
import { GoogleAuthError } from "@/lib/google/oauth";

const body = (bytes: number) => new Response(new Uint8Array(bytes).fill(1), { status: 200 });

describe("the Picker download job", () => {
  let userId: string;
  const items: Record<string, unknown> = {};
  let ids: string[];
  beforeEach(async () => {
    await resetTestDb();
    enqueued.length = 0; google.deleted.length = 0; google.noted.length = 0;
    google.token.mockReset().mockResolvedValue("tok");
    google.download.mockReset();
    userId = (await db.user.create({ data: { email: "pk@example.com", role: "MEMBER" } })).id;
    ids = [];
    for (const n of [1, 2, 3]) {
      const row = await db.photo.create({ data: { uploaderId: userId, kind: n === 3 ? "VIDEO" : "PHOTO", sourceKind: "GOOGLE_PICKER", sourceId: `gp-${n}`, status: "PENDING", originalName: n === 3 ? "c.mp4" : `p${n}.jpg`, mimeType: n === 3 ? "video/mp4" : "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 0 }, select: { id: true } });
      ids.push(row.id);
      items[row.id] = { id: `gp-${n}`, type: n === 3 ? "VIDEO" : "PHOTO", baseUrl: `https://lh3.test/${n}`, mimeType: "", filename: "", createTime: null, width: null, height: null };
    }
  });
  const job = () => ({ userId, sessionId: "s1", photoIds: ids, items });
  const statuses = async () => (await db.photo.findMany({ where: { id: { in: ids } }, orderBy: { sourceId: "asc" }, select: { status: true, error: true, sizeBytes: true } }));

  it("stores each item, queues processing for photos and transcoding for clips, and ends the session", async () => {
    google.download.mockImplementation(async () => body(10));
    await googlePickerImport(job());
    const rows = await statuses();
    expect(rows.map((r) => r.status)).toEqual(["PENDING", "PENDING", "PENDING"]);
    expect(rows.map((r) => r.sizeBytes)).toEqual([10, 10, 10]);
    expect(enqueued.map((e) => e.queue)).toEqual(["process-photo", "process-photo", "transcode-video"]);
    expect(google.deleted).toEqual(["s1"]);
  });
  it("fails one item and carries on when its download breaks, and reports an oversize file", async () => {
    google.download.mockImplementation(async (_t: string, item: { id: string }) => {
      if (item.id === "gp-1") throw new Error("socket hang up");
      if (item.id === "gp-2") return body(5000);
      return body(10);
    });
    await googlePickerImport(job());
    const rows = await statuses();
    expect(rows[0]).toMatchObject({ status: "FAILED", error: "Download from Google Photos failed." });
    expect(rows[1]).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Larger than/) });
    expect(rows[2]).toMatchObject({ status: "PENDING", sizeBytes: 10 });
    expect(enqueued.map((e) => e.queue)).toEqual(["transcode-video"]);
  });
  it("stops at a 401 mid-way, fails the rest, and notes the account needs reconnecting", async () => {
    google.download.mockImplementation(async (_t: string, item: { id: string }) => {
      if (item.id === "gp-2") throw new GoogleAuthError("refused (401)", true);
      return body(10);
    });
    await googlePickerImport(job());
    const rows = await statuses();
    expect(rows.map((r) => r.status)).toEqual(["PENDING", "FAILED", "FAILED"]);
    expect(rows[1].error).toBe("Google Photos needs to be connected again.");
    expect(rows[2].error).toBe("Google Photos needs to be connected again.");
    expect(google.noted).toHaveLength(1);
    expect(google.download).toHaveBeenCalledTimes(2);
  });
  it("fails every row when no access token can be had", async () => {
    google.token.mockRejectedValue(new GoogleAuthError("gone", true));
    await googlePickerImport(job());
    expect((await statuses()).every((r) => r.status === "FAILED" && r.error === "Google Photos needs to be connected again.")).toBe(true);
    expect(google.download).not.toHaveBeenCalled();
  });
  it("skips rows the job carries no item for and rows already downloaded", async () => {
    google.download.mockImplementation(async () => body(10));
    const rest = Object.fromEntries(Object.entries(items).filter(([id]) => id !== ids[0]));
    await db.photo.update({ where: { id: ids[1] }, data: { originalPath: "photos/x/original.jpg" } });
    await googlePickerImport({ userId, sessionId: "s1", photoIds: ids, items: rest });
    expect(google.download).toHaveBeenCalledTimes(1);
    expect((await statuses())[0].status).toBe("PENDING");
  });
});

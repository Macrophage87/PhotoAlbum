import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "picker-photos-"));
process.env.PHOTO_STORAGE_ROOT = photoRoot;
process.env.MAX_UPLOAD_BYTES = "1000";
const enqueued = vi.hoisted(() => [] as { queue: string; data: unknown }[]);
const refuse = vi.hoisted(() => ({ queue: null as string | null }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown) => { if (refuse.queue === queue) throw new Error("queue unavailable"); enqueued.push({ queue, data }); } }));
const google = vi.hoisted(() => ({ token: vi.fn(), download: vi.fn(), list: vi.fn(), deleted: [] as string[], forgotten: 0 }));
vi.mock("@/lib/google/account", () => ({
  accessTokenFor: google.token,
  forgetAccessToken: () => { google.forgotten++; },
}));
vi.mock("@/lib/google/picker", async (orig) => ({ ...(await orig()) as object, openDownload: google.download, listPickedItems: google.list, deletePickerSession: async (_t: string, id: string) => { google.deleted.push(id); } }));

import { googlePickerImport } from "@/lib/jobs/handlers/google-picker-import";
import { GoogleAuthError } from "@/lib/google/oauth";

const body = (bytes: number) => new Response(new Uint8Array(bytes).fill(1), { status: 200 });

describe("the Picker download job", () => {
  let userId: string;
  const items: Record<string, unknown> = {};
  let ids: string[];
  beforeEach(async () => {
    await resetTestDb();
    enqueued.length = 0; google.deleted.length = 0; google.forgotten = 0; refuse.queue = null;
    google.token.mockReset().mockResolvedValue("tok");
    google.download.mockReset();
    google.list.mockReset().mockResolvedValue([]);
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
    expect(rows[0]).toMatchObject({ status: "FAILED", error: "Download from Google Photos failed. Pick it again in Google Photos to fetch it." });
    expect(rows[1]).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Larger than/) });
    expect(rows[2]).toMatchObject({ status: "PENDING", sizeBytes: 10 });
    expect(enqueued.map((e) => e.queue)).toEqual(["transcode-video"]);
  });
  it("asks for the token afresh for each item, and after a 401 refreshes it and tries once more", async () => {
    let n = 0;
    google.token.mockImplementation(async () => `tok-${++n}`);
    google.download.mockImplementation(async (token: string, item: { id: string }) => {
      // The token the job started with runs out while the second item is on its way.
      if (item.id === "gp-2" && token === "tok-3") throw new GoogleAuthError("refused (401)", true);
      return body(10);
    });
    await googlePickerImport(job());
    expect((await statuses()).map((r) => r.status)).toEqual(["PENDING", "PENDING", "PENDING"]);
    expect(google.forgotten).toBe(1);
    expect(google.download).toHaveBeenCalledTimes(4);
  });
  it("fails only the item when Google keeps refusing its download, and never calls the connection lost", async () => {
    google.download.mockImplementation(async (_t: string, item: { id: string }) => {
      if (item.id === "gp-2") throw new GoogleAuthError("refused (401)", true);
      return body(10);
    });
    await googlePickerImport(job());
    const rows = await statuses();
    expect(rows.map((r) => r.status)).toEqual(["PENDING", "FAILED", "PENDING"]);
    expect(rows[1].error).toBe("Google Photos refused the download. Pick it again in Google Photos to fetch it.");
    expect(enqueued).toHaveLength(2);
  });
  it("stops and fails the rest when refreshing the token is turned down", async () => {
    let n = 0;
    google.token.mockImplementation(async () => { if (++n > 2) throw new GoogleAuthError("invalid_grant", true); return "tok"; });
    google.download.mockImplementation(async () => body(10));
    await googlePickerImport(job());
    const rows = await statuses();
    expect(rows.map((r) => r.status)).toEqual(["PENDING", "FAILED", "FAILED"]);
    expect(rows[2].error).toBe("Google Photos needs to be connected again.");
    expect(google.download).toHaveBeenCalledTimes(1);
  });
  it("gets fresh addresses for the items when Google refuses an old one (403), and carries on", async () => {
    google.download.mockImplementation(async (_t: string, item: { baseUrl: string }) => {
      if (!item.baseUrl.includes("fresh")) throw new GoogleAuthError("refused (403)", false);
      return body(10);
    });
    google.list.mockResolvedValue([1, 2, 3].map((n) => ({ id: `gp-${n}`, type: n === 3 ? "VIDEO" : "PHOTO", baseUrl: `https://lh3.test/fresh-${n}`, mimeType: "", filename: "", createTime: null, width: null, height: null })));
    await googlePickerImport(job());
    expect((await statuses()).map((r) => r.status)).toEqual(["PENDING", "PENDING", "PENDING"]);
    expect(google.list).toHaveBeenCalledTimes(1);
  });
  it("passes by a row another job took while this one waited, and leaves it alone", async () => {
    google.download.mockImplementation(async (_t: string, item: { id: string }) => {
      // While the first item downloads, a job queued by picking again takes the second.
      if (item.id === "gp-1") await db.photo.update({ where: { id: ids[1] }, data: { status: "PROCESSING" } });
      return body(10);
    });
    await googlePickerImport(job());
    expect(google.download).toHaveBeenCalledTimes(2);
    const rows = await statuses();
    expect(rows[1]).toMatchObject({ status: "PROCESSING", sizeBytes: 0 });
  });
  it("puts a row back to having no file when its processing cannot be queued after the download", async () => {
    google.download.mockImplementation(async () => body(10));
    refuse.queue = "transcode-video";
    await googlePickerImport(job());
    const clip = await db.photo.findUniqueOrThrow({ where: { id: ids[2] } });
    expect(clip).toMatchObject({ status: "FAILED", originalPath: "pending", storageKey: "pending", sizeBytes: 0 });
    expect(existsSync(path.join(photoRoot, "photos", ids[2]))).toBe(false);
  });
  it("takes back its own rows a crashed run left half-taken, but not ones another download is working on", async () => {
    google.download.mockImplementation(async () => body(10));
    // One abandoned long ago by a run that died; one taken a moment ago by a download still going.
    await db.photo.update({ where: { id: ids[0] }, data: { status: "PROCESSING", updatedAt: new Date(Date.now() - 60 * 60_000) } });
    await db.photo.update({ where: { id: ids[1] }, data: { status: "PROCESSING" } });
    await googlePickerImport(job());
    const rows = await statuses();
    expect(rows[0]).toMatchObject({ status: "PENDING", sizeBytes: 10 });
    expect(rows[1]).toMatchObject({ status: "PROCESSING", sizeBytes: 0 });
  });
  it("downloads nothing once pg-boss has given up on the job", async () => {
    google.download.mockImplementation(async () => body(10));
    await googlePickerImport(job(), AbortSignal.abort());
    expect(google.download).not.toHaveBeenCalled();
    expect((await statuses()).map((r) => r.status)).toEqual(["PENDING", "PENDING", "PENDING"]);
  });
  it("does not put back a row somebody else took after this job's download failed", async () => {
    google.download.mockImplementation(async (_t: string, item: { id: string }) => {
      if (item.id !== "gp-1") return body(10);
      // The sweep (or a re-pick) takes the row while this download is failing.
      await db.photo.update({ where: { id: ids[0] }, data: { status: "FAILED", error: "taken by someone else" } });
      throw new Error("socket hang up");
    });
    await googlePickerImport(job());
    expect((await statuses())[0]).toMatchObject({ status: "FAILED", error: "taken by someone else" });
  });
  it("does not write its file onto a row somebody else took while it downloaded, nor queue it", async () => {
    google.download.mockImplementation(async (_t: string, item: { id: string }) => {
      if (item.id === "gp-1") await db.photo.update({ where: { id: ids[0] }, data: { status: "FAILED", error: "taken over" } });
      return body(10);
    });
    await googlePickerImport(job());
    expect((await statuses())[0]).toMatchObject({ status: "FAILED", error: "taken over", sizeBytes: 0 });
    expect(enqueued.map((e) => (e.data as { photoId: string }).photoId)).not.toContain(ids[0]);
  });
  it("leaves no bytes behind, and does not touch the new holder's file, when its row is taken over mid-download", async () => {
    // What the row's new holder has already put in place.
    const theirs = path.join(photoRoot, "photos", ids[0], "original.jpg");
    mkdirSync(path.dirname(theirs), { recursive: true });
    writeFileSync(theirs, "theirs");
    google.download.mockImplementation(async (_t: string, item: { id: string }) => {
      if (item.id === "gp-1") await db.photo.update({ where: { id: ids[0] }, data: { status: "PENDING", originalPath: `photos/${ids[0]}/original.jpg`, storageKey: `photos/${ids[0]}` } });
      return body(10);
    });
    await googlePickerImport(job());
    expect(readFileSync(theirs, "utf8")).toBe("theirs");
    const incoming = path.join(photoRoot, "incoming");
    expect(existsSync(incoming) ? readdirSync(incoming) : []).toEqual([]);
    // The rows it kept are in place and nothing else is waiting in incoming/.
    expect(existsSync(path.join(photoRoot, "photos", ids[1], "original.jpg"))).toBe(true);
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

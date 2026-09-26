import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "p@example.com", name: null, role: "MEMBER" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/google/account", () => ({ accessTokenFor: async () => "tok", noteAuthFailure: async () => false, disconnectGoogleAccount: async () => undefined }));
const picked = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("@/lib/google/picker", async (orig) => ({
  ...(await orig()) as object,
  getPickerSession: async () => ({ id: "s1", mediaItemsSet: true, deadline: Date.now() + 60_000 }),
  listPickedItems: async () => picked.items,
}));
const queue = vi.hoisted(() => ({ fail: false, sent: [] as { photoIds: string[] }[] }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (_q: string, data: { photoIds: string[] }) => { if (queue.fail) throw new Error("queue unavailable"); queue.sent.push(data); return "job"; } }));

import { pollPickerSession } from "@/app/google/actions";

const item = (n: number) => ({ id: `gp-${n}`, type: "PHOTO", baseUrl: `https://lh3.test/${n}`, mimeType: "image/jpeg", filename: `p${n}.jpg`, createTime: null, width: null, height: null });

describe("finishing a Picker session", () => {
  beforeEach(async () => {
    await resetTestDb();
    queue.fail = false; queue.sent.length = 0;
    picked.items = [item(1), item(2)];
    who.id = (await db.user.create({ data: { email: "p@example.com", role: "MEMBER" } })).id;
  });

  it("takes back the rows it made when the download cannot be queued, so picking again fetches them", async () => {
    queue.fail = true;
    expect((await pollPickerSession("s1", null)).state).toBe("error");
    expect(await db.photo.count()).toBe(0);
    queue.fail = false;
    const r = await pollPickerSession("s1", null);
    expect(r).toMatchObject({ state: "queued", skipped: 0 });
    expect(await db.photo.count()).toBe(2);
  });

  it("queues again an item of theirs whose file never arrived, rather than calling it already in the album", async () => {
    // One left waiting by an earlier poll that failed, one whose download failed, and one that did arrive.
    const base = { uploaderId: who.id, sourceKind: "GOOGLE_PICKER" as const, mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 0 };
    const waiting = await db.photo.create({ data: { ...base, sourceId: "gp-1", status: "PENDING", originalName: "p1.jpg" } });
    const failed = await db.photo.create({ data: { ...base, sourceId: "gp-2", status: "FAILED", error: "Download from Google Photos failed.", originalName: "p2.jpg" } });
    await db.photo.create({ data: { ...base, sourceId: "gp-3", status: "READY", originalName: "p3.jpg", storageKey: "photos/x", originalPath: "photos/x/original.jpg", sizeBytes: 9 } });
    picked.items = [item(1), item(2), item(3)];
    const r = await pollPickerSession("s2", null);
    expect(r).toMatchObject({ state: "queued", skipped: 1 });
    expect(queue.sent[0].photoIds.sort()).toEqual([waiting.id, failed.id].sort());
    expect(await db.photo.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ status: "PENDING", error: null });
    expect(await db.photo.count()).toBe(3);
  });

  it("makes a row of its own for an item another member picked whose file never arrived, and leaves theirs alone", async () => {
    const other = await db.user.create({ data: { email: "o@example.com", role: "MEMBER" } });
    const theirs = await db.photo.create({ data: { uploaderId: other.id, sourceKind: "GOOGLE_PICKER", sourceId: "gp-1", status: "FAILED", error: "x", originalName: "p1.jpg", mimeType: "image/jpeg", storageKey: "pending", originalPath: "pending", sizeBytes: 0 } });
    const r = await pollPickerSession("s4", null);
    expect(r).toMatchObject({ state: "queued", skipped: 0 });
    expect(queue.sent[0].photoIds).not.toContain(theirs.id);
    expect(queue.sent[0].photoIds).toHaveLength(2);
    expect(await db.photo.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ status: "FAILED", uploaderId: other.id });
  });
  it("does not count an item in the trash as already in the album", async () => {
    await db.photo.create({ data: { uploaderId: who.id, sourceKind: "GOOGLE_PICKER", sourceId: "gp-1", status: "READY", originalName: "p1.jpg", mimeType: "image/jpeg", storageKey: "photos/y", originalPath: "photos/y/original.jpg", sizeBytes: 9, trashedAt: new Date(), trashReason: "OTHER" } });
    const r = await pollPickerSession("s3", null);
    expect(r).toMatchObject({ state: "queued", skipped: 0 });
    expect((r as { photoIds: string[] }).photoIds).toHaveLength(2);
  });
});

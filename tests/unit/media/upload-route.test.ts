import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "upload-route-"));
process.env.PHOTO_STORAGE_ROOT = photoRoot;
process.env.MAX_UPLOAD_BYTES = "1000";
process.env.MAX_SCAN_UPLOAD_BYTES = "5000";
const viewer = vi.hoisted(() => ({ kind: "user" as const, user: { id: "", email: "u@example.com", name: null as string | null, role: "MEMBER" as "MEMBER" | "ADMIN" } }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => viewer }));
const queued = vi.hoisted(() => ({ jobs: [] as { queue: string; data: { photoId: string } }[], fail: false }));
// No pg-boss here: no job is waiting for anything.
vi.mock("@/lib/jobs/live", () => ({ hasLiveProcessingJob: async () => false }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: { photoId: string }) => { if (queued.fail) throw new Error("queue unavailable"); queued.jobs.push({ queue, data }); return "job"; } }));
const claim = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/media/content-hash", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/media/content-hash");
  return { claimContentHash: async (...args: Parameters<typeof real.claimContentHash>) => { if (claim.fail) throw new Error("database went away"); return real.claimContentHash(...args); } };
});
const filing = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/photos/file-existing", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/photos/file-existing");
  return { ...real, fileExisting: async (...args: Parameters<typeof real.fileExisting>) => { if (filing.fail) throw new Error("database went away"); return real.fileExisting(...args); } };
});

import { POST } from "@/app/api/upload/route";

function upload(body: BodyInit | ReadableStream<Uint8Array>, name = "a.jpg", headers: Record<string, string> = {}, signal?: AbortSignal) {
  return POST(new Request("http://album.test/api/upload", { method: "POST", body, headers: { "x-file-name": name, ...headers }, signal, duplex: "half" } as RequestInit));
}
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);
/** Everything left under photos/: no file, and no empty folder either, may outlive the row that wanted it. */
const leftovers = () => (existsSync(path.join(photoRoot, "photos")) ? readdirSync(path.join(photoRoot, "photos")) : []);
const settles = <T,>(p: Promise<T>) => Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), 3000))]);

describe("the upload route", () => {
  beforeEach(async () => {
    await resetTestDb();
    rmSync(path.join(photoRoot, "photos"), { recursive: true, force: true });
    filing.fail = false;
    claim.fail = false;
    queued.fail = false;
    queued.jobs.length = 0;
    viewer.user.id = (await db.user.create({ data: { email: "u@example.com", role: "MEMBER" } })).id;
  });

  it("ends, and leaves no row or file, when the body breaks off part-way", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes(100)); setTimeout(() => c.error(new Error("client went away")), 20); },
    });
    const r = await settles(upload(body));
    expect(r).not.toBe("hung");
    expect((r as Response).status).toBe(500);
    expect(await db.photo.count()).toBe(0);
    expect(leftovers()).toEqual([]);
  });

  it("ends when the client aborts mid-file, even though the body never errors by itself", async () => {
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes(100)); } });
    const pending = upload(body, "a.jpg", {}, ac.signal);
    setTimeout(() => ac.abort(), 20);
    const r = await settles(pending);
    expect(r).not.toBe("hung");
    expect((r as Response).status).toBe(499);
    expect(await db.photo.count()).toBe(0);
    expect(leftovers()).toEqual([]);
  });

  it("removes the stored original when a step after storing fails", async () => {
    claim.fail = true;
    const r = await upload(bytes(10), "a.jpg");
    expect(r.status).toBe(500);
    expect(await db.photo.count()).toBe(0);
    expect(leftovers()).toEqual([]);
  });

  it("keeps a photo once it has its hash, whatever fails after, since another upload may already point at it", async () => {
    const collection = await db.collection.create({ data: { slug: "c", title: "C", themeKey: "default", createdById: viewer.user.id } });
    filing.fail = true;
    const r = await upload(bytes(10), "a.jpg", { "x-collection-id": collection.id });
    expect(r.status).toBe(200);
    expect(await db.photo.count()).toBe(1);
    queued.fail = true;
    filing.fail = false;
    expect((await upload(bytes(11), "b.jpg")).status).toBe(500);
    expect(await db.photo.findFirstOrThrow({ where: { originalName: "b.jpg" } })).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Re-process/) });
  });

  it("queues processing again when the same file arrives for a photo that failed", async () => {
    const first = await (await upload(bytes(30, 9), "f.jpg")).json();
    // Failed a while ago, so pg-boss has stopped retrying it. (The same row failing just now is left to those retries.)
    await db.photo.update({ where: { id: first.photoId }, data: { status: "FAILED", error: "boom", updatedAt: new Date(Date.now() - 10 * 60_000) } });
    queued.jobs.length = 0;
    const again = await (await upload(bytes(30, 9), "g.jpg")).json();
    expect(again).toMatchObject({ photoId: first.photoId, duplicate: true, status: "PENDING" });
    expect(queued.jobs.map((j) => j.data.photoId)).toEqual([first.photoId]);
    expect(await db.photo.findUniqueOrThrow({ where: { id: first.photoId } })).toMatchObject({ status: "PENDING", error: null });
  });

  it("leaves no empty folder behind a file refused for size", async () => {
    const r = await upload(bytes(2000));
    expect(r.status).toBe(413);
    expect(leftovers()).toEqual([]);
  });

  it("holds a 3D scan to the scan limit, not the photo one", async () => {
    expect((await upload(bytes(3000), "splat.ply")).status).toBe(200);
    expect((await upload(bytes(3000, 2), "big.jpg")).status).toBe(413);
    expect((await upload(bytes(6000, 3), "huge.ply")).status).toBe(413);
  });

  it("answers a member's own retry after a lost answer as their upload, still processing, not as already in the album", async () => {
    const first = await (await upload(bytes(40, 4), "retry.jpg")).json();
    const again = await (await upload(bytes(40, 4), "retry.jpg", { "x-upload-attempt": "2" })).json();
    expect(again).toMatchObject({ photoId: first.photoId, duplicate: false, status: "PENDING" });
    expect(await db.photo.count()).toBe(1);
    // The same file chosen a second time, rather than retried, is one the album already has.
    expect(await (await upload(bytes(40, 4), "retry.jpg")).json()).toMatchObject({ photoId: first.photoId, duplicate: true, status: "PENDING" });
    // Somebody else sending the same file is told it is already there, with where it stands.
    viewer.user.id = (await db.user.create({ data: { email: "v@example.com", role: "MEMBER" } })).id;
    await db.photo.update({ where: { id: first.photoId }, data: { status: "READY" } });
    const theirs = await (await upload(bytes(40, 4), "retry.jpg")).json();
    expect(theirs).toMatchObject({ photoId: first.photoId, duplicate: true, status: "READY" });
  });
});

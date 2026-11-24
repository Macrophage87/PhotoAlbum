import { readdir } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { storage } from "@/lib/storage";
import { makeRenditions } from "@/lib/images/renditions";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ viewer: null as unknown as Viewer }));
const queued = vi.hoisted(() => [] as { queue: string; data: unknown; opts: unknown }[]);
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => who.viewer, getApiViewer: async () => who.viewer }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown, opts: unknown) => void queued.push({ queue, data, opts }) }));

import { GET as bytes } from "@/app/api/photos/[id]/[size]/route";
import { castUrl } from "@/lib/cast/link";
import { CAST_ADDRESS, receiverScript } from "@/lib/cast/receiver-page";
import { forgetVisitorFiles } from "@/lib/images/visitor-copy";
import { makeVisitorCopy } from "@/lib/jobs/handlers/visitor-copy";

const run = Date.now().toString(36);
const fetchUrl = async (url: string) => {
  const [, id, size] = /^\/api\/photos\/([^/]+)\/([^?]+)/.exec(url)!;
  const res = await bytes(new Request(`http://album.test${url}`), { params: Promise.resolve({ id, size }) });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
};
const row = (id: string) => db.photo.findUniqueOrThrow({ where: { id } });
const copies = async (key: string) => (await readdir(storage().localPath!(key))).filter((n) => /^(tv|visitor)-/.test(n)).sort();
const sized = async (buf: Buffer) => {
  const m = await sharp(buf).metadata();
  return [m.width, m.height];
};

/**
 * A 4K television is sent more than the medium copy: a copy no bigger than its screen, made once by the worker and
 * kept beside the file. Any other television, and every other asker, gets what it always did.
 */
describe("a photograph for a 4K television", () => {
  let uploaderId: string, tripId: string;
  let n = 0;

  beforeAll(async () => {
    await resetTestDb();
    const u = await db.user.create({ data: { email: "gran@example.com", name: "Gran", role: "MEMBER" } });
    uploaderId = u.id;
    tripId = (await db.trip.create({ data: { slug: "cottage", title: "Cottage", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: u.id } })).id;
  });
  beforeEach(() => {
    who.viewer = { kind: "anonymous", user: null, shareTokens: new Map() };
    queued.length = 0;
  });

  async function upload(width: number, height: number, edits: Parameters<typeof makeRenditions>[3] = null) {
    const key = `tv-test/${run}-${++n}`;
    const store = storage();
    const original = await sharp({ create: { width, height, channels: 3, background: "#3a7" } }).withExif({ IFD0: { ImageDescription: "SECRET-caption" } }).jpeg().toBuffer();
    await store.putBuffer(`${key}/original.jpg`, original);
    const made = await makeRenditions(original, key, (k, b) => store.putBuffer(k, b), edits);
    const photo = await db.photo.create({ data: { tripId, uploaderId, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: key, originalPath: `${key}/original.jpg`, sizeBytes: original.length, status: "READY", width: made.width, height: made.height, renditions: made.renditions, ...(edits ? { edits, editedAt: new Date() } : {}) } });
    return { id: photo.id, key };
  }
  const work = async (id: string) => makeVisitorCopy({ photoId: id, imageVersion: (await row(id)).imageVersion, tv: true });

  it("is the medium, kept by nobody, until the worker has made it, and then a picture as big as the screen", async () => {
    const { id, key } = await upload(6000, 4000);
    const url = `${await castUrl(await row(id))}&w=3840`;
    expect(CAST_ADDRESS.test(url)).toBe(true);
    const first = await fetchUrl(url);
    expect(first.res.status).toBe(200);
    expect(await sized(first.body)).toEqual([1600, 1067]);
    expect(first.res.headers.get("Cache-Control")).toBe("private, no-store");
    const version = (await row(id)).imageVersion;
    expect(queued).toEqual([{ queue: "visitor-copy", data: { photoId: id, imageVersion: version, tv: true }, opts: { singletonKey: `tv:${id}:${version}`, singletonSeconds: 3600 } }]);
    expect(await copies(key)).toEqual([]);

    await work(id);
    expect(await copies(key)).toEqual([expect.stringMatching(/^tv-\d+-[0-9a-f]{8}\.jpg$/)]);
    queued.length = 0;
    const then = await fetchUrl(url);
    expect(then.res.status).toBe(200);
    expect(then.res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(await sized(then.body)).toEqual([3840, 2560]);
    expect(then.res.headers.get("Cache-Control")).toBe("private, max-age=86400");
    expect(then.body.includes("SECRET-caption")).toBe(false);
    expect(queued).toEqual([]);
  });

  it("is not asked for by a television that did not say it is 4K, nor given without the slideshow's link", async () => {
    const { id, key } = await upload(6000, 4000);
    await work(id);
    const plain = await fetchUrl(await castUrl(await row(id)));
    expect(await sized(plain.body)).toEqual([1600, 1067]);
    expect((await fetchUrl(`/api/photos/${id}/preview?v=1&w=3840&cast=1.nope`)).res.status).not.toBe(200);
    expect(await copies(key)).toHaveLength(1);
  });

  it("is never bigger than the picture, and is not made of one hardly bigger than its medium copy", async () => {
    const mid = await upload(3000, 2000);
    await work(mid.id);
    expect(await sized((await fetchUrl(`${await castUrl(await row(mid.id))}&w=3840`)).body)).toEqual([3000, 2000]);

    const small = await upload(1700, 1100);
    await work(small.id);
    expect(await copies(small.key)).toEqual([expect.stringMatching(/^tv-\d+-[0-9a-f]{8}\.withheld$/)]);
    const got = await fetchUrl(`${await castUrl(await row(small.id))}&w=3840`);
    expect(await sized(got.body)).toEqual([1600, 1035]);
    expect(queued).toEqual([]);
  });

  it("sits beside a visitor's copy, each cleared out with its own kind, and both when the picture changes", async () => {
    const { id, key } = await upload(6000, 4000);
    const version = (await row(id)).imageVersion;
    await work(id);
    await makeVisitorCopy({ photoId: id, imageVersion: version });
    const both = await copies(key);
    expect(both.map((f) => f.split("-")[0])).toEqual(["tv", "visitor"]);
    // Made again: nothing is lost, nothing doubled.
    await work(id);
    expect(await copies(key)).toEqual(both);
    expect(await forgetVisitorFiles(key, version + 1)).toBe(2);
    expect(await copies(key)).toEqual([]);
  });

  it("is asked for by the television's page only on a screen that could show it", () => {
    const sent = (width: number, ratio: number) => {
      const made: string[] = [];
      const el = () => ({ style: {}, textContent: "", addEventListener() {}, getAttribute: () => null, removeAttribute() {}, appendChild() {}, set src(v: string) { made.push(v); }, play: () => Promise.resolve(), pause() {}, load() {} });
      const els: Record<string, ReturnType<typeof el>> = {};
      let listener: (e: unknown) => void = () => undefined;
      const ctx = { sendCustomMessage() {}, addCustomMessageListener: (_: string, f: typeof listener) => (listener = f), addEventListener() {}, getSenders: () => [1], start() {}, stop() {} };
      const cast = { framework: { CastReceiverContext: { getInstance: () => ctx }, CastReceiverOptions: function () {}, system: { EventType: {}, MessageType: {} } } };
      const g = globalThis as Record<string, unknown>;
      const before = [g.window, g.Image];
      g.window = { innerWidth: width, innerHeight: (width * 9) / 16, devicePixelRatio: ratio };
      g.Image = function (this: { src: string }) { Object.defineProperty(this, "src", { set: (v: string) => void made.push(v) }); };
      try {
        new Function("cast", "document", receiverScript())(cast, { getElementById: (id: string) => (els[id] ??= el()), createElement: el });
        listener({ senderId: "s", data: { type: "photo", id: "p", url: "/api/photos/p/preview?v=1&cast=1.x" } });
      } finally {
        [g.window, g.Image] = before;
      }
      return { made, screen: els.screen?.textContent };
    };
    expect(sent(1280, 1.5)).toEqual({ made: ["/api/photos/p/preview?v=1&cast=1.x"], screen: "1920 × 1080" });
    expect(sent(1280, 3)).toEqual({ made: ["/api/photos/p/preview?v=1&cast=1.x&w=3840"], screen: "3840 × 2160" });
  });
});

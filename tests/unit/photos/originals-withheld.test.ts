import path from "node:path";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { shareKey } from "@/lib/auth/access";
import { storage } from "@/lib/storage";
import { makeRenditions, type Renditions } from "@/lib/images/renditions";
import { readExif } from "@/lib/images/exif";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ viewer: null as unknown as Viewer }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => who.viewer }));

import { GET as bytes } from "@/app/api/photos/[id]/[size]/route";
import { GET as infoRoute, type PhotoInfo } from "@/app/api/photos/[id]/info/route";
import { toGridPhoto } from "@/components/photos/toGrid";
import type { PhotoCard } from "@/lib/photos/queries";

const fx = (name: string) => path.join(__dirname, "../../fixtures", name);
const anon = (tokens: [string, string][] = []): Viewer => ({ kind: "anonymous", user: null, shareTokens: new Map(tokens) });

async function fetchBytes(id: string, size: string, query = "") {
  const res = await bytes(new Request(`http://album.test/api/photos/${id}/${size}?v=1${query}`), { params: Promise.resolve({ id, size }) });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}
const info = async (id: string, query = "") => (await (await infoRoute(new Request(`http://album.test/api/photos/${id}/info${query}`), { params: Promise.resolve({ id }) })).json()) as PhotoInfo;

/**
 * The file as uploaded carries the camera's GPS, and whatever a crop or "remove place" took out of the picture the
 * album shows. It is the family's: anybody else asking for it gets the largest rendition, which carries nothing.
 */
describe("the file as uploaded, for somebody outside the family", () => {
  let member: Viewer, plainId: string, editedId: string, clipId: string, tripId: string, original: Buffer, renditions: Renditions, edited: Renditions;

  beforeAll(async () => {
    await resetTestDb();
    const u = await db.user.create({ data: { email: "jo@example.com", name: "Jo", role: "MEMBER" } });
    member = { kind: "user", user: { id: u.id, email: u.email, name: u.name, role: "MEMBER" }, shareTokens: new Map() };
    tripId = (await db.trip.create({ data: { slug: "coast", title: "Coast", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: u.id, visibility: "PUBLIC" } })).id;
    const store = storage();
    original = await readFile(fx("photo-with-gps.jpg"));
    const put = (key: string, buf: Buffer) => store.putBuffer(key, buf);
    await put("withheld/plain/original.jpg", original);
    await put("withheld/edited/original.jpg", original);
    renditions = (await makeRenditions(original, "withheld/plain", put)).renditions;
    edited = (await makeRenditions(original, "withheld/edited", put, { crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } })).renditions;
    const mk = (name: string, extra: Record<string, unknown>) => db.photo.create({ data: { tripId, uploaderId: u.id, originalName: name, mimeType: "image/jpeg", storageKey: `withheld/${name}`, originalPath: `withheld/${name}/original.jpg`, sizeBytes: original.length, status: "READY", ...extra } });
    plainId = (await mk("plain", { renditions })).id;
    editedId = (await mk("edited", { renditions: edited, edits: { crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } } })).id;
    await put("withheld/clip/original.mov", Buffer.from("the phone's own file, location and all"));
    await put("withheld/clip/video.mp4", await readFile(fx("clip.mp4")));
    await put("withheld/clip/poster.jpg", await readFile(fx("clip-poster.jpg")));
    clipId = (await db.photo.create({ data: { tripId, uploaderId: u.id, kind: "VIDEO", originalName: "clip.mov", mimeType: "video/quicktime", storageKey: "withheld/clip", originalPath: "withheld/clip/original.mov", sizeBytes: 1, status: "READY", renditions, videoRenditions: { mp4: { key: "withheld/clip/video.mp4", w: 320, h: 240, bytes: 1 }, poster: { key: "withheld/clip/poster.jpg" } } } })).id;
  });

  it("writes renditions with no EXIF or GPS on them", async () => {
    expect((await readExif(original)).lat).not.toBeNull();
    for (const r of [renditions.thumb, renditions.medium, edited.full!, edited.source!]) {
      const buf = await readFile(storage().localPath!(r.key));
      const meta = await sharp(buf).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect((await readExif(buf)).lat).toBeNull();
    }
  });

  it("still hands a member the original", async () => {
    who.viewer = member;
    const { res, body } = await fetchBytes(plainId, "original");
    expect(res.status).toBe(200);
    expect(body.equals(original)).toBe(true);
    expect(res.headers.get("Content-Disposition")).toContain("plain");
    // The same address answers others differently, so no shared cache may keep it.
    expect(res.headers.get("Cache-Control")).toMatch(/^private/);
    expect(res.headers.get("Vary")).toBe("Cookie");
    expect((await fetchBytes(editedId, "source")).body.equals(await readFile(storage().localPath!(edited.source!.key)))).toBe(true);
    expect((await fetchBytes(clipId, "original")).body.toString()).toContain("location and all");
  });

  for (const [label, viewer, query] of [
    ["a visitor", () => anon(), ""],
    ["a link holder", () => anon([[shareKey("trip", "x"), "tok"]]), ""],
    ["a link preview's token", () => anon(), "&share=tok&kind=trip"],
    ["a member reading a share page", () => member, "&view=share"],
  ] as const) {
    it(`gives ${label} the largest rendition in place of the original, the edited file or the uncropped copy`, async () => {
      who.viewer = viewer();
      const plain = await fetchBytes(plainId, "original", query);
      expect(plain.res.status).toBe(200);
      expect(plain.body.equals(await readFile(storage().localPath!(renditions.medium.key)))).toBe(true);
      expect(plain.res.headers.get("Content-Type")).toBe("image/webp");
      expect(plain.res.headers.get("Content-Disposition")).toBeNull();
      expect(plain.res.headers.get("Cache-Control")).toMatch(/^private/);
      const full = await readFile(storage().localPath!(edited.full!.key));
      expect((await fetchBytes(editedId, "original", query)).body.equals(full)).toBe(true);
      expect((await fetchBytes(editedId, "edited", query)).body.equals(full)).toBe(true);
      // The editor's copy is the picture before its crop: the medium, which has the crop, answers instead.
      expect((await fetchBytes(editedId, "source", query)).body.equals(await readFile(storage().localPath!(edited.medium.key)))).toBe(true);
      // A clip's own file is the phone's, location and all: the transcode (made with no metadata) answers.
      const clip = await fetchBytes(clipId, "original", query);
      expect(clip.res.headers.get("Content-Type")).toBe("video/mp4");
      expect(clip.body.toString()).not.toContain("location and all");
    });
  }

  it("does not hand a visitor, or a member on a share page, the original's address", async () => {
    who.viewer = anon();
    const out = await info(editedId);
    expect(out.uneditedUrl).toBeNull();
    expect(out.originalUrl).toContain(`/api/photos/${editedId}/edited?`);
    expect((await info(plainId)).originalUrl).toBeNull();
    who.viewer = member;
    const mine = await info(editedId);
    expect(mine.uneditedUrl).toContain("/original?");
    expect((await info(plainId)).originalUrl).toContain("/original?");
  });

  it("links a visitor's grid tile to the largest rendition, never the original", async () => {
    const card = { id: plainId, kind: "PHOTO", status: "READY", updatedAt: new Date(), edits: null, renditions, uploader: null, collections: [] } as unknown as PhotoCard;
    expect(toGridPhoto(card, null, true).originalUrl).toContain("/original?");
    expect(toGridPhoto(card).originalUrl).toBeNull();
    expect(toGridPhoto({ ...card, edits: {}, renditions: edited } as PhotoCard).originalUrl).toContain("/edited?");
    expect(toGridPhoto({ ...card, renditions: { ...renditions, pano: { key: "p.webp", w: 4096, h: 800 } } } as PhotoCard).originalUrl).toContain("/pano?");
  });
});

import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { storage } from "@/lib/storage";
import { makeRenditions, WEBP_MAX_SIDE, type Renditions } from "@/lib/images/renditions";
import { readExif } from "@/lib/images/exif";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ viewer: null as unknown as Viewer }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => who.viewer }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => undefined }));

import { GET as bytes } from "@/app/api/photos/[id]/[size]/route";
import { GET as infoRoute, type PhotoInfo } from "@/app/api/photos/[id]/info/route";
import { cleanCopy, iccDescription, renderCleanCopy, writeCleanCopy, type CleanCopySource } from "@/lib/images/clean-copy";
import { processPhoto } from "@/lib/jobs/handlers/process-photo";
import { fullSizeUrl } from "@/lib/photos/urls";

const fx = (name: string) => path.join(__dirname, "../../fixtures", name);
const anon = (): Viewer => ({ kind: "anonymous", user: null, shareTokens: new Map() });
const SECRET = "SECRET-Grandmas-House";
const XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${SECRET}-xmp</dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

async function fetchBytes(id: string, size: string, query = "") {
  const res = await bytes(new Request(`http://album.test/api/photos/${id}/${size}?v=1${query}`), { params: Promise.resolve({ id, size }) });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}
const info = async (id: string) => (await (await infoRoute(new Request(`http://album.test/api/photos/${id}/info`), { params: Promise.resolve({ id }) })).json()) as PhotoInfo;
const row = (id: string) => db.photo.findUniqueOrThrow({ where: { id }, select: { id: true, imageVersion: true, updatedAt: true, storageKey: true, originalPath: true, originalName: true, mimeType: true, edits: true, renditions: true } });
const folder = async (key: string) => (await readdir(storage().localPath!(key))).sort();
const cleanFiles = async (key: string) => (await folder(key)).filter((n) => /^full-/.test(n));

/**
 * What a phone hands over: 3000 × 2000 pixels stored on their side (the camera says to turn them), the GPS and a
 * description in EXIF, a title in XMP, a wide-gamut colour profile, and the family's own file name.
 */
async function phoneFile(): Promise<Buffer> {
  return sharp(fx("photo-with-gps.jpg"))
    .resize({ width: 3000, height: 2000, fit: "fill" })
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { ImageDescription: `${SECRET}-exif` } })
    .withIccProfile("p3")
    .withXmp(XMP)
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * A visitor gets every photograph at the size a member does, as a copy with none of the file on it: the uploaded
 * file's EXIF and GPS, its XMP, its name and whatever a crop took out stay with the family.
 */
describe("the full-size picture for a visitor", () => {
  let uploaderId: string, tripId: string, file: Buffer, member: Viewer;
  let n = 0;

  beforeAll(async () => {
    await resetTestDb();
    const u = await db.user.create({ data: { email: "gran@example.com", name: "Gran", role: "MEMBER" } });
    uploaderId = u.id;
    member = { kind: "user", user: { id: u.id, email: u.email, name: u.name, role: "MEMBER" }, shareTokens: new Map() };
    tripId = (await db.trip.create({ data: { slug: "cottage", title: "Cottage", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: u.id, visibility: "PUBLIC" } })).id;
    file = await phoneFile();
  });
  beforeEach(() => {
    who.viewer = anon();
  });

  /** A processed photograph, as the upload leaves it: the file, its renditions, and a row. */
  async function upload(extra: Record<string, unknown> = {}, original = file, name = `${SECRET}.jpg`, edits: Parameters<typeof makeRenditions>[3] = null) {
    const key = `clean-test/${++n}`;
    const store = storage();
    await store.deletePrefix(key);
    await store.putBuffer(`${key}/original.jpg`, original);
    const { renditions, width, height } = await makeRenditions(original, key, (k, b) => store.putBuffer(k, b), edits);
    const photo = await db.photo.create({ data: { tripId, uploaderId, originalName: name, mimeType: "image/jpeg", storageKey: key, originalPath: `${key}/original.jpg`, sizeBytes: original.length, status: "READY", width, height, renditions, lat: 44.35, lng: -68.2, gpsSource: "EXIF", ...(edits ? { edits, editedAt: new Date() } : {}), ...extra } });
    return { id: photo.id, key, renditions };
  }

  it("is the whole picture, upright, with no EXIF, GPS, XMP or file name on it", async () => {
    expect((await readExif(file)).lat).not.toBeNull();
    const { id, key, renditions } = await upload();
    expect(renditions.full).toBeUndefined();
    const before = await row(id);

    const { res, body } = await fetchBytes(id, "edited");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("Content-Disposition")).toBeNull();
    // Whether it is this or the file depends on who asks: never a shared cache.
    expect(res.headers.get("Cache-Control")).toMatch(/^private/);
    expect(res.headers.get("Vary")).toBe("Cookie");

    const meta = await sharp(body).metadata();
    // The member's file is 3000 × 2000 turned on its side: the same pixels, the right way up, none left out.
    expect([meta.width, meta.height]).toEqual([2000, 3000]);
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect((await readExif(body)).lat).toBeNull();
    expect(body.includes(SECRET)).toBe(false);
    // The wide-gamut profile is the one thing that comes with it, so its colours are the file's.
    expect(iccDescription(meta.icc)).toBe("sP3C");

    // Kept, and the picture's addresses moved on as for any new rendition; nobody changed the item, though.
    const after = await row(id);
    expect((after.renditions as Renditions).full).toMatchObject({ w: 2000, h: 3000 });
    expect(after.imageVersion).toBeGreaterThan(before.imageVersion);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((after.renditions as Renditions).full!.key).not.toContain(SECRET);

    // The file as uploaded, asked for by name, is answered the same way.
    expect((await fetchBytes(id, "original")).body.equals(body)).toBe(true);
    // Made once: asking again hands back the same file and leaves the row alone.
    expect((await fetchBytes(id, "edited")).body.equals(body)).toBe(true);
    expect((await row(id)).imageVersion).toBe(after.imageVersion);
    expect(await cleanFiles(key)).toHaveLength(1);
  });

  it("links a visitor to it from the lightbox and the info panel, where a member still gets the file", async () => {
    const { id } = await upload();
    const photo = await row(id);
    expect(fullSizeUrl(photo, false)).toBe(`/api/photos/${id}/edited?v=${photo.imageVersion}`);
    expect(fullSizeUrl({ ...photo, renditions: null }, false)).toBeNull();
    expect((await info(id)).originalUrl).toContain(`/api/photos/${id}/edited?`);
    who.viewer = member;
    expect((await info(id)).originalUrl).toContain(`/api/photos/${id}/original?`);
    // A member asking for the file gets exactly the file, name and all, and no copy is made for them.
    const { res, body } = await fetchBytes(id, "original");
    expect(body.equals(file)).toBe(true);
    expect(res.headers.get("Content-Disposition")).toContain(SECRET);
    expect((await row(id)).renditions).not.toHaveProperty("full");
    // …but a member reading a share page is answered as its visitors are.
    const shared = await fetchBytes(id, "original", "&view=share");
    expect(shared.body.equals(file)).toBe(false);
    expect((await sharp(shared.body).metadata()).exif).toBeUndefined();
  });

  it("has the crop on it, the member's own full size exactly", async () => {
    const crop = { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } };
    const { id, renditions } = await upload({}, file, `${SECRET}.jpg`, crop);
    const { body } = await fetchBytes(id, "original");
    expect(body.equals(await readFile(storage().localPath!(renditions.full!.key)))).toBe(true);
    expect([renditions.full!.w, renditions.full!.h]).toEqual([1000, 1500]);
    who.viewer = member;
    expect((await fetchBytes(id, "edited")).body.equals(body)).toBe(true);
  });

  it("has a crop on it that was saved while the renditions were still being made again", async () => {
    // Saved, not yet rendered: what the visitor is given follows the crop, not the picture before it.
    const { id } = await upload({ edits: { crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }, editedAt: new Date() });
    const { body } = await fetchBytes(id, "edited");
    const meta = await sharp(body).metadata();
    expect([meta.width, meta.height]).toEqual([1000, 1500]);
    expect(meta.exif).toBeUndefined();
    // An edited picture is in sRGB everywhere else, and so is this.
    expect(meta.icc).toBeUndefined();
  });

  it("carries no position after the place is removed", async () => {
    // "Remove place" takes the position off the row; the file still has the camera's GPS, which is why it is never given.
    const { id } = await upload({ lat: null, lng: null, altitude: null, gpsSource: null, placeSetById: uploaderId, placeName: null });
    const { body } = await fetchBytes(id, "edited");
    const exif = await readExif(body);
    expect([exif.lat, exif.lng]).toEqual([null, null]);
    expect((await sharp(body).metadata()).exif).toBeUndefined();
    expect((await info(id)).lat).toBeNull();
  });

  it("is made once for visitors arriving together", async () => {
    const { id, key } = await upload();
    const before = await row(id);
    const answers = await Promise.all(Array.from({ length: 5 }, () => fetchBytes(id, "edited")));
    for (const a of answers) {
      expect(a.res.status).toBe(200);
      expect(a.body.equals(answers[0].body)).toBe(true);
    }
    expect((await row(id)).imageVersion).toBeGreaterThan(before.imageVersion);
    expect(await cleanFiles(key)).toHaveLength(1);
  });

  it("is claimed by one making when two server processes race, and the other's file is deleted", async () => {
    const { id, key } = await upload();
    const snapshot = (await row(id)) as CleanCopySource;
    // Called past the sharing of one making, as two processes would each make their own.
    const [a, b] = await Promise.all([writeCleanCopy(snapshot), writeCleanCopy(snapshot)]);
    expect(a).toEqual(b);
    const after = await row(id);
    expect((after.renditions as Renditions).full).toEqual(a);
    expect(after.imageVersion).toBeGreaterThan(snapshot.imageVersion);
    expect(await cleanFiles(key)).toEqual([path.basename(a!.key)]);
  });

  it("is never put on a row that changed while it was being made", async () => {
    const { id, key } = await upload();
    const snapshot = (await row(id)) as CleanCopySource;
    // A crop saved meanwhile: a copy made without it must not be handed out.
    await db.photo.update({ where: { id }, data: { edits: { crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }, editedAt: new Date() } });
    expect(await writeCleanCopy(snapshot)).toBeNull();
    // A re-render meanwhile, likewise.
    const again = (await row(id)) as CleanCopySource;
    await db.photo.update({ where: { id }, data: { imageVersion: { increment: 1 } } });
    expect(await writeCleanCopy(again)).toBeNull();
    expect((await row(id)).renditions).not.toHaveProperty("full");
    expect(await cleanFiles(key)).toEqual([]);
  });

  it("is dropped when the picture is rendered again, and made afresh with the new edits", async () => {
    const { id, key } = await upload();
    const first = await fetchBytes(id, "edited");
    expect(await cleanFiles(key)).toHaveLength(1);
    // A member crops it: the edits are saved and the renditions made again from the file.
    await db.photo.update({ where: { id }, data: { edits: { crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }, editedAt: new Date() } });
    const version = (await row(id)).imageVersion;
    await processPhoto({ photoId: id, mode: "renditions" });
    const after = await row(id);
    expect(after.imageVersion).toBeGreaterThan(version);
    expect((after.renditions as Renditions).full!.key).toBe(`${key}/edited.webp`);
    expect(await cleanFiles(key)).toEqual([]);
    const second = await fetchBytes(id, "edited");
    expect(second.body.equals(first.body)).toBe(false);
    expect([(await sharp(second.body).metadata()).width, (await sharp(second.body).metadata()).height]).toEqual([1000, 1500]);
    // Put back as it was, it is made again for the next visitor, uncropped.
    await db.$executeRaw`UPDATE "Photo" SET edits = NULL, "editedAt" = NULL WHERE id = ${id}`;
    await processPhoto({ photoId: id, mode: "renditions" });
    expect((await row(id)).renditions).not.toHaveProperty("full");
    const third = await fetchBytes(id, "edited");
    expect([(await sharp(third.body).metadata()).width, (await sharp(third.body).metadata()).height]).toEqual([2000, 3000]);
  }, 60_000);

  it("is made from the decoded picture of a HEIC, never its bytes", async () => {
    const heic = Buffer.concat([Buffer.from("....ftypheic"), Buffer.from(`${SECRET} GPS 44.35 -68.2`)]);
    const { id, key } = await upload({ mimeType: "image/heic" }, file, `${SECRET}.heic`);
    const store = storage();
    // What the upload decoded it into, beside the file; the file itself is not a picture sharp could read.
    await store.putBuffer(`${key}/original-converted.jpg`, await sharp(file).rotate().jpeg({ quality: 92 }).toBuffer());
    await store.putBuffer(`${key}/original.heic`, heic);
    await db.photo.update({ where: { id }, data: { originalPath: `${key}/original.heic` } });
    const { res, body } = await fetchBytes(id, "original");
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(body.includes(SECRET)).toBe(false);
    const meta = await sharp(body).metadata();
    expect([meta.width, meta.height]).toEqual([2000, 3000]);
    expect(meta.exif).toBeUndefined();
  });

  it("does not take the place of a scan's model or a clip's transcode", async () => {
    const { id } = await upload({ kind: "VIDEO", videoRenditions: { mp4: { key: "clean-test/none.mp4", w: 1, h: 1, bytes: 1 }, poster: { key: "clean-test/none.jpg" } } });
    expect((await fetchBytes(id, "original")).res.status).toBe(404);
    expect((await row(id)).renditions).not.toHaveProperty("full");
  });

  it("is nothing for an item not processed yet", async () => {
    const { id } = await upload();
    await db.$executeRaw`UPDATE "Photo" SET renditions = NULL WHERE id = ${id}`;
    expect(await cleanCopy((await row(id)) as CleanCopySource)).toBeNull();
    expect((await fetchBytes(id, "edited")).res.status).toBe(404);
  });
});

describe("rendering the clean copy", () => {
  it("keeps a panorama's length past what WebP can hold, as JPEG", async () => {
    const src = await sharp({ create: { width: 17000, height: 1200, channels: 3, background: { r: 90, g: 120, b: 160 } } }).jpeg().toBuffer();
    const out = await renderCleanCopy(src, null);
    expect(out.ext).toBe("jpg");
    expect([out.w, out.h]).toEqual([17000, 1200]);
    expect(out.w).toBeGreaterThan(WEBP_MAX_SIDE);
    expect((await sharp(out.data).metadata()).format).toBe("jpeg");
  }, 60_000);

  it("keeps an animation moving, as the file a member opens does", async () => {
    const frames = await Promise.all([0, 1, 2].map((i) => sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 80 * i, g: 0, b: 0 } } }).raw().toBuffer()));
    const gif = await sharp(Buffer.concat(frames), { raw: { width: 40, height: 90, channels: 3, pageHeight: 30 } }).gif().toBuffer();
    const out = await renderCleanCopy(gif, null);
    expect([out.w, out.h]).toEqual([40, 30]);
    expect((await sharp(out.data).metadata()).pages).toBe(3);
  });

  it("turns any colour profile but a published wide-gamut one into sRGB", async () => {
    const tagged = async (icc: string) => (await sharp(await sharp({ create: { width: 8, height: 8, channels: 3, background: "#c00" } }).withIccProfile(icc).jpeg().toBuffer()).metadata()).icc;
    expect(iccDescription(await tagged("srgb"))).toBe("sRGB");
    const srgbTagged = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#c00" } }).withIccProfile("srgb").jpeg().toBuffer();
    expect((await sharp((await renderCleanCopy(srgbTagged, null)).data).metadata()).icc).toBeUndefined();
    // A version 2 profile names itself in ASCII.
    const v2 = Buffer.alloc(200);
    v2.writeUInt32BE(1, 128);
    v2.write("desc", 132, "latin1");
    v2.writeUInt32BE(144, 136);
    v2.writeUInt32BE(40, 140);
    v2.write("desc", 144, "latin1");
    v2.writeUInt32BE(11, 152);
    v2.write("Display P3\0", 156, "latin1");
    expect(iccDescription(v2)).toBe("Display P3");
    expect(iccDescription(Buffer.alloc(10))).toBeNull();
    expect(iccDescription(undefined)).toBeNull();
  });
});

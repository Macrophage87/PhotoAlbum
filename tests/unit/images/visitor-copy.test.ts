import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { storage } from "@/lib/storage";
import { makeRenditions } from "@/lib/images/renditions";
import { readExif } from "@/lib/images/exif";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ viewer: null as unknown as Viewer }));
const queued = vi.hoisted(() => [] as { queue: string; data: unknown; opts: unknown }[]);
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => who.viewer }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown, opts: unknown) => void queued.push({ queue, data, opts }) }));

import { GET as bytes } from "@/app/api/photos/[id]/[size]/route";
import { GET as infoRoute, type PhotoInfo } from "@/app/api/photos/[id]/info/route";
import { iccDescription, planVisitorCopy, renderVisitorCopy, visitorStem, WEBP_MAX_PIXELS } from "@/lib/images/visitor-copy";
import { makeVisitorCopy } from "@/lib/jobs/handlers/visitor-copy";
import { toGridPhoto } from "@/components/photos/toGrid";
import type { PhotoCard } from "@/lib/photos/queries";

const fx = (name: string) => path.join(__dirname, "../../fixtures", name);
const anon = (): Viewer => ({ kind: "anonymous", user: null, shareTokens: new Map() });
const SECRET = "SECRET-Grandmas-House";
const XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${SECRET}-xmp</dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
const scratchDir = mkdtempSync(path.join(tmpdir(), "visitor-copy-"));
const scratch = () => scratchDir;
const run = Date.now().toString(36);

async function fetchBytes(id: string, size: string, query = "") {
  const res = await bytes(new Request(`http://album.test/api/photos/${id}/${size}?v=1${query}`), { params: Promise.resolve({ id, size }) });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}
const fetchUrl = async (url: string) => {
  const [, id, size] = /^\/api\/photos\/([^/]+)\/([^?]+)/.exec(url)!;
  const res = await bytes(new Request(`http://album.test${url}`), { params: Promise.resolve({ id, size }) });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
};
const info = async (id: string, query = "") => (await (await infoRoute(new Request(`http://album.test/api/photos/${id}/info${query}`), { params: Promise.resolve({ id }) })).json()) as PhotoInfo;
const row = (id: string) => db.photo.findUniqueOrThrow({ where: { id } });
const visitorFiles = async (key: string) => (await readdir(storage().localPath!(key))).filter((n) => n.startsWith("visitor-")).sort();
const size = async (buf: Buffer) => {
  const m = await sharp(buf).metadata();
  return [m.width, m.height];
};
/** The job for the picture as it is now, as the worker would run it. */
const work = async (id: string) => makeVisitorCopy({ photoId: id, imageVersion: (await row(id)).imageVersion });

/**
 * An ICC profile that says it is Display P3, with things in it that are nobody's business: a second language's
 * name, a copyright line, a tag of its own and bytes after its end. Built on the album's own P3 profile, so its colours
 * are real ones.
 */
async function craftedProfile(): Promise<Buffer> {
  const base = (await sharp(await sharp({ create: { width: 2, height: 2, channels: 3, background: "#f00" } }).withIccProfile("p3").png().toBuffer()).metadata()).icc!;
  const tags: { sig: string; data: Buffer }[] = [];
  for (let i = 0; i < base.readUInt32BE(128); i++) {
    const at = 132 + i * 12;
    const off = base.readUInt32BE(at + 4);
    tags.push({ sig: base.toString("latin1", at, at + 4), data: base.subarray(off, off + base.readUInt32BE(at + 8)) });
  }
  const mluc = (records: [string, string][]) => {
    const head = Buffer.alloc(16 + records.length * 12);
    head.write("mluc", 0, "latin1");
    head.writeUInt32BE(records.length, 8);
    head.writeUInt32BE(12, 12);
    let off = head.length;
    const bodies = records.map(([lang, text], i) => {
      const b = Buffer.from(text, "utf16le").swap16();
      head.write(lang, 16 + i * 12, "latin1");
      head.writeUInt32BE(b.length, 20 + i * 12);
      head.writeUInt32BE(off, 24 + i * 12);
      off += b.length;
      return b;
    });
    return Buffer.concat([head, ...bodies]);
  };
  const own = Buffer.alloc(8 + SECRET.length + 5);
  own.write("text", 0, "latin1");
  own.write(`${SECRET}-tag`, 8, "latin1");
  const out = tags.map((t) => (t.sig === "desc" ? { sig: "desc", data: mluc([["enUS", "Display P3"], ["frFR", `${SECRET}-mluc`]]) } : t.sig === "cprt" ? { sig: "cprt", data: mluc([["enUS", `${SECRET}-cprt`]]) } : t));
  out.push({ sig: "zzzz", data: own });
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  let offset = 132 + out.length * 12;
  const table = Buffer.alloc(4 + out.length * 12);
  table.writeUInt32BE(out.length, 0);
  const blobs = out.map((t, i) => {
    table.write(t.sig, 4 + i * 12, "latin1");
    table.writeUInt32BE(offset, 8 + i * 12);
    table.writeUInt32BE(t.data.length, 12 + i * 12);
    const d = pad(t.data);
    offset += d.length;
    return d;
  });
  const icc = Buffer.concat([Buffer.from(base.subarray(0, 128)), table, ...blobs, Buffer.from(`${SECRET}-trailing`)]);
  icc.writeUInt32BE(icc.length, 0);
  icc.fill(0, 84, 100);
  return icc;
}

/** Say in a JPEG's EXIF which way up it is, in place: sharp will not while it keeps the file's own colour profile. */
function turned(jpeg: Buffer, orientation: number): Buffer {
  const out = Buffer.from(jpeg);
  const tiff = out.indexOf("Exif\0\0") + 6;
  const le = out.toString("latin1", tiff, tiff + 2) === "II";
  const u16 = (at: number) => (le ? out.readUInt16LE(at) : out.readUInt16BE(at));
  const ifd = tiff + (le ? out.readUInt32LE(tiff + 4) : out.readUInt32BE(tiff + 4));
  for (let i = 0; i < u16(ifd); i++) {
    const at = ifd + 2 + i * 12;
    if (u16(at) !== 0x0112) continue;
    if (le) out.writeUInt16LE(orientation, at + 8);
    else out.writeUInt16BE(orientation, at + 8);
    return out;
  }
  throw new Error("no orientation tag to change");
}

/**
 * What a phone hands over: 3000 × 2000 pixels stored on their side (the camera says to turn them), the GPS and a
 * description in EXIF, a title in XMP, a wide-gamut colour profile with things of its own in it, and the family's
 * own file name. Its left half is a red no sRGB screen can show.
 */
async function phoneFile(): Promise<Buffer> {
  const profile = path.join(scratch(), "crafted.icc");
  await writeFile(profile, await craftedProfile());
  const tagged = await sharp(fx("photo-with-gps.jpg")).resize({ width: 3000, height: 2000, fit: "fill" }).withIccProfile(profile).keepExif().withExifMerge({ IFD0: { ImageDescription: `${SECRET}-exif` } }).withXmp(XMP).jpeg({ quality: 95 }).toBuffer();
  // Pushed to the edge of P3 with the profile left as it is: the numbers are P3's, not sRGB's.
  const red = await sharp({ create: { width: 1500, height: 2000, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  return turned(await sharp(tagged).composite([{ input: red, left: 0, top: 0 }]).keepMetadata().jpeg({ quality: 95 }).toBuffer(), 6);
}

/**
 * A visitor gets every photograph at the size a member does, as a copy with none of the file on it, made by the
 * worker and never by the request: until it is there, the largest rendition stands in, and is kept by nobody.
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
    queued.length = 0;
  });

  /** A processed photograph, as the upload leaves it: the file, its renditions, and a row. */
  async function upload(extra: Record<string, unknown> = {}, original = file, edits: Parameters<typeof makeRenditions>[3] = null) {
    const key = `visitor-test/${run}-${++n}`;
    const store = storage();
    await store.putBuffer(`${key}/original.jpg`, original);
    const { renditions, width, height } = await makeRenditions(original, key, (k, b) => store.putBuffer(k, b), edits);
    const photo = await db.photo.create({ data: { tripId, uploaderId, originalName: `${SECRET}.jpg`, mimeType: "image/jpeg", storageKey: key, originalPath: `${key}/original.jpg`, sizeBytes: original.length, status: "READY", width, height, renditions, lat: 44.35, lng: -68.2, gpsSource: "EXIF", ...(edits ? { edits, editedAt: new Date() } : {}), ...extra } });
    return { id: photo.id, key, renditions };
  }

  it("is the medium, kept by nobody, until the worker has made the copy; the request only asks for it", async () => {
    const { id, key, renditions } = await upload();
    const before = await row(id);
    const { res, body } = await fetchBytes(id, "edited", "&view=share");
    expect(res.status).toBe(200);
    expect(body.equals(await readFile(storage().localPath!(renditions.medium.key)))).toBe(true);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect(queued).toEqual([{ queue: "visitor-copy", data: { photoId: id, imageVersion: before.imageVersion }, opts: { singletonKey: `visitor:${id}:${before.imageVersion}`, singletonSeconds: 3600 } }]);
    // Nothing was made or written by the request.
    expect(await visitorFiles(key)).toEqual([]);
    const after = await row(id);
    expect([after.imageVersion, after.updatedAt.getTime(), after.renditions]).toEqual([before.imageVersion, before.updatedAt.getTime(), before.renditions]);
  });

  it("is then the whole picture, upright, with no EXIF, GPS, XMP, file name or profile of the file's", async () => {
    // The file is what the test says it is.
    const source = await sharp(file).metadata();
    expect([source.orientation, iccDescription(source.icc), source.icc!.includes(`${SECRET}-tag`), Boolean(source.xmp)]).toEqual([6, "Display P3", true, true]);
    expect((await readExif(file)).lat).not.toBeNull();
    const { id, key } = await upload();
    const before = await row(id);
    await work(id);
    const after = await row(id);
    // The job writes nothing on the row: not the renditions, not the version, not when it was last changed.
    expect([after.imageVersion, after.updatedAt.getTime(), after.renditions]).toEqual([before.imageVersion, before.updatedAt.getTime(), before.renditions]);
    expect(await visitorFiles(key)).toEqual([`${path.basename(visitorStem(after))}.webp`]);

    const { res, body } = await fetchBytes(id, "original");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect(res.headers.get("Cache-Control")).toMatch(/^private, max-age/);
    expect(res.headers.get("Vary")).toBe("Cookie");
    expect(queued).toEqual([]);
    const meta = await sharp(body).metadata();
    // The member's file is 3000 × 2000 on its side: the same pixels, the right way up, none left out.
    expect([meta.width, meta.height]).toEqual([2000, 3000]);
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect((await readExif(body)).lat).toBeNull();
    expect(body.includes(SECRET)).toBe(false);
    expect(body.includes(Buffer.from(SECRET, "utf16le").swap16())).toBe(false);
    // The colours are the file's, described by the album's own P3 profile rather than the file's.
    const albumP3 = (await sharp(await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } }).withIccProfile("p3").png().toBuffer()).metadata()).icc!;
    expect(meta.icc!.equals(albumP3)).toBe(true);
    expect(iccDescription(meta.icc)).toBe("sP3C");
    const [r, g, b] = await sharp(body, { ignoreIcc: true }).extract({ left: 1000, top: 200, width: 1, height: 1 }).raw().toBuffer();
    // Red past sRGB: squeezed into sRGB and back it would read about 234, 51, 34.
    expect(r).toBeGreaterThan(245);
    expect(g + b).toBeLessThan(20);
    // A member asking for the same address gets the file.
    who.viewer = member;
    expect((await fetchBytes(id, "original")).body.equals(file)).toBe(true);
  });

  it("leaves the family's own full size exactly as it was", async () => {
    who.viewer = member;
    const { id, key } = await upload();
    const plain = await fetchBytes(id, "original");
    expect(plain.body.equals(file)).toBe(true);
    expect(plain.res.headers.get("Content-Disposition")).toContain(SECRET);
    // An unedited photo's edited full size is its own file, for a member on the album's own pages and nobody else.
    expect((await fetchBytes(id, "edited")).body.equals(file)).toBe(true);
    expect((await info(id)).originalUrl).toBe(`/api/photos/${id}/original?v=${(await row(id)).imageVersion}`);
    expect(queued).toEqual([]);
    expect(await visitorFiles(key)).toEqual([]);
  });

  it("is what a member previewing a share page is linked to and given, never the file", async () => {
    const { id } = await upload();
    await work(id);
    const photo = await row(id);
    who.viewer = member;
    // The share page, and a public collection or trip, draw their tiles for nobody in particular.
    const tile = toGridPhoto({ ...photo, uploader: null, collections: [] } as unknown as PhotoCard).originalUrl!;
    expect(tile).toBe(`/api/photos/${id}/edited?v=${photo.imageVersion}&view=share`);
    const shared = await info(id, "?view=share");
    expect(shared.originalUrl).toBe(tile);
    expect(shared.uneditedUrl).toBeNull();
    for (const url of [tile, `/api/photos/${id}/original?v=1&view=share`]) {
      const { body, res } = await fetchUrl(url);
      expect(body.equals(file)).toBe(false);
      expect(res.headers.get("Content-Disposition")).toBeNull();
      expect((await sharp(body).metadata()).exif).toBeUndefined();
      expect(await size(body)).toEqual([2000, 3000]);
    }
  });

  it("gives a crop saved since the copy was made the stand-in, never the uncropped copy", async () => {
    const { id, key, renditions } = await upload();
    await work(id);
    const uncropped = (await fetchBytes(id, "edited")).body;
    expect(await size(uncropped)).toEqual([2000, 3000]);
    // Saved, not yet rendered again: the picture's version has moved, and the copy was of the one before.
    await db.photo.update({ where: { id }, data: { edits: { crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }, editedAt: new Date() } });
    queued.length = 0;
    const between = await fetchBytes(id, "edited");
    expect(between.body.equals(uncropped)).toBe(false);
    expect(between.body.equals(await readFile(storage().localPath!(renditions.medium.key)))).toBe(true);
    expect(between.res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(queued).toHaveLength(1);
    // The copy of the picture as it is now has the crop, and the old one is gone.
    await work(id);
    const cropped = (await fetchBytes(id, "edited")).body;
    expect(await size(cropped)).toEqual([1000, 1500]);
    expect(await visitorFiles(key)).toEqual([`${path.basename(visitorStem(await row(id)))}.webp`]);
  });

  it("is an edited photo's own full size, which is the member's view exactly", async () => {
    const crop = { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } };
    const { id, renditions } = await upload({}, file, crop);
    const { body } = await fetchBytes(id, "original");
    expect(body.equals(await readFile(storage().localPath!(renditions.full!.key)))).toBe(true);
    expect(queued).toEqual([]);
    who.viewer = member;
    expect((await fetchBytes(id, "edited")).body.equals(body)).toBe(true);
  });

  it("carries no position after the place is removed", async () => {
    const { id } = await upload({ lat: null, lng: null, altitude: null, gpsSource: null, placeSetById: uploaderId, placeName: null });
    await work(id);
    const { body } = await fetchBytes(id, "edited");
    expect([(await readExif(body)).lat, (await readExif(body)).lng]).toEqual([null, null]);
    expect((await info(id)).lat).toBeNull();
  });

  it("is made from the decoded picture of a HEIC, never its bytes", async () => {
    const { id, key } = await upload({ mimeType: "image/heic", originalName: `${SECRET}.heic` });
    const store = storage();
    await store.putBuffer(`${key}/original-converted.jpg`, await sharp(file).rotate().jpeg({ quality: 92 }).toBuffer());
    await store.putBuffer(`${key}/original.heic`, Buffer.from(`....ftypheic ${SECRET} GPS 44.35 -68.2`));
    await db.photo.update({ where: { id }, data: { originalPath: `${key}/original.heic` } });
    await work(id);
    const { res, body } = await fetchBytes(id, "original");
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(body.includes(SECRET)).toBe(false);
    expect(await size(body)).toEqual([2000, 3000]);
    expect((await sharp(body).metadata()).exif).toBeUndefined();
  });

  it("does not undo a member's edit made while it was being made", async () => {
    const { id } = await upload();
    await Promise.all([work(id), db.photo.update({ where: { id }, data: { title: "Gran's porch" } })]);
    expect((await row(id)).title).toBe("Gran's porch");
    // …and a change to the picture meanwhile leaves the copy of the old one unused.
    const again = await upload();
    const version = (await row(again.id)).imageVersion;
    await db.photo.update({ where: { id: again.id }, data: { tripId: null } });
    await makeVisitorCopy({ photoId: again.id, imageVersion: version });
    expect(await visitorFiles(again.key)).toEqual([]);
  });

  it("remembers a failure, and stops asking for a while", async () => {
    const { id, key } = await upload();
    await storage().putBuffer(`${key}/original.jpg`, Buffer.from("not a picture at all"));
    await expect(work(id)).rejects.toThrow();
    const failed = `${visitorStem(await row(id))}.failed`;
    expect(await storage().exists(failed)).toBe(true);
    const { res } = await fetchBytes(id, "edited");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(queued).toEqual([]);
    // Some hours on, one more try.
    const old = new Date(Date.now() - 7 * 3600_000);
    await utimes(storage().localPath!(failed), old, old);
    await fetchBytes(id, "edited");
    expect(queued).toHaveLength(1);
  });

  it("falls back for good on a picture too big to copy safely", async () => {
    // 60 megapixels to be turned upright: more than is held whole at once. Only its header is read.
    const big = await sharp({ create: { width: 10000, height: 6000, channels: 3, background: "#468" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const { id, key } = await upload({}, big);
    await work(id);
    expect(await visitorFiles(key)).toEqual([`${path.basename(visitorStem(await row(id)))}.withheld`]);
    const { res } = await fetchBytes(id, "edited");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toMatch(/^private, max-age/);
    expect(queued).toEqual([]);
  }, 60_000);

  it("falls back rather than failing when the copy goes between being found and being read", async () => {
    const { id, renditions } = await upload();
    await work(id);
    const store = storage();
    const real = store.getStream.bind(store);
    const spy = vi.spyOn(store, "getStream").mockImplementation(async (key, range) => {
      if (key.includes("/visitor-")) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return real(key, range);
    });
    try {
      const { res, body } = await fetchBytes(id, "edited");
      expect(res.status).toBe(200);
      expect(body.equals(await readFile(store.localPath!(renditions.medium.key)))).toBe(true);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    } finally {
      spy.mockRestore();
    }
  });

  it("is not made again for a photo deleted meanwhile, nor its folder", async () => {
    const { id, key } = await upload();
    const version = (await row(id)).imageVersion;
    await db.photo.delete({ where: { id } });
    await storage().deletePrefix(key);
    await makeVisitorCopy({ photoId: id, imageVersion: version });
    expect(await storage().exists(`${key}/original.jpg`)).toBe(false);
    await expect(readdir(storage().localPath!(key))).rejects.toThrow();
  });
});

describe("rendering a visitor's copy", () => {
  const out = () => path.join(scratch(), `out-${Math.random().toString(36).slice(2)}`);

  it("keeps a long panorama's length as JPEG, which is written a strip at a time", async () => {
    const src = await sharp({ create: { width: 17000, height: 1200, channels: 3, background: { r: 90, g: 120, b: 160 } } }).jpeg().toBuffer();
    const plan = (await planVisitorCopy(src, null))!;
    expect(plan.ext).toBe("jpg");
    const file = out();
    expect(await renderVisitorCopy(src, null, plan, file)).toEqual({ width: 17000, height: 1200 });
    expect((await sharp(file).metadata()).format).toBe("jpeg");
  }, 60_000);

  it("is JPEG past the pixels a WebP may be held in memory for", async () => {
    const side = Math.ceil(Math.sqrt(WEBP_MAX_PIXELS)) + 10;
    const src = await sharp({ create: { width: side, height: side, channels: 3, background: "#888" } }).jpeg().toBuffer();
    expect((await planVisitorCopy(src, null))!.ext).toBe("jpg");
  }, 60_000);

  it("keeps an animation moving, as the file a member opens does", async () => {
    const frames = await Promise.all([0, 1, 2].map((i) => sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 80 * i, g: 0, b: 0 } } }).raw().toBuffer()));
    const gif = await sharp(Buffer.concat(frames), { raw: { width: 40, height: 90, channels: 3, pageHeight: 30 } }).gif().toBuffer();
    const file = out();
    expect(await renderVisitorCopy(gif, null, (await planVisitorCopy(gif, null))!, file)).toEqual({ width: 40, height: 30 });
    expect((await sharp(file).metadata()).pages).toBe(3);
  });

  it("turns any other colour profile into sRGB, and reads a profile's name in either layout", async () => {
    const srgb = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#c00" } }).withIccProfile("srgb").jpeg().toBuffer();
    expect(iccDescription((await sharp(srgb).metadata()).icc)).toBe("sRGB");
    const file = out();
    await renderVisitorCopy(srgb, null, (await planVisitorCopy(srgb, null))!, file);
    expect((await sharp(file).metadata()).icc).toBeUndefined();
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

import path from "node:path";
import { readFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { storage } from "@/lib/storage";
import { sanitizeGlb, sanitizePly, sanitizeScan, sanitizeSpz } from "@/lib/scans/sanitize";
import { publicScanKey } from "@/lib/scans/public-copy";
import { toGridPhoto } from "@/components/photos/toGrid";
import type { PhotoCard } from "@/lib/photos/queries";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ viewer: null as unknown as Viewer }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => who.viewer }));

import { GET as bytes } from "@/app/api/photos/[id]/[size]/route";

const fx = (name: string) => path.join(__dirname, "../../fixtures", name);
const pad4 = (n: number) => (n + 3) & ~3;

/** A JPEG straight off a phone: EXIF with GPS, an XMP packet, and an IPTC block naming the city. */
async function phoneJpeg(): Promise<Buffer> {
  const jpeg = await sharp(await readFile(fx("photo-with-gps.jpg")))
    .resize(64)
    .withExif({ IFD0: { Make: "SECRET-MAKE" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "44/1 21/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "68/1 12/1 0/1" } })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="SECRET-XMP-CREATOR"/></rdf:RDF></x:xmpmeta>')
    .jpeg()
    .toBuffer();
  const city = Buffer.from("SECRET-IPTC-CITY");
  const iptc = Buffer.concat([Buffer.from([0x1c, 0x02, 0x5a, 0x00, city.length]), city]);
  const resource = Buffer.concat([Buffer.from("8BIM"), Buffer.from([0x04, 0x04, 0x00, 0x00]), Buffer.from([0, 0, 0, iptc.length]), iptc]);
  const app13 = Buffer.concat([Buffer.from("Photoshop 3.0\0"), resource]);
  const segment = Buffer.concat([Buffer.from([0xff, 0xed, (app13.length + 2) >> 8, (app13.length + 2) & 0xff]), app13]);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

/** Parse a GLB and check everything a loader relies on; returns its JSON and binary chunk. */
function parseGlb(glb: Buffer) {
  expect(glb.readUInt32LE(0)).toBe(0x46546c67);
  expect(glb.readUInt32LE(4)).toBe(2);
  expect(glb.readUInt32LE(8)).toBe(glb.length);
  const jsonLength = glb.readUInt32LE(12);
  expect(glb.readUInt32LE(16)).toBe(0x4e4f534a);
  expect(jsonLength % 4).toBe(0);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8"));
  const at = 20 + jsonLength;
  const binLength = glb.readUInt32LE(at);
  expect(glb.readUInt32LE(at + 4)).toBe(0x004e4942);
  expect(binLength % 4).toBe(0);
  expect(at + 8 + binLength).toBe(glb.length);
  const bin = glb.subarray(at + 8, at + 8 + binLength);
  expect(json.buffers).toEqual([{ byteLength: binLength }]);
  for (const v of json.bufferViews) {
    expect(v.byteOffset % 4).toBe(0);
    expect(v.byteOffset + v.byteLength).toBeLessThanOrEqual(binLength);
  }
  for (const a of json.accessors ?? []) expect(json.bufferViews[a.bufferView]).toBeDefined();
  const view = (i: number) => bin.subarray(json.bufferViews[i].byteOffset, json.bufferViews[i].byteOffset + json.bufferViews[i].byteLength);
  return { json, bin, view };
}

/** A GLB as a scanning app writes one: where and by whom in its JSON, and a camera JPEG as its texture. */
async function appGlb(texture: Buffer): Promise<{ glb: Buffer; positions: Buffer }> {
  const positions = Buffer.alloc(48);
  [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0].forEach((x, i) => positions.writeFloatLE(x, i * 4));
  const indices = Buffer.alloc(12);
  [0, 1, 2, 0, 2, 3].forEach((x, i) => indices.writeUInt16LE(x, i * 2));
  // A stray run of bytes that no view points at: nothing reads it, and it is not passed on.
  const gap = Buffer.from("SECRET-GAP-BYTES");
  const texView = { buffer: 0, byteOffset: 0, byteLength: texture.length };
  const gapAt = pad4(texture.length);
  const posAt = gapAt + pad4(gap.length);
  const idxAt = posAt + 48;
  const bin = Buffer.alloc(idxAt + 12);
  texture.copy(bin, 0);
  gap.copy(bin, gapAt);
  positions.copy(bin, posAt);
  indices.copy(bin, idxAt);
  const json = {
    asset: { version: "2.0", generator: "SECRET-APP 3.1 on iPhone 15 Pro", copyright: "SECRET-COPYRIGHT", extras: { location: "44.35,-68.2", captured: "2025-08-12" } },
    extensionsUsed: ["KHR_xmp_json_ld", "KHR_texture_transform"],
    extensions: { KHR_xmp_json_ld: { packets: [{ "dc:creator": "SECRET-XMP-JSON", "exif:GPSLatitude": "44.35" }] } },
    scene: 0,
    scenes: [{ nodes: [0], extensions: { KHR_xmp_json_ld: { packet: 0 } } }],
    nodes: [{ mesh: 0, name: "SECRET-NODE-NAME", extras: { gps: [44.35, -68.2] } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { scale: [1, 1] } } } } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 0, mimeType: "image/jpeg", name: "IMG_SECRET.jpg" }],
    accessors: [
      { bufferView: 1, componentType: 5126, count: 4, type: "VEC3", min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" },
    ],
    bufferViews: [texView, { buffer: 0, byteOffset: posAt, byteLength: 48 }, { buffer: 0, byteOffset: idxAt, byteLength: 12 }],
    buffers: [{ byteLength: bin.length }],
  };
  // accessors point at views 1 and 2; view 0 is the texture.
  json.accessors[0].bufferView = 1;
  json.accessors[1].bufferView = 2;
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(pad4(jsonBytes.length) - jsonBytes.length, 0x20)]);
  const binChunk = Buffer.concat([bin, Buffer.alloc(pad4(bin.length) - bin.length)]);
  const head = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  const body = Buffer.concat([head(jsonChunk.length, 0x4e4f534a), jsonChunk, head(binChunk.length, 0x004e4942), binChunk]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return { glb: Buffer.concat([header, body]), positions };
}

const LEAKS = ["Exif", "Photoshop 3.0", "8BIM", "xmpmeta", "SECRET", "44.35", "68.2", "KHR_xmp_json_ld", "iPhone", "2025-08-12"];

describe("cleaning a GLB for visitors", () => {
  let texture: Buffer;
  beforeAll(async () => {
    texture = await phoneJpeg();
    // The texture really does carry all three, so their absence afterwards means something.
    const meta = await sharp(texture).metadata();
    expect(meta.exif).toBeDefined();
    expect(meta.xmp).toBeDefined();
    expect(texture.includes(Buffer.from("SECRET-IPTC-CITY"))).toBe(true);
  });

  it("takes out the app's words, the XMP, the texture's EXIF, GPS, XMP and IPTC, and bytes nothing reads", async () => {
    const { glb } = await appGlb(texture);
    expect(glb.includes(Buffer.from("SECRET-GAP-BYTES"))).toBe(true);
    const clean = (await sanitizeGlb(glb))!;
    expect(clean).not.toBeNull();
    for (const leak of LEAKS) expect(clean.includes(Buffer.from(leak)), leak).toBe(false);
  });

  it("still parses as a GLB, with its geometry untouched and its texture still there", async () => {
    const { glb, positions } = await appGlb(texture);
    const { json, view } = parseGlb((await sanitizeGlb(glb))!);
    expect(json.asset).toEqual({ version: "2.0" });
    expect(json.extensionsUsed).toEqual(["KHR_texture_transform"]);
    expect(json.materials[0].pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform).toEqual({ scale: [1, 1] });
    expect(view(json.accessors[0].bufferView).equals(positions)).toBe(true);
    const tex = view(json.images[0].bufferView);
    const meta = await sharp(tex).metadata();
    expect(meta).toMatchObject({ format: "jpeg", width: 64 });
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
  });

  it("keeps the album's own fixture drawable", async () => {
    const { json, view } = parseGlb((await sanitizeGlb(await readFile(fx("scan.glb"))))!);
    expect(json.bufferViews).toHaveLength(4);
    expect(json.nodes[0].name).toBeUndefined();
    expect((await sharp(view(json.images[0].bufferView)).metadata()).format).toBe("png");
  });

  it("withholds a GLB it cannot rebuild safely, rather than guess", async () => {
    const { glb } = await appGlb(texture);
    const tampered = Buffer.from(glb);
    // A texture of a kind sharp does not write (KTX2) cannot be cleaned.
    const at = tampered.indexOf(Buffer.from('"image/jpeg"'));
    Buffer.from('"image/ktx2"').copy(tampered, at);
    expect(await sanitizeGlb(tampered)).toBeNull();
    expect(await sanitizeGlb(Buffer.from("not a glb at all"))).toBeNull();
  });
});

describe("cleaning the other formats", () => {
  it("takes a PLY's comment and obj_info lines out of its header, and leaves the points alone", () => {
    const points = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const ply = Buffer.concat([Buffer.from("ply\nformat binary_little_endian 1.0\ncomment Created by SECRET-APP at 44.35,-68.2\nobj_info SECRET-DEVICE\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n"), points]);
    const clean = sanitizePly(ply)!;
    expect(clean.toString("latin1")).not.toMatch(/comment|obj_info|SECRET|44\.35/);
    expect(clean.toString("latin1").startsWith("ply\nformat binary_little_endian 1.0\nelement vertex 1\n")).toBe(true);
    expect(clean.subarray(clean.length - points.length).equals(points)).toBe(true);
  });

  it("gives an SPZ a new gzip wrapper, without the file name the old one may carry", () => {
    const raw = Buffer.alloc(32);
    raw.writeUInt32LE(0x5053474e, 0);
    raw.writeUInt32LE(2, 4);
    const plain = gzipSync(raw);
    // The same stream with FNAME set: flags bit 3, and a zero-terminated name after the ten-byte header.
    const named = Buffer.concat([plain.subarray(0, 3), Buffer.from([plain[3] | 0x08]), plain.subarray(4, 10), Buffer.from("SECRET-Main-St-scan.spz\0"), plain.subarray(10)]);
    expect(gunzipSync(named).equals(raw)).toBe(true);
    const clean = sanitizeSpz(named)!;
    expect(clean.includes(Buffer.from("SECRET"))).toBe(false);
    expect(gunzipSync(clean).equals(raw)).toBe(true);
    expect(sanitizeSpz(gzipSync(Buffer.from("not a splat at all, just text")))).toBeNull();
  });

  it("withholds a USDZ, which it does not take apart", async () => {
    expect(await sanitizeScan("USDZ", Buffer.from("PK\u0003\u0004 usdz"))).toBeNull();
  });
});

describe("a scan's file, for somebody outside the family", () => {
  let member: Viewer, glbId: string, usdzId: string, original: Buffer;
  const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };
  const get = async (id: string, size: string, query = "") => {
    const res = await bytes(new Request(`http://album.test/api/photos/${id}/${size}?v=1${query}`), { params: Promise.resolve({ id, size }) });
    return { res, body: Buffer.from(await res.arrayBuffer()) };
  };

  beforeEach(async () => {
    await resetTestDb();
    const u = await db.user.create({ data: { email: "jo@example.com", role: "MEMBER" } });
    member = { kind: "user", user: { id: u.id, email: u.email, name: null, role: "MEMBER" }, shareTokens: new Map() };
    const trip = await db.trip.create({ data: { slug: "coast", title: "Coast", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: u.id, visibility: "PUBLIC" } });
    original = (await appGlb(await phoneJpeg())).glb;
    const store = storage();
    await store.deletePrefix("scans-test/glb");
    await store.deletePrefix("scans-test/usdz");
    await store.putBuffer("scans-test/glb/original.glb", original);
    await store.putBuffer("scans-test/usdz/original.usdz", Buffer.from("PK\u0003\u0004 a usdz with SECRET in it"));
    const mk = (key: string, fmt: "GLB" | "USDZ", mime: string) => db.photo.create({ data: { tripId: trip.id, uploaderId: u.id, kind: "SCAN", scanFormat: fmt, originalName: `SECRET-${key}.${key}`, mimeType: mime, storageKey: `scans-test/${key}`, originalPath: `scans-test/${key}/original.${key}`, sizeBytes: 1, status: "READY" } });
    glbId = (await mk("glb", "GLB", "model/gltf-binary")).id;
    usdzId = (await mk("usdz", "USDZ", "model/vnd.usdz+zip")).id;
  });

  it("hands a member the file as uploaded", async () => {
    who.viewer = member;
    expect((await get(glbId, "model")).body.equals(original)).toBe(true);
    expect((await get(glbId, "original")).body.equals(original)).toBe(true);
    expect((await get(usdzId, "model")).res.status).toBe(200);
  });

  for (const [label, viewer, query] of [
    ["a visitor", () => anon, ""],
    ["a link preview's token", () => anon, "&share=tok&kind=trip"],
    ["a member reading a share page", () => member, "&view=share"],
  ] as const) {
    it(`gives ${label} only the cleaned model, made on first asking, and never the upload or its name`, async () => {
      who.viewer = viewer();
      expect(await storage().exists(publicScanKey({ storageKey: "scans-test/glb", originalPath: "scans-test/glb/original.glb", scanFormat: "GLB" }))).toBe(false);
      const { res, body } = await get(glbId, "model", query);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("model/gltf-binary");
      expect(res.headers.get("Content-Disposition")).toBeNull();
      expect(res.headers.get("Cache-Control")).toMatch(/^private/);
      for (const leak of LEAKS) expect(body.includes(Buffer.from(leak)), leak).toBe(false);
      parseGlb(body);
      for (const size of ["original", "edited", "source"]) expect((await get(glbId, size, query)).res.status).toBe(404);
      // A USDZ has no cleaned copy: nothing at all.
      expect((await get(usdzId, "model", query)).res.status).toBe(404);
      expect((await get(usdzId, "original", query)).res.status).toBe(404);
    });
  }

  it("shows visitors a line of text in place of a USDZ, and a GLB as a scan", () => {
    const card = (fmt: string) => ({ id: "s", uploaderId: "u", kind: "SCAN", scanFormat: fmt, status: "READY", updatedAt: new Date(), edits: null, renditions: null, uploader: null, collections: [], caption: null, title: null, originalName: "x", takenAt: null, tzOffsetMin: null }) as unknown as PhotoCard;
    expect(toGridPhoto(card("USDZ")).scan?.withheld).toBe(true);
    expect(toGridPhoto(card("GLB")).scan?.withheld).toBe(false);
    expect(toGridPhoto(card("USDZ"), null, { id: "m", role: "MEMBER" }).scan?.withheld).toBe(false);
  });
});

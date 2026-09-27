import { gunzipSync, gzipSync } from "node:zlib";
import sharp from "sharp";
import type { ScanFormat } from "@/lib/media/mime";

/**
 * The copy of a 3D scan that anybody outside the family is given.
 *
 * A scan is kept exactly as it was uploaded, and what an app writes into one goes with it: a GLB's JSON can carry
 * where it was made (`extras`, an XMP packet), which app and phone made it, and names for every part; its textures
 * are ordinary JPEGs and PNGs, often straight off the phone's camera with their EXIF and GPS; a PLY's header carries
 * `comment` lines. A visitor gets a copy with all of that taken out, made once and kept beside the original, and
 * members keep the original. A format that cannot be cleaned with confidence is not given to visitors at all.
 */

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Extensions that exist to carry metadata rather than to draw anything: dropped wherever they appear. */
const METADATA_EXTENSIONS = new Set(["KHR_xmp_json_ld", "KHR_xmp", "ADOBE_xmp"]);
/**
 * Extensions whose data points into the binary chunk by byte offset rather than through a bufferView, which a
 * rebuilt chunk would silently break: a scan using one is withheld rather than served broken.
 */
const OFFSET_EXTENSIONS = new Set(["EXT_meshopt_compression", "KHR_meshopt_compression"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type GltfBufferView = { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number; [k: string]: Json | undefined };
type GltfImage = { bufferView?: number; mimeType?: string; uri?: string; [k: string]: Json | undefined };
type Gltf = { asset?: { version?: string; minVersion?: string }; buffers?: { byteLength: number; uri?: string }[]; bufferViews?: GltfBufferView[]; images?: GltfImage[]; extensionsUsed?: string[]; extensionsRequired?: string[]; [k: string]: unknown };

/** Remove `extras`, `name` and metadata extensions at every depth. Names are free text an app fills from the scene. */
function scrub(value: Json): Json {
  if (Array.isArray(value)) return value.map(scrub);
  if (value === null || typeof value !== "object") return value;
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "extras" || k === "name") continue;
    if (k === "extensions" && v && typeof v === "object" && !Array.isArray(v)) {
      const kept = Object.fromEntries(Object.entries(v).filter(([ext]) => !METADATA_EXTENSIONS.has(ext)).map(([ext, body]) => [ext, scrub(body)]));
      if (Object.keys(kept).length) out[k] = kept;
      continue;
    }
    out[k] = scrub(v);
  }
  return out;
}

/** The same picture, re-encoded by sharp, which writes no EXIF, XMP, IPTC or text chunks unless asked to. */
async function cleanImage(bytes: Buffer, mimeType: string): Promise<Buffer> {
  const img = sharp(bytes, { failOn: "none" });
  if (mimeType === "image/jpeg") return img.jpeg({ quality: 92 }).toBuffer();
  if (mimeType === "image/png") return img.png().toBuffer();
  return img.webp({ quality: 92 }).toBuffer();
}

const pad4 = (n: number) => (n + 3) & ~3;

/** A cleaned GLB, or null when it holds something this cannot clean (and so must not be handed out). */
export async function sanitizeGlb(input: Buffer): Promise<Buffer | null> {
  if (input.length < 20 || input.readUInt32LE(0) !== GLB_MAGIC || input.readUInt32LE(4) !== 2) return null;
  const total = Math.min(input.readUInt32LE(8), input.length);
  let json: Gltf | null = null;
  let bin: Buffer | null = null;
  for (let at = 12; at + 8 <= total; ) {
    const length = input.readUInt32LE(at);
    const type = input.readUInt32LE(at + 4);
    const body = input.subarray(at + 8, at + 8 + length);
    if (body.length !== length) return null;
    if (type === CHUNK_JSON && !json) json = JSON.parse(body.toString("utf8").replace(/[\s\0]+$/, "")) as Gltf;
    else if (type === CHUNK_BIN && !bin) bin = body;
    // Any other chunk is somebody's own addition, and is left behind.
    at += 8 + pad4(length);
  }
  if (!json) return null;
  const used = [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])];
  if (used.some((e) => OFFSET_EXTENSIONS.has(e))) return null;
  // Only the file's own binary chunk can be rebuilt; a buffer fetched from elsewhere or inlined as text is not handled.
  const buffers = json.buffers ?? [];
  if (buffers.length > 1 || buffers.some((b) => b.uri !== undefined)) return null;
  const views = json.bufferViews ?? [];
  if (views.some((v) => v.buffer !== 0) || (views.length && !bin)) return null;

  // Every picture, embedded or inlined, is re-encoded; one that is neither, or of a kind sharp cannot write, is not handed out.
  const images = json.images ?? [];
  const replaced = new Map<number, Buffer>();
  for (const image of images) {
    const type = image.mimeType ?? (image.uri?.match(/^data:([^;,]+)/)?.[1] ?? "");
    if (!IMAGE_TYPES.has(type)) return null;
    if (image.bufferView !== undefined) {
      if (replaced.has(image.bufferView)) continue;
      const view = views[image.bufferView];
      if (!view) return null;
      const start = view.byteOffset ?? 0;
      replaced.set(image.bufferView, await cleanImage(bin!.subarray(start, start + view.byteLength), type));
    } else if (image.uri?.startsWith("data:")) {
      const encoded = image.uri.slice(image.uri.indexOf(",") + 1);
      image.uri = `data:${type};base64,${(await cleanImage(Buffer.from(encoded, "base64"), type)).toString("base64")}`;
    } else return null;
  }

  // The binary chunk again, from the views alone: anything between or after them, which nothing reads, stays behind.
  const parts: Buffer[] = [];
  let offset = 0;
  views.forEach((view, i) => {
    const start = view.byteOffset ?? 0;
    const bytes = replaced.get(i) ?? bin!.subarray(start, start + view.byteLength);
    view.byteOffset = offset;
    view.byteLength = bytes.length;
    parts.push(bytes);
    const padded = pad4(bytes.length);
    if (padded > bytes.length) parts.push(Buffer.alloc(padded - bytes.length));
    offset += padded;
  });
  const newBin = Buffer.concat(parts);

  const cleaned = scrub(json as unknown as Json) as Gltf;
  // Which app, which phone, whose copyright: none of it is needed to draw the scan.
  cleaned.asset = { version: json.asset?.version ?? "2.0", ...(json.asset?.minVersion ? { minVersion: json.asset.minVersion } : {}) };
  for (const key of ["extensionsUsed", "extensionsRequired"] as const) {
    const kept = (json[key] ?? []).filter((e) => !METADATA_EXTENSIONS.has(e));
    if (kept.length) cleaned[key] = kept;
    else delete cleaned[key];
  }
  if (views.length) cleaned.buffers = [{ byteLength: newBin.length }];
  else delete cleaned.buffers;

  const jsonBytes = Buffer.from(JSON.stringify(cleaned), "utf8");
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(pad4(jsonBytes.length) - jsonBytes.length, 0x20)]);
  const chunks = [chunkHeader(jsonChunk.length, CHUNK_JSON), jsonChunk];
  if (views.length) chunks.push(chunkHeader(newBin.length, CHUNK_BIN), newBin);
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

function chunkHeader(length: number, type: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(length, 0);
  b.writeUInt32LE(type, 4);
  return b;
}

/** A PLY with its `comment` and `obj_info` header lines taken out; the points themselves are left as they are. */
export function sanitizePly(input: Buffer): Buffer | null {
  const end = input.indexOf("end_header");
  if (end < 0 || !input.subarray(0, 3).equals(Buffer.from("ply"))) return null;
  const newline = input.indexOf(0x0a, end);
  if (newline < 0) return null;
  const header = input.subarray(0, newline + 1).toString("latin1");
  const eol = header.includes("\r\n") ? "\r\n" : "\n";
  const kept = header.split(/\r?\n/).filter((line, i, all) => (i < all.length - 1 || line) && !/^\s*(comment|obj_info)\b/.test(line));
  return Buffer.concat([Buffer.from(kept.join(eol) + eol, "latin1"), input.subarray(newline + 1)]);
}

/**
 * An SPZ is a gzip stream of fixed arrays after a 16-byte header (magic "NGSP", version, point count, degree,
 * fractional bits, flags) — no names, no strings, nowhere for metadata to go. The gzip wrapper, though, may carry the
 * original file name and a time; recompressing drops both.
 */
export function sanitizeSpz(input: Buffer): Buffer | null {
  let raw: Buffer;
  try {
    raw = gunzipSync(input);
  } catch {
    return null;
  }
  if (raw.length < 16 || raw.readUInt32LE(0) !== 0x5053474e) return null;
  return gzipSync(raw);
}

/**
 * The visitor's copy of a scan in this format, or null when there is none to give: a USDZ is a zip of a whole USD
 * stage (with its own metadata fields, textures and any files an app adds), which this does not take apart, and an
 * unreadable file of any format is withheld rather than guessed at.
 */
export async function sanitizeScan(format: ScanFormat | null, input: Buffer): Promise<Buffer | null> {
  try {
    if (format === "GLB") return await sanitizeGlb(input);
    if (format === "PLY") return sanitizePly(input);
    if (format === "SPZ") return sanitizeSpz(input);
  } catch {
    return null;
  }
  return null;
}

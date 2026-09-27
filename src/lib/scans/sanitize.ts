import { promisify } from "node:util";
import { gzip, inflateRaw } from "node:zlib";
import sharp from "sharp";
import type { ScanFormat } from "@/lib/media/mime";

/**
 * The copy of a 3D scan that anybody outside the family is given.
 *
 * A scan is kept exactly as it was uploaded, and what an app writes into one goes with it: a GLB's JSON can carry
 * where it was made (`extras`, an XMP packet, a vendor's own extension), which app and phone made it, and names for
 * every part; its textures are ordinary JPEGs and PNGs, often straight off the phone's camera with their EXIF and
 * GPS; a PLY's header carries `comment` lines. A visitor gets a copy made of only what drawing the scan needs —
 * everything is chosen from lists of what is known to be geometry, never cleaned by removing what is known to be
 * metadata — made once and kept beside the original, and members keep the original. A file that cannot be cleaned
 * with confidence is not given to visitors at all.
 */

const gzipAsync = promisify(gzip);
const inflateRawAsync = promisify(inflateRaw);

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// ---- What a glTF 2.0 file may keep ----------------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = { value: (v: Json) => boolean } | { object: Record<string, Schema> } | { array: Schema } | { map: Schema; keys: RegExp };

const num = { value: (v: Json) => typeof v === "number" && Number.isFinite(v) };
const int = { value: (v: Json) => Number.isInteger(v) };
const bool = { value: (v: Json) => typeof v === "boolean" };
const nums = { value: (v: Json) => Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x)) };
const ints = { value: (v: Json) => Array.isArray(v) && v.every((x) => Number.isInteger(x)) };
const oneOf = (...allowed: string[]) => ({ value: (v: Json) => typeof v === "string" && allowed.includes(v) });
const obj = (props: Record<string, Schema>): Schema => ({ object: props });
const arr = (of: Schema): Schema => ({ array: of });
/** The standard attribute semantics only: an application's own (`_ANYTHING`) is free text, and nothing draws it. */
const attributes: Schema = { map: int, keys: /^(POSITION|NORMAL|TANGENT|(TEXCOORD|COLOR|JOINTS|WEIGHTS)_\d+)$/ };

const textureInfo = obj({ index: int, texCoord: int });
const normalTextureInfo = obj({ index: int, texCoord: int, scale: num });
const occlusionTextureInfo = obj({ index: int, texCoord: int, strength: num });

/**
 * Extensions that change how a scan is drawn, and what each may hold. Any other — a scanning app's own
 * (`SCANIVERSE_capture`, say, with the latitude in it), XMP, lights with their names — is dropped wherever it appears,
 * and a file that requires one is withheld.
 */
const EXTENSIONS: Record<string, Schema> = {
  KHR_texture_transform: obj({ offset: nums, rotation: num, scale: nums, texCoord: int }),
  KHR_mesh_quantization: obj({}),
  KHR_draco_mesh_compression: obj({ bufferView: int, attributes }),
  EXT_texture_webp: obj({ source: int }),
  KHR_materials_unlit: obj({}),
  KHR_materials_emissive_strength: obj({ emissiveStrength: num }),
  KHR_materials_ior: obj({ ior: num }),
  KHR_materials_dispersion: obj({ dispersion: num }),
  KHR_materials_specular: obj({ specularFactor: num, specularTexture: textureInfo, specularColorFactor: nums, specularColorTexture: textureInfo }),
  KHR_materials_transmission: obj({ transmissionFactor: num, transmissionTexture: textureInfo }),
  KHR_materials_volume: obj({ thicknessFactor: num, thicknessTexture: textureInfo, attenuationDistance: num, attenuationColor: nums }),
  KHR_materials_clearcoat: obj({ clearcoatFactor: num, clearcoatTexture: textureInfo, clearcoatRoughnessFactor: num, clearcoatRoughnessTexture: textureInfo, clearcoatNormalTexture: normalTextureInfo }),
  KHR_materials_sheen: obj({ sheenColorFactor: nums, sheenColorTexture: textureInfo, sheenRoughnessFactor: num, sheenRoughnessTexture: textureInfo }),
  KHR_materials_iridescence: obj({ iridescenceFactor: num, iridescenceTexture: textureInfo, iridescenceIor: num, iridescenceThicknessMinimum: num, iridescenceThicknessMaximum: num, iridescenceThicknessTexture: textureInfo }),
  KHR_materials_anisotropy: obj({ anisotropyStrength: num, anisotropyRotation: num, anisotropyTexture: textureInfo }),
};

/** glTF 2.0's own properties, object by object. No `name`, no `extras`: both are free text an app fills as it likes. */
const GLTF: Schema = obj({
  extensionsUsed: { value: (v) => Array.isArray(v) && v.every((x) => typeof x === "string") },
  extensionsRequired: { value: (v) => Array.isArray(v) && v.every((x) => typeof x === "string") },
  // Which app, which phone, whose copyright: none of it is needed to draw the scan.
  asset: obj({ version: oneOf("2.0"), minVersion: oneOf("2.0") }),
  scene: int,
  scenes: arr(obj({ nodes: ints })),
  nodes: arr(obj({ camera: int, children: ints, skin: int, matrix: nums, mesh: int, rotation: nums, scale: nums, translation: nums, weights: nums })),
  meshes: arr(obj({ primitives: arr(obj({ attributes, indices: int, material: int, mode: int, targets: arr(attributes) })), weights: nums })),
  materials: arr(obj({
    pbrMetallicRoughness: obj({ baseColorFactor: nums, baseColorTexture: textureInfo, metallicFactor: num, roughnessFactor: num, metallicRoughnessTexture: textureInfo }),
    normalTexture: normalTextureInfo,
    occlusionTexture: occlusionTextureInfo,
    emissiveTexture: textureInfo,
    emissiveFactor: nums,
    alphaMode: oneOf("OPAQUE", "MASK", "BLEND"),
    alphaCutoff: num,
    doubleSided: bool,
  })),
  textures: arr(obj({ sampler: int, source: int })),
  samplers: arr(obj({ magFilter: int, minFilter: int, wrapS: int, wrapT: int })),
  // A data URI is re-encoded below; any other is refused before this is reached.
  images: arr(obj({ uri: { value: (v) => typeof v === "string" && v.startsWith("data:") }, mimeType: oneOf(...IMAGE_TYPES), bufferView: int })),
  accessors: arr(obj({
    bufferView: int,
    byteOffset: int,
    componentType: int,
    normalized: bool,
    count: int,
    type: oneOf("SCALAR", "VEC2", "VEC3", "VEC4", "MAT2", "MAT3", "MAT4"),
    max: nums,
    min: nums,
    sparse: obj({ count: int, indices: obj({ bufferView: int, byteOffset: int, componentType: int }), values: obj({ bufferView: int, byteOffset: int }) }),
  })),
  bufferViews: arr(obj({ buffer: int, byteOffset: int, byteLength: int, byteStride: int, target: int })),
  buffers: arr(obj({ byteLength: int })),
  cameras: arr(obj({
    type: oneOf("perspective", "orthographic"),
    perspective: obj({ aspectRatio: num, yfov: num, zfar: num, znear: num }),
    orthographic: obj({ xmag: num, ymag: num, zfar: num, znear: num }),
  })),
  skins: arr(obj({ inverseBindMatrices: int, skeleton: int, joints: ints })),
  animations: arr(obj({
    channels: arr(obj({ sampler: int, target: obj({ node: int, path: oneOf("translation", "rotation", "scale", "weights") }) })),
    samplers: arr(obj({ input: int, interpolation: oneOf("LINEAR", "STEP", "CUBICSPLINE"), output: int })),
  })),
});

/** Only what the schema names, at every depth; `undefined` for a value it does not allow. */
function keep(value: Json | undefined, schema: Schema): Json | undefined {
  if (value === undefined) return undefined;
  if ("value" in schema) return schema.value(value) ? value : undefined;
  if ("array" in schema) return Array.isArray(value) ? value.map((v) => keep(v, schema.array) ?? {}) : undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: { [k: string]: Json } = {};
  if ("map" in schema) {
    for (const [k, v] of Object.entries(value)) {
      const kept = schema.keys.test(k) ? keep(v, schema.map) : undefined;
      if (kept !== undefined) out[k] = kept;
    }
    return out;
  }
  for (const [k, s] of Object.entries(schema.object)) {
    const kept = keep(value[k], s);
    if (kept !== undefined) out[k] = kept;
  }
  // Every object may carry extensions; only the ones that draw something are kept.
  const exts = value.extensions;
  if (exts && typeof exts === "object" && !Array.isArray(exts)) {
    const kept: { [k: string]: Json } = {};
    for (const [name, body] of Object.entries(exts)) {
      const cleaned = EXTENSIONS[name] ? keep(body, EXTENSIONS[name]) : undefined;
      if (cleaned !== undefined) kept[name] = cleaned;
    }
    if (Object.keys(kept).length) out.extensions = kept;
  }
  return out;
}

type View = { buffer?: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number };
type Cleaned = {
  bufferViews?: View[];
  buffers?: { byteLength: number }[];
  images?: { bufferView?: number; mimeType?: string; uri?: string }[];
  accessors?: { bufferView?: number; sparse?: { indices?: { bufferView?: number }; values?: { bufferView?: number } } }[];
  meshes?: { primitives?: { extensions?: { KHR_draco_mesh_compression?: { bufferView?: number } } }[] }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [k: string]: unknown;
};

/** Every place a glTF names a bufferView, as get/set pairs, so the views can be renumbered once unused ones are gone. */
function viewRefs(g: Cleaned): { get: () => number | undefined; set: (i: number) => void }[] {
  const refs: { get: () => number | undefined; set: (i: number) => void }[] = [];
  const at = <T extends { bufferView?: number }>(o: T | undefined) => o && refs.push({ get: () => o.bufferView, set: (i) => (o.bufferView = i) });
  for (const a of g.accessors ?? []) {
    at(a);
    at(a.sparse?.indices);
    at(a.sparse?.values);
  }
  for (const img of g.images ?? []) at(img);
  for (const m of g.meshes ?? []) for (const p of m.primitives ?? []) at(p.extensions?.KHR_draco_mesh_compression);
  return refs;
}

/** The same picture, the right way up, re-encoded by sharp, which writes no EXIF, XMP, IPTC or text chunks unless asked. */
async function cleanImage(bytes: Buffer, mimeType: string): Promise<Buffer> {
  const img = sharp(bytes, { failOn: "none" }).rotate();
  if (mimeType === "image/jpeg") return img.jpeg({ quality: 92 }).toBuffer();
  if (mimeType === "image/png") return img.png().toBuffer();
  return img.webp({ quality: 92 }).toBuffer();
}

const pad4 = (n: number) => (n + 3) & ~3;

/** A cleaned GLB, or null when it holds something this cannot clean (and so must not be handed out). */
export async function sanitizeGlb(input: Buffer): Promise<Buffer | null> {
  if (input.length < 20 || input.readUInt32LE(0) !== GLB_MAGIC || input.readUInt32LE(4) !== 2) return null;
  const total = Math.min(input.readUInt32LE(8), input.length);
  let json: { [k: string]: Json } | null = null;
  let bin: Buffer | null = null;
  for (let at = 12; at + 8 <= total; ) {
    const length = input.readUInt32LE(at);
    const type = input.readUInt32LE(at + 4);
    const body = input.subarray(at + 8, at + 8 + length);
    if (body.length !== length) return null;
    if (type === CHUNK_JSON && !json) json = JSON.parse(body.toString("utf8").replace(/[\s\0]+$/, ""));
    else if (type === CHUNK_BIN && !bin) bin = body;
    // Any other chunk is somebody's own addition, and is left behind.
    at += 8 + pad4(length);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  // A file that cannot be drawn without an extension this does not keep is not handed out without it.
  const required = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
  if (required.some((e) => typeof e !== "string" || !EXTENSIONS[e])) return null;
  // Only the file's own binary chunk can be rebuilt; a buffer fetched from elsewhere or inlined as text is not handled.
  const rawBuffers = Array.isArray(json.buffers) ? json.buffers : [];
  if (rawBuffers.length > 1 || rawBuffers.some((b) => b && typeof b === "object" && !Array.isArray(b) && b.uri !== undefined)) return null;

  const g = keep(json, GLTF) as Cleaned;
  if (!g.asset) g.asset = { version: "2.0" };
  for (const key of ["extensionsUsed", "extensionsRequired"] as const) {
    const kept = (g[key] ?? []).filter((e) => EXTENSIONS[e]);
    if (kept.length) g[key] = kept;
    else delete g[key];
  }
  const views = g.bufferViews ?? [];
  if (views.some((v) => (v.buffer ?? 0) !== 0 || v.byteLength === undefined) || (views.length && !bin)) return null;

  // Only views something still reads are copied: an accessor's, an image's, a kept extension's. Anything else in the
  // binary chunk — a view nobody points at, the bytes between views — stays behind.
  const refs = viewRefs(g);
  const used = [...new Set(refs.map((r) => r.get()).filter((i): i is number => i !== undefined))].sort((a, b) => a - b);
  if (used.some((i) => !views[i])) return null;

  // Every picture, embedded or inlined, is re-encoded; one that is neither, or of a kind sharp cannot write, is not handed out.
  const replaced = new Map<number, Buffer>();
  for (const image of g.images ?? []) {
    const type = image.mimeType ?? image.uri?.match(/^data:([^;,]+)/)?.[1] ?? "";
    if (!IMAGE_TYPES.has(type)) return null;
    if (image.bufferView !== undefined) {
      if (replaced.has(image.bufferView)) continue;
      const view = views[image.bufferView];
      const start = view.byteOffset ?? 0;
      replaced.set(image.bufferView, await cleanImage(bin!.subarray(start, start + view.byteLength), type));
    } else if (image.uri?.startsWith("data:")) {
      const encoded = image.uri.slice(image.uri.indexOf(",") + 1);
      image.uri = `data:${type};base64,${(await cleanImage(Buffer.from(encoded, "base64"), type)).toString("base64")}`;
    } else return null;
  }

  const renumber = new Map(used.map((old, i) => [old, i]));
  const parts: Buffer[] = [];
  const kept: View[] = [];
  let offset = 0;
  for (const old of used) {
    const view = views[old];
    const start = view.byteOffset ?? 0;
    const bytes = replaced.get(old) ?? bin!.subarray(start, start + view.byteLength);
    if (bytes.length !== view.byteLength && !replaced.has(old)) return null;
    kept.push({ ...view, buffer: 0, byteOffset: offset, byteLength: bytes.length });
    parts.push(bytes);
    const padded = pad4(bytes.length);
    if (padded > bytes.length) parts.push(Buffer.alloc(padded - bytes.length));
    offset += padded;
  }
  for (const r of refs) {
    const i = r.get();
    if (i !== undefined) r.set(renumber.get(i)!);
  }
  const newBin = Buffer.concat(parts);
  if (kept.length) {
    g.bufferViews = kept;
    g.buffers = [{ byteLength: newBin.length }];
  } else {
    delete g.bufferViews;
    delete g.buffers;
  }

  const jsonBytes = Buffer.from(JSON.stringify(g), "utf8");
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(pad4(jsonBytes.length) - jsonBytes.length, 0x20)]);
  const chunks = [chunkHeader(jsonChunk.length, CHUNK_JSON), jsonChunk];
  if (kept.length) chunks.push(chunkHeader(newBin.length, CHUNK_BIN), newBin);
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

// ---- PLY -------------------------------------------------------------------------------------------------------------

/** How far into a PLY its header may run. Real ones are a few hundred bytes. */
export const PLY_HEADER_MAX = 64 * 1024;
const PLY_KEPT = new Set(["ply", "format", "element", "property"]);

/**
 * A PLY's header with only the lines that say how to read its points (`ply`, `format`, `element`, `property`,
 * `end_header`), and where the points start. `comment`, `obj_info` and anything else go, whatever their case. Null
 * when `head` (the file's first bytes) holds no whole header.
 */
export function plyHeader(head: Buffer): { header: Buffer; bodyStart: number } | null {
  const lines: string[] = [];
  let eol = "\n";
  for (let at = 0; at < Math.min(head.length, PLY_HEADER_MAX); ) {
    const nl = head.indexOf(0x0a, at);
    if (nl < 0) return null;
    const raw = head.subarray(at, nl).toString("latin1");
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (at === 0) {
      if (line !== "ply") return null;
      if (raw.endsWith("\r")) eol = "\r\n";
    }
    at = nl + 1;
    if (line.trim().toLowerCase() === "end_header") {
      lines.push("end_header");
      return { header: Buffer.from(lines.map((l) => l + eol).join(""), "latin1"), bodyStart: at };
    }
    if (PLY_KEPT.has(line.trim().split(/\s+/)[0].toLowerCase())) lines.push(line.trim());
  }
  return null;
}

/** A PLY with only its reading instructions left in the header; the points themselves are left as they are. */
export function sanitizePly(input: Buffer): Buffer | null {
  const parsed = plyHeader(input);
  return parsed ? Buffer.concat([parsed.header, input.subarray(parsed.bodyStart)]) : null;
}

// ---- SPZ -------------------------------------------------------------------------------------------------------------

const SPZ_MAGIC = 0x5053474e; // "NGSP"
/** Spherical-harmonic coefficients per point, by degree, each stored as three bytes. */
const SH_COEFFS: Record<number, number> = { 0: 0, 1: 3, 2: 8, 3: 15 };

/** How many bytes the arrays after an SPZ's 16-byte header take, from what the header says; null for a header it does not know. */
function spzSize(raw: Buffer): number | null {
  const version = raw.readUInt32LE(4);
  const points = raw.readUInt32LE(8);
  const shCoeffs = SH_COEFFS[raw[12]];
  if (version < 1 || version > 3 || shCoeffs === undefined) return null;
  // Positions (half floats in version 1, 24-bit fixed point after), alpha, color, scale, rotation (three bytes, or
  // four from version 3), then the harmonics.
  const perPoint = (version === 1 ? 6 : 9) + 1 + 3 + 3 + (version >= 3 ? 4 : 3) + shCoeffs * 3;
  return 16 + points * perPoint;
}

/**
 * An SPZ is a gzip stream of a 16-byte header (magic "NGSP", version, point count, degree, fractional bits, flags,
 * a reserved byte) and fixed arrays — no names and no strings. What could ride along is outside that: the gzip
 * header's file name, comment and time, a second gzip member, bytes after the arrays. Only the first member is read,
 * it is cut to the size its header gives, the reserved byte is zeroed, and it is compressed again from scratch. A
 * file shorter than its header says is refused.
 */
export async function sanitizeSpz(input: Buffer): Promise<Buffer | null> {
  if (input.length < 18 || input[0] !== 0x1f || input[1] !== 0x8b || input[2] !== 8) return null;
  const flags = input[3];
  let at = 10;
  if (flags & 0x04) at += 2 + input.readUInt16LE(at); // FEXTRA
  if (flags & 0x08) at = input.indexOf(0, at) + 1; // FNAME
  if (flags & 0x10) at = input.indexOf(0, at) + 1; // FCOMMENT
  if (flags & 0x02) at += 2; // FHCRC
  if (at <= 0 || at >= input.length) return null;
  let raw: Buffer;
  try {
    // A raw inflate stops where the first member's deflate stream ends; whatever follows is never read.
    raw = await inflateRawAsync(input.subarray(at));
  } catch {
    return null;
  }
  if (raw.length < 16 || raw.readUInt32LE(0) !== SPZ_MAGIC) return null;
  const size = spzSize(raw);
  if (size === null || raw.length < size) return null;
  const out = Buffer.from(raw.subarray(0, size));
  out[15] = 0;
  return gzipAsync(out);
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
    if (format === "SPZ") return await sanitizeSpz(input);
  } catch {
    return null;
  }
  return null;
}

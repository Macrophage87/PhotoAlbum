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
  meshes?: { primitives?: { attributes?: Record<string, number>; indices?: number; targets?: Record<string, number>[]; extensions?: { KHR_draco_mesh_compression?: { bufferView?: number } } }[] }[];
  skins?: { inverseBindMatrices?: number }[];
  animations?: { samplers?: { input?: number; output?: number }[] }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [k: string]: unknown;
};

type Ref = { get: () => number | undefined; set: (i: number) => void };

/**
 * Every place a glTF names an accessor, as get/set pairs: a primitive's attributes, indices and morph targets, a
 * skin's inverse bind matrices, an animation sampler's input and output. (Sparse data names views, not accessors, and
 * goes with the accessor it belongs to.) Draco's own `attributes` are ids inside its compressed data, not accessors.
 */
function accessorRefs(g: Cleaned): Ref[] {
  const refs: Ref[] = [];
  const at = <T extends object>(o: T | undefined, key: keyof T & string) => {
    const rec = o as Record<string, number | undefined> | undefined;
    if (rec?.[key] !== undefined) refs.push({ get: () => rec[key], set: (i) => (rec[key] = i) });
  };
  const each = (map: Record<string, number> | undefined) => map && Object.keys(map).forEach((k) => at(map, k));
  for (const m of g.meshes ?? []) for (const p of m.primitives ?? []) {
    each(p.attributes);
    at(p, "indices");
    for (const t of p.targets ?? []) each(t);
  }
  for (const s of g.skins ?? []) at(s, "inverseBindMatrices");
  for (const a of g.animations ?? []) for (const s of a.samplers ?? []) {
    at(s, "input");
    at(s, "output");
  }
  return refs;
}

/** Keep only the items `refs` name, in their order, and point the refs at their new places; null when one names nothing. */
function keepNamed<T>(items: T[], refs: Ref[]): T[] | null {
  const named = [...new Set(refs.map((r) => r.get()).filter((i): i is number => i !== undefined))].sort((a, b) => a - b);
  if (named.some((i) => !items[i])) return null;
  const renumber = new Map(named.map((old, i) => [old, i]));
  for (const r of refs) {
    const i = r.get();
    if (i !== undefined) r.set(renumber.get(i)!);
  }
  return named.map((i) => items[i]);
}

/** Every place a glTF names a bufferView, as get/set pairs, so the views can be renumbered once unused ones are gone. */
function viewRefs(g: Cleaned): Ref[] {
  const refs: Ref[] = [];
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

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
/** Columns and rows of each accessor type; a matrix's columns each start on a four-byte boundary. */
const SHAPE: Record<string, [number, number]> = { SCALAR: [1, 1], VEC2: [1, 2], VEC3: [1, 3], VEC4: [1, 4], MAT2: [2, 2], MAT3: [3, 3], MAT4: [4, 4] };

type Accessor = { bufferView?: number; byteOffset?: number; componentType?: number; count?: number; type?: string; sparse?: { count?: number; indices?: { bufferView?: number; byteOffset?: number; componentType?: number }; values?: { bufferView?: number; byteOffset?: number } } };

/**
 * The views accessors read, each made again with only the bytes they read and zeros everywhere else, and cut off
 * after the last byte read: whatever else a view held (bytes before an accessor's offset, between strided vertices,
 * past the end of what is read, or belonging to another view it overlaps) is never copied. Null when an accessor
 * reads outside its view, or cannot be understood.
 */
function accessorBytes(g: Cleaned, views: View[], only: Set<number>, source: (i: number) => Buffer | null): Map<number, Buffer> | null {
  const out = new Map<number, { src: Buffer; dst: Buffer; end: number }>();
  const target = (i: number) => {
    let t = out.get(i);
    if (!t) {
      const src = source(i);
      if (!src) return null;
      t = { src, dst: Buffer.alloc(src.length), end: 0 };
      out.set(i, t);
    }
    return t;
  };
  /** Copy `length` bytes at `start` of view `i`; false when that is outside it. */
  const copy = (i: number, start: number, length: number): boolean => {
    const t = target(i);
    if (!t || start < 0 || length < 0 || start + length > t.src.length) return false;
    t.src.copy(t.dst, start, start, start + length);
    t.end = Math.max(t.end, start + length);
    return true;
  };
  /** An element's bytes as runs within it (a matrix's columns are padded to four bytes), and its whole span. */
  const layout = (componentType: number | undefined, type: string | undefined) => {
    const size = COMPONENT_BYTES[componentType ?? -1];
    const shape = SHAPE[type ?? ""];
    if (!size || !shape) return null;
    const [cols, rows] = shape;
    const column = cols === 1 ? rows * size : pad4(rows * size);
    return { runs: Array.from({ length: cols }, (_, c) => [c * column, rows * size] as const), span: cols * column };
  };
  for (const a of (g.accessors ?? []) as Accessor[]) {
    const count = a.count ?? 0;
    if (!Number.isInteger(count) || count < 0) return null;
    const el = layout(a.componentType, a.type);
    if (a.bufferView !== undefined && only.has(a.bufferView)) {
      if (!el) return null;
      const stride = views[a.bufferView].byteStride ?? el.span;
      if (stride < el.span) return null;
      const base = a.byteOffset ?? 0;
      if (stride === el.span && el.runs.length === 1) {
        if (!copy(a.bufferView, base, count * el.span)) return null;
      } else {
        for (let n = 0; n < count; n++) for (const [at, len] of el.runs) if (!copy(a.bufferView, base + n * stride + at, len)) return null;
      }
    }
    const sparse = a.sparse;
    if (sparse) {
      const n = sparse.count ?? 0;
      const idx = sparse.indices;
      if (idx?.bufferView !== undefined && only.has(idx.bufferView)) {
        const size = COMPONENT_BYTES[idx.componentType ?? -1];
        if (!size || !copy(idx.bufferView, idx.byteOffset ?? 0, n * size)) return null;
      }
      const values = sparse.values;
      if (values?.bufferView !== undefined && only.has(values.bufferView)) {
        if (!el || !copy(values.bufferView, values.byteOffset ?? 0, n * el.span)) return null;
      }
    }
  }
  // A view only ever named by accessors that read nothing of it has nothing in it to keep.
  for (const i of only) if (!out.has(i) && !target(i)) return null;
  return new Map([...out].map(([i, t]) => [i, t.dst.subarray(0, Math.max(t.end, 1))]));
}

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
    if (type === CHUNK_JSON && !json) {
      try {
        json = JSON.parse(body.toString("utf8").replace(/[\s\0]+$/, ""));
      } catch {
        return null;
      }
    } else if (type === CHUNK_BIN && !bin) bin = body;
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

  // Only accessors something draws with are kept: one that nothing names would still have its bytes copied below, and
  // could carry anything through. That includes one named only by what the lists above drop, like an app's `_ATTRIBUTE`.
  const accessors = keepNamed(g.accessors ?? [], accessorRefs(g));
  if (!accessors) return null;
  if (accessors.length) g.accessors = accessors;
  else delete g.accessors;

  // Only views something still reads are copied: an accessor's, an image's, a kept extension's. Anything else in the
  // binary chunk — a view nobody points at, the bytes between views — stays behind.
  const refs = viewRefs(g);
  const used = [...new Set(refs.map((r) => r.get()).filter((i): i is number => i !== undefined))].sort((a, b) => a - b);
  if (used.some((i) => !views[i])) return null;
  const source = (i: number): Buffer | null => {
    const start = views[i].byteOffset ?? 0;
    const bytes = bin!.subarray(start, start + views[i].byteLength);
    return bytes.length === views[i].byteLength ? bytes : null;
  };

  // A view is read one way: as a picture (re-encoded whole), as Draco's compressed mesh (opaque, kept whole), or by
  // accessors (only the bytes they read). One read two ways is not something this can clean.
  const imageViews = new Set((g.images ?? []).map((img) => img.bufferView).filter((i): i is number => i !== undefined));
  const dracoViews = new Set<number>();
  for (const m of g.meshes ?? []) for (const p of m.primitives ?? []) {
    const i = p.extensions?.KHR_draco_mesh_compression?.bufferView;
    if (i !== undefined) dracoViews.add(i);
  }
  const accessorViews = new Set<number>();
  for (const a of (g.accessors ?? []) as Accessor[]) for (const i of [a.bufferView, a.sparse?.indices?.bufferView, a.sparse?.values?.bufferView]) if (i !== undefined) accessorViews.add(i);
  if ([...imageViews].some((i) => dracoViews.has(i) || accessorViews.has(i)) || [...dracoViews].some((i) => accessorViews.has(i))) return null;
  const read = accessorBytes(g, views, accessorViews, source);
  if (!read) return null;

  // Every picture, embedded or inlined, is re-encoded; one that is neither, or of a kind sharp cannot write, is not handed out.
  const replaced = new Map<number, Buffer>(read);
  for (const image of g.images ?? []) {
    const type = image.mimeType ?? image.uri?.match(/^data:([^;,]+)/)?.[1] ?? "";
    if (!IMAGE_TYPES.has(type)) return null;
    if (image.bufferView !== undefined) {
      // A loader reads the view and ignores the address, so the address — a whole second picture, perhaps — goes.
      delete image.uri;
      if (replaced.has(image.bufferView)) continue;
      const bytes = source(image.bufferView);
      if (!bytes) return null;
      replaced.set(image.bufferView, await cleanImage(bytes, type));
    } else if (image.uri?.startsWith("data:")) {
      const encoded = image.uri.slice(image.uri.indexOf(",") + 1);
      image.uri = `data:${type};base64,${(await cleanImage(Buffer.from(encoded, "base64"), type)).toString("base64")}`;
    } else return null;
  }
  for (const i of dracoViews) {
    const bytes = source(i);
    if (!bytes) return null;
    replaced.set(i, bytes);
  }

  const renumber = new Map(used.map((old, i) => [old, i]));
  const parts: Buffer[] = [];
  const kept: View[] = [];
  let offset = 0;
  for (const old of used) {
    const bytes = replaced.get(old);
    if (!bytes) return null;
    kept.push({ ...views[old], buffer: 0, byteOffset: offset, byteLength: bytes.length });
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

const PLY_TYPE_BYTES: Record<string, number> = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
/** What a name may be at all: printable ASCII without spaces, as exporters write them (CloudCompare's hyphens, dots). */
const PLY_NAME = /^[\x21-\x7e]{1,64}$/;
/** A name passed on as it is: a plain identifier, which every name a reader looks for (x, red, f_dc_0, vertex_indices) is. */
const PLY_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const PLY_FORMATS = new Set(["ascii", "binary_little_endian", "binary_big_endian"]);

type PlyProperty = { type: string } | { list: [count: string, item: string] };
export type PlyLayout = { header: Buffer; bodyStart: number; format: string; eol: string; elements: { count: number; properties: PlyProperty[] }[] };

/**
 * The names an element's properties (or a file's elements) are given in the copy: a plain identifier as it is, and
 * anything else — a hyphen, a dot, more than 32 characters — as `<fallback>_<position>`, taking nothing from the name
 * itself. No reader draws by a name like that, so nothing is lost, and allowing them adds nothing to what a name in the
 * copy can say.
 */
function plyNames(names: string[], fallback: string): string[] {
  const taken = new Set(names.filter((n) => PLY_IDENTIFIER.test(n)));
  return names.map((n, i) => {
    if (PLY_IDENTIFIER.test(n)) return n;
    let out = `${fallback}_${i}`;
    while (taken.has(out)) out += "_";
    taken.add(out);
    return out;
  });
}

/**
 * A PLY's header made again from only what reading its points needs — `ply`, `format <type> <version>`,
 * `element <name> <count>`, `property <type> <name>`, `property list <type> <type> <name>`, `end_header` — each line
 * rebuilt from those tokens alone, with names that are not plain identifiers renamed, and where the points start.
 * `comment`, `obj_info` and anything else go, whatever their case; a name that is not printable ASCII of at most 64
 * characters, or anything malformed, withholds the file. Null too when `head` (the file's first bytes) holds no whole
 * header.
 */
export function plyHeader(head: Buffer): PlyLayout | null {
  const elements: { name: string; count: number; properties: { def: PlyProperty; name: string }[] }[] = [];
  let format = "";
  let version = "";
  let eol = "\n";
  for (let at = 0; at < Math.min(head.length, PLY_HEADER_MAX); ) {
    const nl = head.indexOf(0x0a, at);
    if (nl < 0) return null;
    const raw = head.subarray(at, nl).toString("latin1");
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (at === 0) {
      if (line !== "ply") return null;
      if (raw.endsWith("\r")) eol = "\r\n";
      at = nl + 1;
      continue;
    }
    at = nl + 1;
    const t = line.trim().split(/\s+/);
    const word = t[0].toLowerCase();
    if (word === "end_header" && t.length === 1) {
      if (!format) return null;
      const lines = ["ply", `format ${format} ${version}`];
      const elementNames = plyNames(elements.map((e) => e.name), "element");
      elements.forEach((e, i) => {
        lines.push(`element ${elementNames[i]} ${e.count}`);
        const names = plyNames(e.properties.map((p) => p.name), "property");
        e.properties.forEach(({ def }, j) => lines.push("list" in def ? `property list ${def.list[0]} ${def.list[1]} ${names[j]}` : `property ${def.type} ${names[j]}`));
      });
      lines.push("end_header");
      const header = Buffer.from(lines.map((l) => l + eol).join(""), "latin1");
      return { header, bodyStart: at, format, eol, elements: elements.map((e) => ({ count: e.count, properties: e.properties.map((p) => p.def) })) };
    }
    if (word === "format") {
      if (format || !PLY_FORMATS.has(t[1]) || !/^\d+(\.\d+)?$/.test(t[2] ?? "")) return null;
      format = t[1];
      version = t[2];
    } else if (word === "element") {
      if (!PLY_NAME.test(t[1] ?? "") || !/^\d+$/.test(t[2] ?? "")) return null;
      elements.push({ name: t[1], count: Number(t[2]), properties: [] });
    } else if (word === "property") {
      const element = elements.at(-1);
      if (!element) return null;
      if (t[1] === "list") {
        if (!PLY_TYPE_BYTES[t[2]] || !PLY_TYPE_BYTES[t[3]] || !PLY_NAME.test(t[4] ?? "")) return null;
        element.properties.push({ def: { list: [t[2], t[3]] }, name: t[4] });
      } else {
        if (!PLY_TYPE_BYTES[t[1]] || !PLY_NAME.test(t[2] ?? "")) return null;
        element.properties.push({ def: { type: t[1] }, name: t[2] });
      }
    }
    // comment, obj_info, and anything this does not know: left behind.
  }
  return null;
}

/** How long a binary body whose properties are all of fixed size must be; null when it has lists, or is text. */
export function plyFixedLength(layout: PlyLayout): number | null {
  if (layout.format === "ascii") return null;
  let total = 0;
  for (const e of layout.elements) {
    let row = 0;
    for (const p of e.properties) {
      if ("list" in p) return null;
      row += PLY_TYPE_BYTES[p.type];
    }
    total += e.count * row;
  }
  return total;
}

/**
 * How much of a binary `body` the header's elements take, its records walked property by property, list lengths
 * included, so nothing after the last record is kept. Null when the body is shorter than the header says.
 */
export function plyBodyLength(layout: PlyLayout, body: Buffer): number | null {
  const fixed = plyFixedLength(layout);
  if (fixed !== null) return fixed <= body.length ? fixed : null;
  if (layout.format === "ascii") return null;
  const little = layout.format === "binary_little_endian";
  const readCount = (type: string, at: number): number => {
    const size = PLY_TYPE_BYTES[type];
    if (at + size > body.length) return -1;
    if (type.startsWith("float") || type === "double") return -1; // a list's length is an integer
    const signed = !type.startsWith("u");
    const v = size === 1 ? (signed ? body.readInt8(at) : body.readUInt8(at)) : size === 2 ? (little ? (signed ? body.readInt16LE(at) : body.readUInt16LE(at)) : signed ? body.readInt16BE(at) : body.readUInt16BE(at)) : little ? (signed ? body.readInt32LE(at) : body.readUInt32LE(at)) : signed ? body.readInt32BE(at) : body.readUInt32BE(at);
    return v;
  };
  let at = 0;
  for (const e of layout.elements) {
    for (let n = 0; n < e.count; n++) {
      for (const p of e.properties) {
        if ("list" in p) {
          const count = readCount(p.list[0], at);
          if (count < 0) return null;
          at += PLY_TYPE_BYTES[p.list[0]] + count * PLY_TYPE_BYTES[p.list[1]];
        } else at += PLY_TYPE_BYTES[p.type];
        if (at > body.length) return null;
      }
    }
  }
  return at;
}

const PLY_REAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const PLY_NOT_FINITE = /^([+-]?)(nan|inf|infinity)$/i;
/** What each integer type can hold; a value outside it is not one a reader could have read. */
const PLY_INT_RANGE: Record<string, [number, number]> = { char: [-128, 127], int8: [-128, 127], uchar: [0, 255], uint8: [0, 255], short: [-32768, 32767], int16: [-32768, 32767], ushort: [0, 65535], uint16: [0, 65535], int: [-2147483648, 2147483647], int32: [-2147483648, 2147483647], uint: [0, 4294967295], uint32: [0, 4294967295] };
/** The smallest normal float32: from there up, six significant digits always survive a float32 and back. */
const FLOAT32_NORMAL = 2 ** -126;

/** Significant digits in a number as `String` writes it. */
function digits(s: string): number {
  let n = 0;
  let leading = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 101) break; // "e"
    if (c < 48 || c > 57 || (leading && c === 48)) continue;
    leading = false;
    n++;
  }
  return n;
}

/**
 * The fewest significant digits that read back as this float32. No other decimal of six digits or fewer reads back
 * as the same float (six digits always survive the trip), so what the file wrote is kept when it is that short;
 * otherwise the digits are found again from the float itself, starting from as many as the file wrote.
 */
function float32Text(f: number, written: string): string {
  let p = Math.min(Math.max(digits(written), 1), 9);
  // What the file wrote may be a number too small for a float32 at all.
  if (f === 0) return "0";
  if (Math.abs(f) >= FLOAT32_NORMAL && p <= 6) return written;
  while (p > 1 && Math.fround(Number(f.toPrecision(p - 1))) === f) p--;
  let s = f.toPrecision(p);
  // Nine digits read back as any float32, so this ends there at the latest. The fewest digits end in no zero.
  while (Math.fround(Number(s)) !== f) s = f.toPrecision(++p);
  return s;
}

/**
 * One text value, written again as the number it is, so a value stretched out with digits nobody reads cannot carry
 * anything: an integer (a whole number written with a point too) as its digits, within what its type holds; a `float`
 * as the fewest digits that read back as the same float32, and a `double` as the fewest that read back as the same
 * double (a value of 15 significant digits or fewer, as exporters write them, keeps its exact decimal value);
 * not-a-number and infinities as `nan`, `inf` and `-inf`. Null for anything that is not a number of `type`'s kind.
 */
function plyValue(token: string, type: string): string | null {
  const range = PLY_INT_RANGE[type];
  if (range) {
    // Some exporters write a whole number as `255.0`, and readers take it as the integer.
    if (!PLY_REAL.test(token)) return null;
    const n = Number(token);
    return Number.isInteger(n) && n >= range[0] && n <= range[1] ? String(n) : null;
  }
  const single = type === "float" || type === "float32";
  let n: number;
  let written = "";
  if (PLY_REAL.test(token)) {
    n = Number(token);
    written = String(n);
  } else {
    const word = PLY_NOT_FINITE.exec(token);
    if (!word) return null;
    n = word[2].toLowerCase() === "nan" ? NaN : word[1] === "-" ? -Infinity : Infinity;
  }
  if (single) n = Math.fround(n);
  if (Number.isNaN(n)) return "nan";
  if (!Number.isFinite(n)) return n > 0 ? "inf" : "-inf";
  if (Object.is(n, -0)) return "-0";
  return single ? float32Text(n, written) : written;
}

/**
 * Makes a text body's records again a line at a time, each from exactly the values the header declares for it (a
 * list's length, then that many items): a record's extra tokens are left behind, and one with too few values, or a
 * value that is not a number its type holds, withholds the file. `row` gives the record ("" for a blank line, which is
 * skipped) or null; `done` says when the last record has been made, and nothing after it is read.
 */
function plyTextRows(layout: PlyLayout) {
  const left = layout.elements.map((e) => e.count);
  let element = 0;
  const advance = () => {
    while (element < left.length && left[element] === 0) element++;
  };
  advance();
  // The line being read, and how far into it.
  let line = "";
  let at = 0;
  const token = (): string | null => {
    while (at < line.length && line.charCodeAt(at) <= 32) at++;
    if (at >= line.length) return null;
    const start = at;
    while (at < line.length && line.charCodeAt(at) > 32) at++;
    return line.slice(start, at);
  };
  const out: string[] = [];
  /** The next token as a value of `type`, added to the record; null when there is none, or it is not one. */
  const take = (type: string): string | null => {
    const t = token();
    const v = t === null ? null : plyValue(t, type);
    if (v !== null) out.push(v);
    return v;
  };
  return {
    done: () => element >= left.length,
    row(text: string): string | null {
      line = text;
      at = 0;
      while (at < line.length && line.charCodeAt(at) <= 32) at++;
      if (at >= line.length) return "";
      out.length = 0;
      for (const p of layout.elements[element].properties) {
        if ("list" in p) {
          const count = PLY_INT_RANGE[p.list[0]] ? take(p.list[0]) : null; // a list's length is an integer
          if (count === null || Number(count) < 0) return null;
          for (let k = Number(count); k > 0; k--) if (take(p.list[1]) === null) return null;
        } else if (take(p.type) === null) return null;
      }
      left[element]--;
      advance();
      return out.join(" ") + layout.eol;
    },
  };
}

/** Thrown from `plyTextBody` for a text PLY that is not handed out. */
export class PlyWithheld extends Error {}

/** How long one text record may run; a list of a few thousand items fits many times over. */
const PLY_LINE_MAX = 1024 * 1024;
/** Records made between turns given back to the server. */
const PLY_TEXT_BATCH = 5_000;

/**
 * A text PLY's records made again from its body as it streams in, a batch at a time with the server given its turn
 * in between, so a point cloud of any size neither sits in memory nor holds up anything else. Stops reading after the
 * last record; throws `PlyWithheld` for a file that is not handed out.
 */
export async function* plyTextBody(layout: PlyLayout, body: AsyncIterable<Buffer> | Iterable<Buffer>): AsyncGenerator<Buffer> {
  const rows = plyTextRows(layout);
  let out: string[] = [];
  const take = (line: string) => {
    let r: string | null;
    try {
      r = rows.row(line);
    } catch {
      r = null; // whatever it was, it was in reading the file, and answers the same way
    }
    if (r === null) throw new PlyWithheld("a text record that is not what its header declares");
    if (r) out.push(r);
  };
  // latin1 is a byte to a character, so a chunk can be read as text wherever it was cut.
  let carry = "";
  for await (const chunk of body) {
    const text = carry + chunk.toString("latin1");
    let at = 0;
    for (let nl = text.indexOf("\n"); nl >= 0 && !rows.done(); nl = text.indexOf("\n", at)) {
      take(text.slice(at, nl));
      at = nl + 1;
      if (out.length >= PLY_TEXT_BATCH) {
        yield Buffer.from(out.join(""), "latin1");
        out = [];
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    if (rows.done()) break;
    carry = text.slice(at);
    if (carry.length > PLY_LINE_MAX) throw new PlyWithheld("a text record longer than any real one");
  }
  // The last record may end the file without a newline.
  if (!rows.done() && carry) take(carry);
  if (!rows.done()) throw new PlyWithheld("fewer text records than its header declares");
  yield Buffer.from(out.join(""), "latin1");
}

/** `plyTextBody` for a body already in memory; null for a file that is not handed out. */
function plyTextBodySync(layout: PlyLayout, body: Buffer): Buffer | null {
  const rows = plyTextRows(layout);
  const text = body.toString("latin1");
  const out: string[] = [];
  for (let at = 0; !rows.done(); ) {
    if (at >= text.length) return null;
    let nl = text.indexOf("\n", at);
    if (nl < 0) nl = text.length; // the last record may end the file without a newline
    const r = rows.row(text.slice(at, nl));
    at = nl + 1;
    if (r === null) return null;
    out.push(r);
  }
  return Buffer.from(out.join(""), "latin1");
}

/** A PLY with only its reading instructions left in the header, and its records and nothing after them. */
export function sanitizePly(input: Buffer): Buffer | null {
  const layout = plyHeader(input);
  if (!layout) return null;
  const body = input.subarray(layout.bodyStart);
  if (layout.format === "ascii") {
    const records = plyTextBodySync(layout, body);
    return records && Buffer.concat([layout.header, records]);
  }
  const length = plyBodyLength(layout, body);
  return length === null ? null : Buffer.concat([layout.header, body.subarray(0, length)]);
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
  // Null is a refusal, and is remembered; an error (sharp running out of memory re-encoding a texture, say) is not an
  // answer about the file, and is left to the caller, so it is tried again.
  if (format === "GLB") return sanitizeGlb(input);
  if (format === "PLY") return sanitizePly(input);
  if (format === "SPZ") return sanitizeSpz(input);
  return null;
}

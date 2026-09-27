import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { applyEdits, editedSize, editsOf, type PhotoEdits } from "./edits";
import { heicSource, isHeic } from "./heic";
import { FULL_QUALITY, WEBP_MAX_SIDE, type Rendition, type Renditions } from "./renditions";

/**
 * The full-size picture for anybody outside the family.
 *
 * A member opening a photo full size gets the file as uploaded, and that file is the family's: it carries the
 * camera's EXIF with its GPS, maker notes, XMP and IPTC, and its name. So a visitor gets a copy made for them
 * instead — the same pixels at the same size, turned upright, with any darkroom edits on it exactly as the member's
 * "edited" view has them, and nothing else of the file. An edited item already has one (`full`, made with its other
 * renditions); any other is given one the first time somebody outside the family asks, and it is kept from then on.
 *
 * Made on request rather than with the other renditions because most photographs are never opened full size by a
 * visitor, and most are not in anything a visitor can see at all: a copy of every one would roughly double what
 * the album keeps, for pictures nobody outside the family will ask for.
 */

/** JPEG's own limit on a side. Past it even this copy is scaled down; nothing a phone or a stitcher makes gets there. */
const JPEG_MAX_SIDE = 65535;

/**
 * Colour profiles kept on the copy, by the name the profile gives itself. A phone's wide-gamut picture turned into
 * sRGB loses its reds and greens, which a member sees in the file itself; but a profile is bytes out of the file, so
 * only the published ones phones and cameras embed are passed on (`sP3C` is the compact Display P3 that libvips, and
 * so much photo software, writes). Anything else is turned into sRGB like every other rendition.
 */
const KEPT_PROFILES = new Set(["Display P3", "sP3C", "Adobe RGB (1998)"]);

/** The name an ICC profile gives itself (its `desc` tag), in either version's layout; null when there is none to read. */
export function iccDescription(icc: Buffer | undefined): string | null {
  if (!icc || icc.length < 132) return null;
  const count = icc.readUInt32BE(128);
  for (let i = 0; i < count && 132 + (i + 1) * 12 <= icc.length; i++) {
    const at = 132 + i * 12;
    if (icc.toString("latin1", at, at + 4) !== "desc") continue;
    const off = icc.readUInt32BE(at + 4);
    const end = off + icc.readUInt32BE(at + 8);
    if (end > icc.length || end - off < 12) return null;
    const type = icc.toString("latin1", off, off + 4);
    // Version 2: a count and ASCII.
    if (type === "desc") return clean(icc.toString("latin1", off + 12, Math.min(end, off + 12 + icc.readUInt32BE(off + 8))));
    // Version 4: records of UTF-16BE, one per language; the first is the one every reader shows.
    if (type === "mluc" && end - off >= 28 && icc.readUInt32BE(off + 8) > 0) {
      const start = off + icc.readUInt32BE(off + 24);
      const length = icc.readUInt32BE(off + 20) & ~1;
      if (start + length > end) return null;
      return clean(Buffer.from(icc.subarray(start, start + length)).swap16().toString("utf16le"));
    }
    return null;
  }
  return null;
}

const clean = (s: string) => s.replace(/\0+$/, "").trim() || null;

/**
 * Render the copy: upright, with `edits` on it, every piece of metadata left behind. WebP at the quality of the
 * edited full size where it can hold the picture, JPEG past WebP's limit so a long panorama keeps its length. An
 * animated GIF or WebP nobody has edited stays animated, as the file a member opens does.
 */
export async function renderCleanCopy(input: string | Buffer, edits: PhotoEdits | null): Promise<{ data: Buffer; ext: "webp" | "jpg"; w: number; h: number }> {
  const options = { failOn: "none", limitInputPixels: 300_000_000 } as const;
  const meta = await sharp(input, options).metadata();
  const rotated = meta.orientation && meta.orientation >= 5;
  const upright = { width: (rotated ? meta.height : meta.width) ?? 0, height: (rotated ? meta.width : meta.height) ?? 0 };
  const { width, height } = editedSize(edits, upright);
  const long = Math.max(width, height);
  const animated = !edits && (meta.pages ?? 1) > 1 && (meta.format === "gif" || meta.format === "webp") && long <= WEBP_MAX_SIDE;

  let img = sharp(input, { ...options, animated }).rotate();
  if (edits) img = applyEdits(img, edits, upright);
  // Only on a picture nobody has edited: an edited one is in sRGB everywhere else, and this matches its `full`.
  // `keepIccProfile` passes on the profile alone; EXIF, XMP and IPTC still go.
  if (!edits && KEPT_PROFILES.has(iccDescription(meta.icc) ?? "")) img = img.keepIccProfile();

  if (long <= WEBP_MAX_SIDE) {
    const { data, info } = await img.webp({ quality: FULL_QUALITY }).toBuffer({ resolveWithObject: true });
    return { data, ext: "webp", w: info.width, h: info.pageHeight ?? info.height };
  }
  if (long > JPEG_MAX_SIDE) img = img.resize({ width: JPEG_MAX_SIDE, height: JPEG_MAX_SIDE, fit: "inside" });
  // JPEG has no transparency: what was see-through goes white, as it is shown on the page.
  const { data, info } = await img.flatten({ background: "#ffffff" }).jpeg({ quality: FULL_QUALITY }).toBuffer({ resolveWithObject: true });
  return { data, ext: "jpg", w: info.width, h: info.height };
}

/** What a clean copy is made from and written back onto. */
export type CleanCopySource = {
  id: string;
  imageVersion: number;
  updatedAt: Date;
  storageKey: string;
  originalPath: string;
  originalName: string;
  mimeType: string;
  edits: unknown;
  renditions: unknown;
};

/** A copy made on request is named for the making, never reused: see `writeCleanCopy`. */
const CLEAN_COPY_NAME = /^full-[0-9a-f]{8}\.(webp|jpg)$/;

/**
 * The item's full-size copy for a visitor, made now if it has none yet. Null for an item with no renditions (not
 * processed yet), or when the row moved on while the copy was being made: the caller answers with what it has.
 */
export async function cleanCopy(photo: CleanCopySource): Promise<Rendition | null> {
  const r = photo.renditions as Renditions | null;
  if (!r) return null;
  if (r.full) return r.full;
  // Visitors arriving together share one making of it.
  const k = `${photo.id}:${photo.imageVersion}`;
  const pending = making.get(k) ?? atMost(() => writeCleanCopy(photo)).finally(() => making.delete(k));
  making.set(k, pending);
  return pending;
}

const making = new Map<string, Promise<Rendition | null>>();

/**
 * A full-resolution encode holds the whole picture in memory: however many visitors open different photos at once,
 * only this many are made at a time, and the rest wait their turn.
 */
const AT_ONCE = 2;
let running = 0;
const queue: (() => void)[] = [];

async function atMost<T>(fn: () => Promise<T>): Promise<T> {
  while (running >= AT_ONCE) await new Promise<void>((go) => queue.push(go));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

/**
 * Make the copy and put it on the row, safely against anything else writing the row meanwhile — another server
 * process making the same copy, or a re-render after an edit. Each making writes a file of its own name, and the
 * row takes it only if it is still the one the copy was made from: the same `imageVersion`, which the database moves
 * on with any change to the item's file, edits or renditions (saved edits move it before their re-render does). A
 * copy that loses is deleted, never handed out: it may be of a crop that has since changed. The winner moves
 * `imageVersion` on, like every other writer of renditions, so what was cached under the old addresses is asked for
 * again.
 */
export async function writeCleanCopy(photo: CleanCopySource): Promise<Rendition | null> {
  const store = storage();
  const local = store.localPath?.(photo.originalPath);
  if (!local) return null;
  await forgetCleanCopies(photo.storageKey);
  // A HEIC is decoded as its renditions were: sharp cannot read one, and the file's own bytes are never passed on.
  const input = isHeic(photo.mimeType, photo.originalName) ? await heicSource(store, photo.storageKey, local) : local;
  // The row's edits, not whatever the renditions were made with: a crop just saved is already the one that counts.
  const { data, ext, w, h } = await renderCleanCopy(input, editsOf(photo.edits));
  const rendition: Rendition = { key: `${photo.storageKey}/full-${randomUUID().slice(0, 8)}.${ext}`, w, h };
  await store.putBuffer(rendition.key, data);
  const renditions = { ...(photo.renditions as Renditions), full: rendition };
  // A copy made to be looked at is not a change anybody made: `updatedAt` stays as it was.
  const { count } = await db.photo
    .updateMany({ where: { id: photo.id, imageVersion: photo.imageVersion }, data: { renditions, imageVersion: { increment: 1 }, updatedAt: photo.updatedAt } })
    .catch(async (err) => {
      await store.delete(rendition.key);
      throw err;
    });
  if (count) return rendition;
  await store.delete(rendition.key);
  // Another making got there first, or the picture changed: whatever the row has now, if anything.
  const now = await db.photo.findUnique({ where: { id: photo.id }, select: { renditions: true } });
  return (now?.renditions as Renditions | null)?.full ?? null;
}

/** Longer than any making takes: a copy younger than this may be about to be put on its row. */
const CLEAN_COPY_GRACE_MS = 60 * 60 * 1000;

/**
 * Delete copies made on request that no row points at any more. `replaced` is the full size a re-render has just
 * written over, deleted whatever its age; anything else of the kind in the item's folder goes once it is old enough
 * that no making can still be about to claim it.
 */
export async function forgetCleanCopies(storageKey: string, replaced?: Rendition | null): Promise<void> {
  const store = storage();
  if (replaced && CLEAN_COPY_NAME.test(path.basename(replaced.key)) && replaced.key.startsWith(`${storageKey}/`)) await store.delete(replaced.key);
  const dir = store.localPath?.(storageKey);
  if (!dir) return;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!CLEAN_COPY_NAME.test(name)) continue;
    const s = await stat(path.join(dir, name)).catch(() => null);
    if (s && Date.now() - s.mtimeMs > CLEAN_COPY_GRACE_MS) await store.delete(`${storageKey}/${name}`).catch(() => undefined);
  }
}

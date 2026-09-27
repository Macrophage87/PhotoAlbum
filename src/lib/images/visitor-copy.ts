import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { storage } from "@/lib/storage";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { largestRendition } from "@/lib/photos/urls";
import { applyEdits, editedSize, editsOf, type PhotoEdits } from "./edits";
import { WEBP_MAX_SIDE, type Renditions } from "./renditions";

/**
 * The full-size picture for anybody outside the family.
 *
 * A member opening a photo full size gets the file as uploaded, and that file is the family's: it carries the
 * camera's EXIF with its GPS, maker notes, XMP and IPTC, and its name. A visitor is given a copy made for them
 * instead: the same pixels at the same size, turned upright, with the darkroom edits on it and nothing else of the
 * file. An edited photo already has one of those, its `full`; any other gets one from the worker the first time
 * somebody outside the family asks (see `jobs/handlers/visitor-copy`), and until it is there the largest rendition
 * stands in.
 *
 * Made on request rather than with the other renditions because most photographs are never opened full size by a
 * visitor, and most are not in anything a visitor can see at all: a copy of every one would roughly double what the
 * album keeps. It is kept beside the file and never recorded on the row: its name says what it was made from (the
 * item's `imageVersion` and its edits), so a copy of the picture as it was before a crop, a re-render or a move is
 * simply never looked for again.
 */

/** The quality of the edited full size, which a member sees: the same here. */
export const VISITOR_QUALITY = 90;

/**
 * Past this many pixels the copy is JPEG. A WebP is encoded from the whole picture held in memory, and JPEG a strip
 * at a time, so this keeps the worker to its share of a 2 GB server whatever the picture (see docs/DEPLOY.md): a
 * 24-megapixel phone photo peaks at about 400 MB as WebP, a 60000 × 4800 panorama at about 450 MB as JPEG, the
 * worker's own 120 MB or so included.
 */
export const WEBP_MAX_PIXELS = 25_000_000;

/**
 * The most pixels a copy is made of at all. A picture that has to be turned, or edited, is held whole while that is
 * done, so it gets less room than one that streams through (a 48-megapixel one turned peaks at about 440 MB). Past
 * these the largest rendition is all a visitor gets of it.
 */
export const VISITOR_MAX_PIXELS = 300_000_000;
export const VISITOR_MAX_HELD_PIXELS = 50_000_000;

/**
 * Wide-gamut pictures, by the name their colour profile gives itself. Their colours are turned into the album's own
 * Display P3 profile rather than squeezed into sRGB; the file's profile itself is never passed on, only the colours
 * it describes. Anything else becomes sRGB, like every other rendition.
 */
const WIDE_GAMUT = new Set(["Display P3", "sP3C", "Adobe RGB (1998)"]);

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
    if (type === "desc") return tidy(icc.toString("latin1", off + 12, Math.min(end, off + 12 + icc.readUInt32BE(off + 8))));
    // Version 4: records of UTF-16BE, one per language; the first is the one every reader shows.
    if (type === "mluc" && end - off >= 28 && icc.readUInt32BE(off + 8) > 0) {
      const start = off + icc.readUInt32BE(off + 24);
      const length = icc.readUInt32BE(off + 20) & ~1;
      if (start + length > end) return null;
      return tidy(Buffer.from(icc.subarray(start, start + length)).swap16().toString("utf16le"));
    }
    return null;
  }
  return null;
}

const tidy = (s: string) => s.replace(/\0+$/, "").trim() || null;

const OPEN = { failOn: "none", limitInputPixels: VISITOR_MAX_PIXELS } as const;

/** What a copy of this picture would be, read from its header alone; null when it is too big to make safely. */
export async function planVisitorCopy(input: string | Buffer, edits: PhotoEdits | null) {
  const meta = await sharp(input, OPEN).metadata();
  const turned = Boolean(meta.orientation && meta.orientation >= 5);
  const upright = { width: (turned ? meta.height : meta.width) ?? 0, height: (turned ? meta.width : meta.height) ?? 0 };
  const source = upright.width * upright.height;
  if (!source || source > (turned || edits ? VISITOR_MAX_HELD_PIXELS : VISITOR_MAX_PIXELS)) return null;
  const { width, height } = editedSize(edits, upright);
  const webp = Math.max(width, height) <= WEBP_MAX_SIDE && width * height <= WEBP_MAX_PIXELS;
  return {
    upright,
    ext: webp ? ("webp" as const) : ("jpg" as const),
    // An animation nobody has edited stays one, as the file a member opens does.
    animated: webp && !edits && (meta.pages ?? 1) > 1 && (meta.format === "gif" || meta.format === "webp"),
    wide: !edits && WIDE_GAMUT.has(iccDescription(meta.icc) ?? ""),
  };
}

/**
 * Render the copy into `file`: upright, with `edits` on it, and no metadata at all but a colour profile the album
 * chose. Written a strip at a time wherever the format allows, never gathered into one buffer.
 */
export async function renderVisitorCopy(input: string | Buffer, edits: PhotoEdits | null, plan: NonNullable<Awaited<ReturnType<typeof planVisitorCopy>>>, file: string): Promise<{ width: number; height: number }> {
  let img = sharp(input, { ...OPEN, animated: plan.animated }).rotate();
  if (edits) img = applyEdits(img, edits, plan.upright);
  // Worked in 16 bits so the colours outside sRGB survive the trip to the album's P3 profile. Only unedited: the
  // edits' numbers are in 8-bit terms, and an edited picture is in sRGB everywhere else.
  if (plan.wide) img = img.pipelineColourspace("rgb16").withIccProfile("p3");
  // A lower effort than sharp's default: a quarter of the time and less memory, for a file hardly any larger.
  if (plan.ext === "webp") img = img.webp({ quality: VISITOR_QUALITY, effort: 2 });
  // JPEG has no transparency: what was see-through goes white, as it is shown on the page. Without optimised
  // Huffman tables, which would hold every block of the picture until the end: a panorama's worth of gigabytes.
  else img = img.flatten({ background: "#ffffff" }).jpeg({ quality: VISITOR_QUALITY, optimiseCoding: false });
  const info = await img.toFile(file);
  return { width: info.width, height: info.pageHeight ?? info.height };
}

/** What a copy is named for: the item, and what its picture is made from. */
export type VisitorCopyItem = { storageKey: string; imageVersion: number; edits: unknown };

/** A short, stable name for a set of edits, or for none. */
function editsTag(edits: unknown): string {
  return createHash("sha256").update(JSON.stringify(editsOf(edits))).digest("hex").slice(0, 8);
}

/** The copy's key without its extension: beside the file, so deleting the item's folder takes it too. */
export function visitorStem(item: VisitorCopyItem): string {
  return `${item.storageKey}/visitor-${item.imageVersion}-${editsTag(item.edits)}`;
}

/**
 * Everything a making of a copy leaves in an item's folder: the copy, a note that it failed or that the picture is
 * too big to copy safely, and a file still being written.
 */
export const VISITOR_FILE = /^visitor-(\d+)-[0-9a-f]{8}\.(webp|jpg|failed|withheld|[0-9a-f-]{36}\.tmp)$/;

/**
 * Delete the item's visitor files from before `version`, and with `keep`, every other one of that version too. A
 * newer version's are left alone: a making of it may have finished first, and its copy is the one being served.
 * Returns how many went.
 */
export async function forgetVisitorFiles(storageKey: string, version: number, keep?: string): Promise<number> {
  const store = storage();
  const dir = store.localPath?.(storageKey);
  if (!dir) return 0;
  let gone = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const m = VISITOR_FILE.exec(name);
    if (!m) continue;
    const of = Number(m[1]);
    if (of < version || (keep && of === version && name !== path.basename(keep))) await store.delete(`${storageKey}/${name}`).then(() => gone++, () => undefined);
  }
  return gone;
}

/** The key of this item's copy of the picture as it is now, if one has been made. */
export async function findVisitorCopy(item: VisitorCopyItem): Promise<string | null> {
  const store = storage();
  const stem = visitorStem(item);
  for (const ext of ["webp", "jpg"]) if (await store.exists(`${stem}.${ext}`)) return `${stem}.${ext}`;
  return null;
}

/** How long a making that failed keeps the picture from being queued again. */
export const VISITOR_RETRY_AFTER_MS = 6 * 3600_000;

/** What the full-size address answers a visitor with, where the item is a photograph. */
export type VisitorAnswer = {
  key: string;
  /** Only standing in, until the copy is made: kept by nobody, so the copy is asked for next time. */
  standIn: boolean;
  /** Where `key` is gone by the time it is read (a newer copy took its place): what to give instead. */
  otherwise: string | null;
};

/**
 * What a visitor asking for a photograph at full size is given: its copy of the picture as it is now; else an
 * edited photo's own full size, which is that already; else the largest rendition, while the worker is asked to
 * make the copy. Never renders anything itself, and never the file as uploaded.
 */
export async function visitorFullSize(photo: VisitorCopyItem & { id: string; renditions: unknown }): Promise<VisitorAnswer | null> {
  const r = photo.renditions as Renditions | null;
  const largest = largestRendition(r)?.rendition.key ?? null;
  const copy = await findVisitorCopy(photo);
  if (copy) return { key: copy, standIn: false, otherwise: largest };
  if (r?.full) return { key: r.full.key, standIn: false, otherwise: null };
  if (!largest) return null;
  const stem = visitorStem(photo);
  const store = storage();
  // Too big to copy safely: the largest rendition is its full size for good, or until the picture changes.
  if (await store.exists(`${stem}.withheld`)) return { key: largest, standIn: false, otherwise: null };
  const failed = await stat(store.localPath?.(`${stem}.failed`) ?? "").catch(() => null);
  if (!failed || Date.now() - failed.mtimeMs > VISITOR_RETRY_AFTER_MS) {
    // One making per picture: every visitor arriving before it is done asks for the same job.
    await enqueue(QUEUES.visitorCopy, { photoId: photo.id, imageVersion: photo.imageVersion }, { singletonKey: `visitor:${photo.id}:${photo.imageVersion}`, singletonSeconds: 3600 }).catch((err) =>
      console.error(`[photos] could not queue a visitor copy of ${photo.id}:`, err),
    );
  }
  return { key: largest, standIn: true, otherwise: null };
}

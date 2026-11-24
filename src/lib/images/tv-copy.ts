import { stat } from "node:fs/promises";
import sharp from "sharp";
import { storage } from "@/lib/storage";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { RENDITION_SIZES } from "./renditions";
import { editsTag, VISITOR_MAX_HELD_PIXELS, VISITOR_RETRY_AFTER_MS, type VisitorCopyItem } from "./visitor-copy";

/**
 * A photograph for a 4K television.
 *
 * A slideshow cast from the phone app shows the medium copy, 1600 pixels on its long side: plenty for a 1080p
 * screen, soft on a 4K one. A television that draws more than that asks for this instead: the picture as it is now
 * (upright, edits on it), no bigger than a 4K screen, as a JPEG with none of the file's metadata. Like a visitor's
 * full-size copy (see `./visitor-copy`), it is made by the worker the first time it is asked for, kept beside the
 * file under a name that says what it was made from, and cleared out the same way when the picture changes. Until
 * it is there the medium copy stands in. Only photographs that are ever shown on such a television get one.
 */

/** The long side of a 4K screen. */
export const TV_SIDE = 3840;

/** A good deal better than a link preview's, since this one is looked at across a room on a large screen. */
export const TV_QUALITY = 88;

/** A picture not much bigger than its medium copy gains nothing from another. */
export const TV_WORTH_IT = Math.round(RENDITION_SIZES.medium * 1.15);

export function tvStem(item: VisitorCopyItem): string {
  return `${item.storageKey}/tv-${item.imageVersion}-${editsTag(item.edits)}`;
}

/** What a copy for a television would be made from, read from the header alone; null when it should not be made. */
export async function planTvCopy(input: string | Buffer): Promise<{ width: number; height: number } | null> {
  const meta = await sharp(input, { failOn: "none", limitInputPixels: VISITOR_MAX_HELD_PIXELS }).metadata().catch(() => null);
  const width = meta?.width ?? 0;
  const height = meta?.height ?? 0;
  if (!width || !height || width * height > VISITOR_MAX_HELD_PIXELS || Math.max(width, height) < TV_WORTH_IT) return null;
  return { width, height };
}

/** Render the copy into `file`: upright, within a 4K screen, sRGB, and nothing of the file but its pixels. */
export async function renderTvCopy(input: string | Buffer, file: string): Promise<{ width: number; height: number }> {
  const info = await sharp(input, { failOn: "none", limitInputPixels: VISITOR_MAX_HELD_PIXELS })
    .rotate()
    .resize({ width: TV_SIDE, height: TV_SIDE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: TV_QUALITY })
    .toFile(file);
  return { width: info.width, height: info.height };
}

/**
 * The key of this photograph's copy for a 4K television, or null while there is none, in which case the worker is
 * asked to make it (once per picture, and not again for a while after a making that failed) and the caller shows
 * the medium copy meanwhile. Never renders anything itself.
 */
export async function tvPicture(photo: VisitorCopyItem & { id: string }): Promise<string | null> {
  const store = storage();
  const stem = tvStem(photo);
  if (await store.exists(`${stem}.jpg`)) return `${stem}.jpg`;
  // Too big to make safely, or too small to be worth it: the medium copy is this picture's for good.
  if (await store.exists(`${stem}.withheld`)) return null;
  const failed = await stat(store.localPath?.(`${stem}.failed`) ?? "").catch(() => null);
  if (!failed || Date.now() - failed.mtimeMs > VISITOR_RETRY_AFTER_MS) {
    await enqueue(QUEUES.visitorCopy, { photoId: photo.id, imageVersion: photo.imageVersion, tv: true }, { singletonKey: `tv:${photo.id}:${photo.imageVersion}`, singletonSeconds: 3600 }).catch((err) =>
      console.error(`[photos] could not queue a television copy of ${photo.id}:`, err),
    );
  }
  return null;
}

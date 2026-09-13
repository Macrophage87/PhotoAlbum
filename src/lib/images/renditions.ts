import sharp from "sharp";
import { applyEdits, editedSize, hasEdits, type PhotoEdits } from "./edits";

export const RENDITION_SIZES = { thumb: 400, medium: 1600 } as const;
export type RenditionKey = keyof typeof RENDITION_SIZES;
export type Rendition = { key: string; w: number; h: number };
/** `full` is written only for an edited item: the whole picture with the edits on it, for the full-size view. */
export type Renditions = Record<RenditionKey, Rendition> & { full?: Rendition };

/**
 * Produce EXIF-orientation-corrected WebP renditions and the upright pixel dimensions, with any darkroom edits
 * applied. The original file is never written to: every rendition is made from it afresh, so clearing the edits
 * and re-rendering gives back exactly what was uploaded.
 */
export async function makeRenditions(
  input: string | Buffer,
  storageKeyPrefix: string,
  put: (key: string, buf: Buffer) => Promise<void>,
  edits: PhotoEdits | null = null,
): Promise<{ width: number; height: number; renditions: Renditions }> {
  const base = sharp(input, { failOn: "none", limitInputPixels: 300_000_000 }).rotate();
  const meta = await base.metadata();
  // After rotate(), width/height swap for 90° orientations.
  const rotated = meta.orientation && meta.orientation >= 5;
  const upright = { width: (rotated ? meta.height : meta.width) ?? 0, height: (rotated ? meta.width : meta.height) ?? 0 };
  const live = edits && hasEdits(edits) ? edits : null;
  const edited = () => (live ? applyEdits(base.clone(), live, upright) : base.clone());
  const { width, height } = editedSize(live, upright);

  const out: Partial<Renditions> = {};
  for (const [name, size] of Object.entries(RENDITION_SIZES) as [RenditionKey, number][]) {
    const { data, info } = await edited()
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .webp({ quality: name === "thumb" ? 78 : 84 })
      .toBuffer({ resolveWithObject: true });
    const key = `${storageKeyPrefix}/${name}.webp`;
    await put(key, data);
    out[name] = { key, w: info.width, h: info.height };
  }
  if (live) {
    // Edited items get a full-size copy as well, so "open the full-size photo" shows the picture as it is now; the
    // untouched original stays where it is and is always one click away.
    const { data, info } = await edited().webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
    const key = `${storageKeyPrefix}/edited.webp`;
    await put(key, data);
    out.full = { key, w: info.width, h: info.height };
  }
  return { width, height, renditions: out as Renditions };
}

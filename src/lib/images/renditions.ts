import sharp from "sharp";
import { applyEdits, editedSize, hasEdits, type PhotoEdits } from "./edits";
import { isPanoramaShape, type GPano } from "./panorama";

export const RENDITION_SIZES = { thumb: 400, medium: 1600 } as const;
/**
 * The editor's copy. It is only ever shown at about half the height of a screen, and a crop is stored as fractions
 * that the server applies to the full-size original, so nothing is lost by keeping this smaller than `medium`: it
 * loads faster on a phone and the browser has less to filter while a slider is being dragged.
 */
export const EDITOR_SIZE = 1200;
/**
 * A panorama's own copy. The 1600-pixel `medium` that serves every other photo leaves a 10:1 sweep 160 pixels tall,
 * which is nothing to pan around in, so a panorama gets a long edge of this instead — enough to fill the height of
 * a screen and still have somewhere to go sideways, without handing a phone the 60-megapixel original.
 */
export const PANORAMA_SIZE = 4096;
export type RenditionKey = keyof typeof RENDITION_SIZES;
export type Rendition = { key: string; w: number; h: number };
/**
 * `full` and `source` are written only for an edited item: `full` is the whole picture with the edits on it, for the
 * full-size view, and `source` is a smaller copy without them, which is what the editor shows so that opening it
 * again starts from the picture as it was rather than from one the edits have already been applied to.
 */
export type Renditions = Record<RenditionKey, Rendition> & { full?: Rendition; source?: Rendition; /** Panoramas only: the long copy the panorama viewer pans across. */ pano?: Rendition };

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
  /** What the file's own XMP claimed, where it claimed anything: a 2:1 equirectangular photo is a panorama by tag, not by shape. */
  gpano: GPano = null,
): Promise<{ width: number; height: number; renditions: Renditions; panorama: boolean }> {
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
    const full = await edited().webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
    const fullKey = `${storageKeyPrefix}/edited.webp`;
    await put(fullKey, full.data);
    out.full = { key: fullKey, w: full.info.width, h: full.info.height };
    // …and a medium copy with none of them on it, for the editor to start from.
    const source = await base
      .clone()
      .resize({ width: EDITOR_SIZE, height: EDITOR_SIZE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 84 })
      .toBuffer({ resolveWithObject: true });
    const sourceKey = `${storageKeyPrefix}/source.webp`;
    await put(sourceKey, source.data);
    out.source = { key: sourceKey, w: source.info.width, h: source.info.height };
  }
  // Judged on the picture as it will be shown: a crop can make a panorama out of a landscape, or an ordinary photo
  // out of a panorama, and either way it is the shape people end up looking at that decides.
  const panorama = gpano !== null || isPanoramaShape(width, height);
  if (panorama) {
    const long = Math.max(width, height);
    const pano = await edited()
      .resize({ width: PANORAMA_SIZE, height: PANORAMA_SIZE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    // Only worth a second file when it is meaningfully longer than the medium already made.
    if (long > RENDITION_SIZES.medium) {
      const key = `${storageKeyPrefix}/pano.webp`;
      await put(key, pano.data);
      out.pano = { key, w: pano.info.width, h: pano.info.height };
    }
  }
  return { width, height, renditions: out as Renditions, panorama };
}

import sharp from "sharp";

export const RENDITION_SIZES = { thumb: 400, medium: 1600 } as const;
export type RenditionKey = keyof typeof RENDITION_SIZES;
export type Rendition = { key: string; w: number; h: number };
export type Renditions = Record<RenditionKey, Rendition>;

/** Produce EXIF-orientation-corrected WebP renditions and the rotated pixel dimensions. */
export async function makeRenditions(
  input: string | Buffer,
  storageKeyPrefix: string,
  put: (key: string, buf: Buffer) => Promise<void>,
): Promise<{ width: number; height: number; renditions: Renditions }> {
  const base = sharp(input, { failOn: "none", limitInputPixels: 300_000_000 }).rotate();
  const meta = await base.metadata();
  // After rotate(), width/height swap for 90° orientations.
  const rotated = meta.orientation && meta.orientation >= 5;
  const width = (rotated ? meta.height : meta.width) ?? 0;
  const height = (rotated ? meta.width : meta.height) ?? 0;

  const out: Partial<Renditions> = {};
  for (const [name, size] of Object.entries(RENDITION_SIZES) as [RenditionKey, number][]) {
    const { data, info } = await base
      .clone()
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .webp({ quality: name === "thumb" ? 78 : 84 })
      .toBuffer({ resolveWithObject: true });
    const key = `${storageKeyPrefix}/${name}.webp`;
    await put(key, data);
    out[name] = { key, w: info.width, h: info.height };
  }
  return { width, height, renditions: out as Renditions };
}

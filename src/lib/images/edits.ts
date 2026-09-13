import { z } from "zod";
import type { Sharp } from "sharp";

/**
 * Darkroom edits, kept as instructions rather than baked into a file. Everything here is something a photographer
 * could have done in a darkroom or a camera: frame it differently, straighten it, lift the shadows, warm it up.
 * Nothing here adds, removes or moves anything in the picture, so an edited photo is still a record of what was
 * in front of the lens — which is why the original is always one click away rather than replaced.
 */
export const editsSchema = z.object({
  /** Crop as fractions of the upright image, so it survives a re-render at any size. */
  crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.05).max(1), h: z.number().min(0.05).max(1) }).optional(),
  /** Quarter turns clockwise, for a photo the camera got the wrong way up. */
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  /** Mirror left to right (a scan fed in back to front). */
  flip: z.boolean().optional(),
  brightness: z.number().min(0.4).max(1.8).optional(),
  contrast: z.number().min(0.4).max(1.8).optional(),
  saturation: z.number().min(0).max(2).optional(),
  /** Colour temperature, -100 (cooler, bluer) to 100 (warmer, more orange). */
  warmth: z.number().min(-100).max(100).optional(),
  /** Stretch the levels to use the full range: the "auto" button on any photo app. */
  auto: z.boolean().optional(),
  sharpen: z.boolean().optional(),
});

export type PhotoEdits = z.infer<typeof editsSchema>;

export const NEUTRAL: Required<Pick<PhotoEdits, "brightness" | "contrast" | "saturation" | "warmth">> = { brightness: 1, contrast: 1, saturation: 1, warmth: 0 };

/** Whether these instructions would change the picture at all; an empty set is stored as no edits. */
export function hasEdits(e: PhotoEdits | null | undefined): boolean {
  if (!e) return false;
  if (e.crop && (e.crop.x > 0 || e.crop.y > 0 || e.crop.w < 1 || e.crop.h < 1)) return true;
  if (e.rotate) return true;
  if (e.flip || e.auto || e.sharpen) return true;
  return (e.brightness ?? 1) !== 1 || (e.contrast ?? 1) !== 1 || (e.saturation ?? 1) !== 1 || (e.warmth ?? 0) !== 0;
}

/** Drop anything that is already neutral, so "no edits" really means no edits and the badge is honest. */
export function tidyEdits(e: PhotoEdits): PhotoEdits | null {
  const out: PhotoEdits = {};
  if (e.crop && (e.crop.x > 0 || e.crop.y > 0 || e.crop.w < 1 || e.crop.h < 1)) out.crop = e.crop;
  if (e.rotate) out.rotate = e.rotate;
  if (e.flip) out.flip = true;
  if (e.auto) out.auto = true;
  if (e.sharpen) out.sharpen = true;
  if ((e.brightness ?? 1) !== 1) out.brightness = e.brightness;
  if ((e.contrast ?? 1) !== 1) out.contrast = e.contrast;
  if ((e.saturation ?? 1) !== 1) out.saturation = e.saturation;
  if ((e.warmth ?? 0) !== 0) out.warmth = e.warmth;
  return hasEdits(out) ? out : null;
}

/**
 * Warmth as a multiplier per channel. The preview in the browser runs the same numbers through an SVG colour
 * matrix, so what a member sees while dragging the slider is what the server renders.
 */
export function warmthChannels(warmth: number): [number, number, number] {
  const w = Math.max(-100, Math.min(100, warmth)) / 100;
  return [1 + 0.18 * w, 1 + 0.02 * w, 1 - 0.18 * w];
}

/**
 * Where auto levels starts and stops: the same percentiles sharp's `normalise` uses, so the browser measuring the
 * picture and the server stretching it are working to the same ends of the range.
 */
export const LEVELS_PERCENTILES = { lower: 1, upper: 99 } as const;

/**
 * The straight line that stretches a picture's levels to fill the range: everything at or below `low` goes to black,
 * everything at or above `high` to white. Returns null when there is nothing worth stretching, which is what keeps
 * auto levels from wrecking a photograph that is deliberately soft or low contrast.
 */
export function levelsStretch(low: number, high: number): { mul: number; off: number } | null {
  if (!(high > low) || high - low < 4) return null;
  const mul = 255 / (high - low);
  return { mul, off: -low * mul };
}

/** Enough pixels to find a percentile honestly, few enough to measure a hundred times a second while a crop is dragged. */
export const LEVELS_SAMPLE_WIDTH = 256;

/**
 * The levels of one part of a small copy of a picture: a luminance histogram over the crop, then the percentiles
 * auto levels pulls from. Pure, and deliberately over a cached copy rather than the picture itself — re-reading the
 * full-size image on every pointer move while someone drags a crop is what makes an editor feel slow.
 */
export function levelsOfRegion(pixels: { data: Uint8ClampedArray | number[]; width: number; height: number }, crop: { x: number; y: number; w: number; h: number }): { mul: number; off: number } | null {
  const { data, width, height } = pixels;
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(crop.x * width)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(crop.y * height)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((crop.x + crop.w) * width)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((crop.y + crop.h) * height)));
  const histogram = new Array<number>(256).fill(0);
  let counted = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 8) continue; // ignore what is transparent
      histogram[Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])] += 1;
      counted += 1;
    }
  }
  if (!counted) return null;
  const at = (percent: number) => {
    let seen = 0;
    const target = (counted * percent) / 100;
    for (let v = 0; v < 256; v += 1) {
      seen += histogram[v];
      if (seen >= target) return v;
    }
    return 255;
  };
  return levelsStretch(at(LEVELS_PERCENTILES.lower), at(LEVELS_PERCENTILES.upper));
}

/** Contrast around mid grey, as a multiplier and an offset in 0-255 terms. */
export function contrastTerms(contrast: number): { mul: number; off: number } {
  return { mul: contrast, off: 128 * (1 - contrast) };
}

/**
 * Apply the instructions to an already upright image (the caller has done sharp's EXIF `.rotate()`), in the order a
 * darkroom would: frame it, then straighten, then the light, then the colour, then sharpen.
 */
export function applyEdits(img: Sharp, edits: PhotoEdits, size: { width: number; height: number }): Sharp {
  let out = img;
  if (edits.crop) {
    const left = Math.round(edits.crop.x * size.width);
    const top = Math.round(edits.crop.y * size.height);
    const width = Math.max(1, Math.min(size.width - left, Math.round(edits.crop.w * size.width)));
    const height = Math.max(1, Math.min(size.height - top, Math.round(edits.crop.h * size.height)));
    out = out.extract({ left, top, width, height });
  }
  if (edits.flip) out = out.flop();
  if (edits.rotate) out = out.rotate(edits.rotate);
  if (edits.auto) out = out.normalise({ lower: LEVELS_PERCENTILES.lower, upper: LEVELS_PERCENTILES.upper });
  const warmth = edits.warmth ?? 0;
  const contrast = edits.contrast ?? 1;
  if (warmth !== 0 || contrast !== 1) {
    const [r, g, b] = warmthChannels(warmth);
    const { mul, off } = contrastTerms(contrast);
    out = out.linear([r * mul, g * mul, b * mul], [off, off, off]);
  }
  const brightness = edits.brightness ?? 1;
  const saturation = edits.saturation ?? 1;
  if (brightness !== 1 || saturation !== 1) out = out.modulate({ brightness, saturation });
  if (edits.sharpen) out = out.sharpen();
  return out;
}

/** The size of the picture after cropping and turning, for the dimensions stored on the row. */
export function editedSize(edits: PhotoEdits | null, size: { width: number; height: number }): { width: number; height: number } {
  if (!edits) return size;
  let width = size.width, height = size.height;
  if (edits.crop) {
    width = Math.max(1, Math.round(edits.crop.w * width));
    height = Math.max(1, Math.round(edits.crop.h * height));
  }
  if (edits.rotate === 90 || edits.rotate === 270) return { width: height, height: width };
  return { width, height };
}

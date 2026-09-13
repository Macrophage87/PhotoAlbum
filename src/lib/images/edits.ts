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
  if (edits.auto) out = out.normalise();
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

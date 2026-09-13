/**
 * Panoramas.
 *
 * A panorama is not just a big photo: shown the way every other photo is shown — scaled to fit the screen — a 10:1
 * sweep of a valley becomes a letterboxed sliver an inch tall, which is the one way of presenting it that throws
 * away the reason it was taken. So the album recognises them and treats them differently: a wider tile, a viewer
 * that fills the height and is dragged sideways, and enough resolution kept that dragging is worth doing.
 *
 * Two things say "panorama". A phone that swept one, or a camera that stitched one, writes Google's GPano tags into
 * the file's XMP — authoritative, and the only way to know a photo is a full 360 that should wrap around rather
 * than stop at its edges. Everything else is recognised by its shape.
 */

/** Wide enough that fitting it to a screen would waste it. A cropped landscape is about 2:1; a swept panorama is far wider. */
export const PANORAMA_RATIO = 2.2;

export type PanoProjection = "EQUIRECTANGULAR_360" | "EQUIRECTANGULAR" | "CYLINDRICAL";

export type GPano = { projection: PanoProjection; /** How much of the way round it goes, 0–1, where 1 is the whole world. */ coverage: number } | null;

/** True when the shape alone says panorama, in either direction: a swept horizon, or a tower from pavement to sky. */
export function isPanoramaShape(width: number, height: number): boolean {
  if (!width || !height) return false;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  return long / short >= PANORAMA_RATIO;
}

/** Which way it runs, which is the way it is dragged. */
export function panoramaAxis(width: number, height: number): "horizontal" | "vertical" {
  return width >= height ? "horizontal" : "vertical";
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Read Google's panorama tags out of whatever XMP the file carries. `UsePanoramaViewer` is the camera saying "this
 * wants a panorama viewer"; the cropped-area fields say how much of the sphere is actually here, which is what
 * separates a full 360 that should wrap from a wide sweep that has two ends.
 */
export function gpanoFrom(raw: Record<string, unknown> | undefined | null): GPano {
  if (!raw) return null;
  const projection = String(raw.ProjectionType ?? raw.GPanoProjectionType ?? "").toLowerCase();
  const uses = raw.UsePanoramaViewer === true || String(raw.UsePanoramaViewer ?? "").toLowerCase() === "true";
  const fullWidth = num(raw.FullPanoWidthPixels);
  const croppedWidth = num(raw.CroppedAreaImageWidthPixels);
  if (!projection && !uses && fullWidth === null) return null;
  const coverage = fullWidth && croppedWidth ? Math.min(1, croppedWidth / fullWidth) : 1;
  if (projection.includes("equirectangular")) {
    // Within a pixel or so of the whole way round: the two edges meet, so the viewer can run on for ever.
    return { projection: coverage >= 0.999 ? "EQUIRECTANGULAR_360" : "EQUIRECTANGULAR", coverage };
  }
  if (projection.includes("cylindrical")) return { projection: "CYLINDRICAL", coverage };
  return uses || fullWidth !== null ? { projection: "CYLINDRICAL", coverage } : null;
}

/** How a panorama is described wherever one is shown. */
export function panoramaLabel(projection: string | null): string {
  return projection === "EQUIRECTANGULAR_360" ? "360° panorama" : "Panorama";
}

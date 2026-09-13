/** Media types the album accepts, shared by the browser uploader, the Takeout importer and the Google Photos importer. */
export const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/tiff", "image/avif", "image/gif"]);
// Short clips only; HEVC inside MOV or MP4 from phones is covered by the first two.
export const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
/**
 * 3D scans, as a phone scanner exports them. Scaniverse gives a mesh as .glb (which the album can show and put into
 * augmented reality on a phone) or .usdz (Apple's, which Apple devices open by themselves), and a gaussian splat as
 * .ply or .spz — a cloud of coloured points that no browser renders on its own, so those are kept whole and handed
 * back rather than drawn. Browsers send little or nothing as the type for any of them, so the extension decides.
 */
export const SCAN_MIMES = new Set(["model/gltf-binary", "model/vnd.usdz+zip", "application/x-ply", "application/x-spz"]);
export const ALLOWED_MIMES = new Set([...IMAGE_MIMES, ...VIDEO_MIMES, ...SCAN_MIMES]);
export const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tif",
  "image/avif": "avif",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "model/gltf-binary": "glb",
  "model/vnd.usdz+zip": "usdz",
  "application/x-ply": "ply",
  "application/x-spz": "spz",
};
// Browsers often send an empty or generic type for .mov, so the extension decides then.
export const EXT_MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff", avif: "image/avif", gif: "image/gif", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", glb: "model/gltf-binary", usdz: "model/vnd.usdz+zip", ply: "application/x-ply", spz: "application/x-spz" };

/** What the album can do with a scan of this shape. */
export type ScanFormat = "GLB" | "USDZ" | "PLY" | "SPZ";

const SCAN_FORMAT: Record<string, ScanFormat> = { "model/gltf-binary": "GLB", "model/vnd.usdz+zip": "USDZ", "application/x-ply": "PLY", "application/x-spz": "SPZ" };

export function scanFormatOf(mime: string): ScanFormat | null {
  return SCAN_FORMAT[mime] ?? null;
}

/** Only a glTF mesh can be drawn in a browser; the rest are kept and handed back as they came. */
export function scanIsViewable(format: string | null): boolean {
  return format === "GLB";
}

/** Which of the album's three kinds of thing a file is, decided by its type. */
export function kindForMime(mime: string): "PHOTO" | "VIDEO" | "SCAN" {
  if (VIDEO_MIMES.has(mime)) return "VIDEO";
  if (SCAN_MIMES.has(mime)) return "SCAN";
  return "PHOTO";
}

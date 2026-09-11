/** Media types the album accepts, shared by the browser uploader, the Takeout importer and the Google Photos importer. */
export const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/tiff", "image/avif", "image/gif"]);
// Short clips only; HEVC inside MOV or MP4 from phones is covered by the first two.
export const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
export const ALLOWED_MIMES = new Set([...IMAGE_MIMES, ...VIDEO_MIMES]);
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
};
// Browsers often send an empty or generic type for .mov, so the extension decides then.
export const EXT_MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff", avif: "image/avif", gif: "image/gif", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

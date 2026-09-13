import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { storage } from "@/lib/storage";
import type { Renditions } from "@/lib/images/renditions";
import type { VideoRenditions } from "@/lib/jobs/handlers/transcode-video";
import { mediaAccessInclude, mediaBytesAllowed, mediaCacheControl, toMediaAccess } from "@/lib/photos/access";

const MIME: Record<string, string> = { webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", tif: "image/tiff", avif: "image/avif", gif: "image/gif", mp4: "video/mp4" };

/** Parse a single-range `Range` header against a known size; null when absent, an error response when unsatisfiable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid";
  let start = m[1] ? Number(m[1]) : NaN;
  let end = m[2] ? Number(m[2]) : NaN;
  if (Number.isNaN(start) && Number.isNaN(end)) return "invalid";
  if (Number.isNaN(start)) {
    // suffix range: last N bytes
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (Number.isNaN(end) || end >= size) end = size - 1;
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/**
 * The single enforcement point for media bytes (photo renditions, video renditions and range requests, posters).
 * Access follows the item's containers: members see everything, anonymous visitors see items in PUBLIC containers,
 * share-link holders see items in the LINK container their cookie (or `?share=&kind=`) names. Every range request
 * repeats the check.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; size: string }> }) {
  const { id, size } = await params;
  if (!["thumb", "medium", "pano", "original", "edited", "source", "video", "poster", "model"].includes(size)) return new Response("Not found", { status: 404 });

  const photo = await db.photo.findUnique({
    where: { id },
    select: { id: true, status: true, originalPath: true, originalName: true, renditions: true, videoRenditions: true, storageKey: true, mimeType: true, kind: true, ...mediaAccessInclude },
  });
  if (!photo) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const viewer = await getViewer();
  const media = toMediaAccess(photo);
  if (!mediaBytesAllowed(viewer, media, { token: url.searchParams.get("share"), kind: url.searchParams.get("kind") })) {
    return new Response("Forbidden", { status: viewer.kind === "user" ? 403 : 401 });
  }

  let key: string;
  let contentType: string;
  const video = photo.videoRenditions as VideoRenditions | null;
  if (size === "original") {
    key = photo.originalPath;
    contentType = photo.mimeType;
  } else if (size === "video") {
    if (!video?.mp4) return new Response("Not ready", { status: 404 });
    key = video.mp4.key;
    contentType = "video/mp4";
  } else if (size === "poster") {
    if (!video?.poster) return new Response("Not ready", { status: 404 });
    key = video.poster.key;
    contentType = "image/jpeg";
  } else if (size === "source") {
    // The picture without any darkroom edits, at medium size, for the editor. An unedited item has no such file
    // because its medium copy already is one.
    const r = (photo.renditions as Renditions | null);
    const chosen = r?.source ?? r?.medium;
    if (!chosen) return new Response("Not ready", { status: 404 });
    key = chosen.key;
    contentType = MIME[key.split(".").pop() ?? ""] ?? "image/webp";
  } else if (size === "model") {
    // The scan itself, as it was uploaded. A viewer asks for it in ranges, which the response below already does.
    if (photo.kind !== "SCAN") return new Response("Not a scan", { status: 404 });
    key = photo.originalPath;
    contentType = photo.mimeType;
  } else if (size === "pano") {
    // The long copy a panorama is panned across. Anything that is not a panorama, or is not long enough to have
    // earned one, answers with its medium copy rather than nothing.
    const r = photo.renditions as Renditions | null;
    const chosen = r?.pano ?? r?.medium;
    if (!chosen) return new Response("Not ready", { status: 404 });
    key = chosen.key;
    contentType = MIME[key.split(".").pop() ?? ""] ?? "image/webp";
  } else if (size === "edited") {
    // The whole picture as it is now. An item with no edits has no such file, so the original is the right answer.
    const full = (photo.renditions as Renditions | null)?.full;
    key = full?.key ?? photo.originalPath;
    contentType = full ? MIME[full.key.split(".").pop() ?? ""] ?? "image/webp" : photo.mimeType;
  } else {
    const r = (photo.renditions as Renditions | null)?.[size as "thumb" | "medium"];
    if (!r) return new Response("Not ready", { status: 404 });
    key = r.key;
    contentType = MIME[key.split(".").pop() ?? ""] ?? "application/octet-stream";
  }

  const store = storage();
  const whole = await store.getStream(key).catch(() => null);
  if (!whole) return new Response("Not found", { status: 404 });
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": mediaCacheControl(media, url.searchParams.has("v")),
    "Accept-Ranges": "bytes",
  };
  if (size === "original") headers["Content-Disposition"] = `inline; filename="${encodeURIComponent(photo.originalName)}"`;

  const range = parseRange(request.headers.get("range"), whole.size);
  if (range === "invalid") {
    whole.stream.destroy();
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${whole.size}` } });
  }
  if (range) {
    whole.stream.destroy();
    const part = await store.getStream(key, range);
    headers["Content-Length"] = String(range.end - range.start + 1);
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${whole.size}`;
    return new Response(Readable.toWeb(part.stream) as ReadableStream, { status: 206, headers });
  }
  headers["Content-Length"] = String(whole.size);
  return new Response(Readable.toWeb(whole.stream) as ReadableStream, { headers });
}

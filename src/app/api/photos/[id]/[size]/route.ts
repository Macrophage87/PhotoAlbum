import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { storage } from "@/lib/storage";
import type { Renditions } from "@/lib/images/renditions";
import type { VideoRenditions } from "@/lib/jobs/handlers/transcode-video";
import { mediaAccessInclude, mediaBytesAllowed, mediaCacheControl, toMediaAccess } from "@/lib/photos/access";
import { jpegPreview } from "@/lib/images/preview";
import { MEDIA_CSP } from "@/lib/security/csp";
import { viewerFor } from "@/lib/auth/access";
import { largestRendition } from "@/lib/photos/urls";
import { cleanCopy } from "@/lib/images/clean-copy";
import { publicScanCopy } from "@/lib/scans/public-copy";

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
 *
 * The file as uploaded (and the editor's uncropped copy) is the family's: it carries the camera's EXIF, GPS included,
 * and whatever a crop or "remove place" took out. Anybody else — a visitor, a share link, a member reading a share
 * page (`?view=share`) — asking for it, or for the edited full size, gets the same picture at the same size as a
 * copy made for them: upright, edited, and with no metadata (see `lib/images/clean-copy`). A 3D scan has no picture
 * to stand in for it: they get its model only, as a copy with its metadata taken out (see `lib/scans/sanitize`), or
 * nothing for a format that cannot be cleaned.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; size: string }> }) {
  const { id, size } = await params;
  if (!["thumb", "medium", "pano", "preview", "original", "edited", "source", "video", "poster", "model"].includes(size)) return new Response("Not found", { status: 404 });

  const photo = await db.photo.findUnique({
    where: { id },
    select: { id: true, status: true, originalPath: true, originalName: true, renditions: true, videoRenditions: true, storageKey: true, mimeType: true, kind: true, scanFormat: true, edits: true, imageVersion: true, updatedAt: true, ...mediaAccessInclude },
  });
  if (!photo) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const viewer = await getViewer();
  const media = toMediaAccess(photo);
  if (!mediaBytesAllowed(viewer, media, { token: url.searchParams.get("share"), kind: url.searchParams.get("kind") })) {
    return new Response("Forbidden", { status: viewer.kind === "user" ? 403 : 401 });
  }

  const video = photo.videoRenditions as VideoRenditions | null;
  const outsider = viewerFor(viewer, url.searchParams.get("view")).kind !== "user" || url.searchParams.has("share");
  if (outsider && photo.kind === "SCAN" && size !== "thumb" && size !== "medium" && size !== "pano" && size !== "preview") {
    // Never the uploaded file, nor its name: the cleaned model, where there is one, and that is all.
    const key = size === "model" ? await publicScanCopy(photo).catch(() => null) : null;
    if (!key) return new Response("Not available", { status: 404 });
    return serve(request, key, photo.mimeType, byViewer(url));
  }
  const withheld = outsider && (size === "original" || size === "edited" || size === "source");
  if (withheld) {
    let key: string | undefined;
    if (photo.kind === "VIDEO") key = video?.mp4?.key;
    // The editor's copy is the picture before its crop, so the medium, which has it, answers instead.
    else if (size === "source") key = (photo.renditions as Renditions | null)?.medium?.key;
    else {
      // A photograph at its full size, made for them; should that fail, the largest picture the album already has.
      const full = photo.kind === "PHOTO" ? await cleanCopy(photo).catch((err) => void console.error(`[photos] no clean copy of ${photo.id}:`, err)) : null;
      key = full?.key ?? largestRendition(photo.renditions as Renditions | null)?.rendition.key;
    }
    if (!key) return new Response("Not ready", { status: 404 });
    return serve(request, key, MIME[key.split(".").pop() ?? ""] ?? "image/webp", byViewer(url));
  }

  if (size === "preview") {
    // The picture on a link's card, as JPEG. Nothing on the site asks for this: it exists because the things that
    // draw link previews will not draw WebP, and a card with no picture is the thing nobody clicks.
    const medium = (photo.renditions as Renditions | null)?.medium;
    const poster = video?.poster;
    if (!medium && !poster) return new Response("Not ready", { status: 404 });
    const jpeg = await jpegPreview((medium ?? poster!).key).catch(() => null);
    if (!jpeg) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(jpeg), {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(jpeg.byteLength),
        "Cache-Control": mediaCacheControl(media, url.searchParams.has("v")),
      },
    });
  }

  let key: string;
  let contentType: string;
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

  const extra: Record<string, string> = size === "original" || size === "edited" || size === "source" || size === "model" ? byViewer(url) : { "Cache-Control": mediaCacheControl(media, url.searchParams.has("v")) };
  if (size === "original") extra["Content-Disposition"] = `inline; filename="${encodeURIComponent(photo.originalName)}"`;
  return serve(request, key, contentType, extra);
}

/**
 * Cache headers for an address whose answer depends on who asks (the original for a member, a rendition for anybody
 * else): never a shared cache, and a browser keeps it only for the cookie it was fetched with.
 */
function byViewer(url: URL): Record<string, string> {
  return { "Cache-Control": url.searchParams.has("v") ? "private, max-age=86400" : "private, max-age=0, must-revalidate", Vary: "Cookie" };
}

/** Stream one stored file, whole or by the single range asked for. */
async function serve(request: Request, key: string, contentType: string, extra: Record<string, string>): Promise<Response> {
  const store = storage();
  const whole = await store.getStream(key).catch(() => null);
  if (!whole) return new Response("Not found", { status: 404 });
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    // The real guard is next.config.ts's entry for /api/photos/*: when it has set this header, Next keeps it and
    // this copy is dropped. It only takes effect should that entry ever stop matching; a unit test keeps them equal.
    "Content-Security-Policy": MEDIA_CSP,
    ...extra,
  };

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

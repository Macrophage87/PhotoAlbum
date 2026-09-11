import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { storage } from "@/lib/storage";
import type { Renditions } from "@/lib/images/renditions";
import { mediaAccessInclude, mediaBytesAllowed, mediaCacheControl, toMediaAccess } from "@/lib/photos/access";

const MIME: Record<string, string> = { webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", tif: "image/tiff", avif: "image/avif", gif: "image/gif" };

/**
 * The single enforcement point for media bytes. Access follows the item's containers (trip and collections):
 * members see everything, anonymous visitors see items in PUBLIC containers, share-link holders see items in
 * the LINK container their cookie (or `?share=&kind=`) names.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; size: string }> }) {
  const { id, size } = await params;
  if (!["thumb", "medium", "original"].includes(size)) return new Response("Not found", { status: 404 });

  const photo = await db.photo.findUnique({
    where: { id },
    select: { id: true, status: true, originalPath: true, originalName: true, renditions: true, storageKey: true, mimeType: true, ...mediaAccessInclude },
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
  if (size === "original") {
    key = photo.originalPath;
    contentType = photo.mimeType;
  } else {
    const r = (photo.renditions as Renditions | null)?.[size as "thumb" | "medium"];
    if (!r) return new Response("Not ready", { status: 404 });
    key = r.key;
    contentType = MIME[key.split(".").pop() ?? ""] ?? "application/octet-stream";
  }

  const { stream, size: bytes } = await storage().getStream(key).catch(() => ({ stream: null, size: 0 }));
  if (!stream) return new Response("Not found", { status: 404 });

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(bytes),
    "Cache-Control": mediaCacheControl(media, url.searchParams.has("v")),
  };
  if (size === "original") headers["Content-Disposition"] = `inline; filename="${encodeURIComponent(photo.originalName)}"`;
  return new Response(Readable.toWeb(stream) as ReadableStream, { headers });
}

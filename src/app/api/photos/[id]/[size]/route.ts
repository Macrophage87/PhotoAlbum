import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canViewTrip } from "@/lib/auth/access";
import { storage } from "@/lib/storage";
import type { Renditions } from "@/lib/images/renditions";

const MIME: Record<string, string> = { webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", tif: "image/tiff", avif: "image/avif", gif: "image/gif" };

/** Serves a photo rendition with the same access rules as its trip. Photos without a trip are members-only. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; size: string }> }) {
  const { id, size } = await params;
  if (!["thumb", "medium", "original"].includes(size)) return new Response("Not found", { status: 404 });

  const photo = await db.photo.findUnique({
    where: { id },
    select: { id: true, status: true, originalPath: true, originalName: true, renditions: true, storageKey: true, mimeType: true, trip: { select: { id: true, visibility: true, shareToken: true } } },
  });
  if (!photo) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const viewer = await getViewer();
  const shareParam = url.searchParams.get("share");
  const tokenMatches = Boolean(shareParam) && photo.trip?.visibility === "LINK" && photo.trip.shareToken === shareParam;
  const allowed = photo.trip ? canViewTrip(viewer, photo.trip) || tokenMatches : viewer.kind === "user";
  if (!allowed) return new Response("Forbidden", { status: viewer.kind === "user" ? 403 : 401 });

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

  const isPublic = photo.trip?.visibility === "PUBLIC";
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(bytes),
    "Cache-Control": `${isPublic ? "public" : "private"}, max-age=31536000, immutable`,
  };
  if (size === "original") headers["Content-Disposition"] = `inline; filename="${encodeURIComponent(photo.originalName)}"`;
  if (!url.searchParams.has("v")) headers["Cache-Control"] = "private, max-age=0, must-revalidate";
  return new Response(Readable.toWeb(stream) as ReadableStream, { headers });
}

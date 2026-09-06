import { Readable } from "node:stream";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getViewer } from "@/lib/auth/viewer";
import { storage, StorageLimitError } from "@/lib/storage";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";

export const dynamic = "force-dynamic";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/tiff", "image/avif", "image/gif"]);
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tif",
  "image/avif": "avif",
  "image/gif": "gif",
};
const EXT_MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff", avif: "image/avif", gif: "image/gif" };

const headerSchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().optional(),
  tripId: z.string().optional(),
  lastModified: z.coerce.number().optional(),
});

/** Streams one file to storage and queues processing. Body is the raw file; metadata rides in headers. */
export async function POST(request: Request) {
  const viewer = await getViewer();
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!request.body) return Response.json({ error: "Empty body" }, { status: 400 });

  const parsed = headerSchema.safeParse({
    fileName: decodeURIComponent(request.headers.get("x-file-name") ?? ""),
    contentType: request.headers.get("content-type") ?? undefined,
    tripId: request.headers.get("x-trip-id") ?? undefined,
    lastModified: request.headers.get("x-last-modified") ?? undefined,
  });
  if (!parsed.success) return Response.json({ error: "Bad upload headers" }, { status: 400 });
  const { fileName, tripId, lastModified } = parsed.data;

  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  let mime = parsed.data.contentType?.split(";")[0].trim() ?? "";
  if (!ALLOWED.has(mime)) mime = EXT_MIME[ext] ?? "";
  if (!ALLOWED.has(mime)) return Response.json({ error: `Unsupported file type: ${fileName}` }, { status: 415 });

  if (tripId) {
    const trip = await db.trip.findUnique({ where: { id: tripId }, select: { id: true } });
    if (!trip) return Response.json({ error: "Trip not found" }, { status: 404 });
  }

  const photo = await db.photo.create({
    data: {
      uploaderId: viewer.user.id,
      tripId: tripId ?? null,
      status: "PENDING",
      originalName: fileName,
      mimeType: mime,
      storageKey: "pending",
      originalPath: "pending",
      sizeBytes: 0,
      exif: lastModified ? { fileLastModified: lastModified } : undefined,
    },
  });
  const storageKey = `photos/${photo.id}`;
  const originalPath = `${storageKey}/original.${EXT_BY_MIME[mime]}`;

  try {
    const { bytes } = await storage().putStream(originalPath, Readable.fromWeb(request.body as never), { maxBytes: env().MAX_UPLOAD_BYTES });
    await db.photo.update({ where: { id: photo.id }, data: { storageKey, originalPath, sizeBytes: bytes } });
  } catch (err) {
    await db.photo.delete({ where: { id: photo.id } }).catch(() => {});
    if (err instanceof StorageLimitError) return Response.json({ error: `File is larger than ${Math.round(err.maxBytes / 1048576)} MB` }, { status: 413 });
    console.error("[upload]", err);
    return Response.json({ error: "Upload failed" }, { status: 500 });
  }

  try {
    await enqueue(QUEUES.processPhoto, { photoId: photo.id, tripId: tripId ?? null });
  } catch (err) {
    console.error("[upload] could not queue processing", err);
    await db.photo.update({ where: { id: photo.id }, data: { status: "FAILED", error: "Could not queue processing; use Re-process on the photo page." } }).catch(() => {});
    return Response.json({ error: "Upload stored but processing could not be queued" }, { status: 500 });
  }
  return Response.json({ photoId: photo.id });
}

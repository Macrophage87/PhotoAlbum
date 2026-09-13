import { Readable } from "node:stream";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getViewer } from "@/lib/auth/viewer";
import { storage, StorageLimitError } from "@/lib/storage";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { ALLOWED_MIMES as ALLOWED, EXT_BY_MIME, EXT_MIME, VIDEO_MIMES as VIDEO } from "@/lib/media/mime";

export const dynamic = "force-dynamic";

const headerSchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().optional(),
  tripId: z.string().optional(),
  activityId: z.string().optional(),
  lastModified: z.coerce.number().optional(),
  annotationOptOut: z.string().optional(),
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
    activityId: request.headers.get("x-activity-id") ?? undefined,
    lastModified: request.headers.get("x-last-modified") ?? undefined,
    annotationOptOut: request.headers.get("x-annotation-opt-out") ?? undefined,
  });
  if (!parsed.success) return Response.json({ error: "Bad upload headers" }, { status: 400 });
  const { fileName, lastModified } = parsed.data;
  let tripId = parsed.data.tripId;

  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  let mime = parsed.data.contentType?.split(";")[0].trim() ?? "";
  if (!ALLOWED.has(mime)) mime = EXT_MIME[ext] ?? "";
  if (!ALLOWED.has(mime)) return Response.json({ error: `Unsupported file type: ${fileName}` }, { status: 415 });

  if (tripId) {
    const trip = await db.trip.findUnique({ where: { id: tripId }, select: { id: true } });
    if (!trip) return Response.json({ error: "Trip not found" }, { status: 404 });
  }
  // Uploading into an activity says both where it belongs and which trip it is on, whatever its own date turns out
  // to be — a scan of a photograph from the walk belongs on the walk.
  const activityId = parsed.data.activityId;
  if (activityId) {
    const activity = await db.activity.findUnique({ where: { id: activityId }, select: { id: true, tripId: true } });
    if (!activity) return Response.json({ error: "Activity not found" }, { status: 404 });
    tripId = activity.tripId;
  }

  const isVideo = VIDEO.has(mime);
  const photo = await db.photo.create({
    data: {
      uploaderId: viewer.user.id,
      tripId: tripId ?? null,
      activityId: activityId ?? null,
      activitySetById: activityId ? viewer.user.id : null,
      kind: isVideo ? "VIDEO" : "PHOTO",
      annotationOptOut: parsed.data.annotationOptOut === "1",
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
    const { bytes } = await storage().putStream(originalPath, Readable.fromWeb(request.body as never), { maxBytes: isVideo ? env().MAX_VIDEO_UPLOAD_BYTES : env().MAX_UPLOAD_BYTES });
    await db.photo.update({ where: { id: photo.id }, data: { storageKey, originalPath, sizeBytes: bytes } });
  } catch (err) {
    await db.photo.delete({ where: { id: photo.id } }).catch(() => {});
    if (err instanceof StorageLimitError) return Response.json({ error: `File is larger than ${Math.round(err.maxBytes / 1048576)} MB` }, { status: 413 });
    console.error("[upload]", err);
    return Response.json({ error: "Upload failed" }, { status: 500 });
  }

  try {
    if (isVideo) await enqueue(QUEUES.transcodeVideo, { photoId: photo.id, tripId: tripId ?? null });
    else await enqueue(QUEUES.processPhoto, { photoId: photo.id, tripId: tripId ?? null });
  } catch (err) {
    console.error("[upload] could not queue processing", err);
    await db.photo.update({ where: { id: photo.id }, data: { status: "FAILED", error: "Could not queue processing; use Re-process on the photo page." } }).catch(() => {});
    return Response.json({ error: "Upload stored but processing could not be queued" }, { status: 500 });
  }
  return Response.json({ photoId: photo.id });
}

import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getViewer } from "@/lib/auth/viewer";
import { storage, StorageLimitError } from "@/lib/storage";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { fileExisting } from "@/lib/photos/file-existing";
import { uploaderLabel } from "@/components/photos/toGrid";
import { ALLOWED_MIMES as ALLOWED, EXT_BY_MIME, EXT_MIME, kindForMime, scanFormatOf, VIDEO_MIMES as VIDEO } from "@/lib/media/mime";

export const dynamic = "force-dynamic";

const headerSchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().optional(),
  tripId: z.string().optional(),
  activityId: z.string().optional(),
  collectionId: z.string().optional(),
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
    collectionId: request.headers.get("x-collection-id") ?? undefined,
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
  const collectionId = parsed.data.collectionId;
  if (collectionId && !(await db.collection.findUnique({ where: { id: collectionId }, select: { id: true } }))) {
    return Response.json({ error: "Collection not found" }, { status: 404 });
  }

  const isVideo = VIDEO.has(mime);
  const kind = kindForMime(mime);
  const photo = await db.photo.create({
    data: {
      uploaderId: viewer.user.id,
      tripId: tripId ?? null,
      activityId: activityId ?? null,
      activitySetById: activityId ? viewer.user.id : null,
      kind,
      scanFormat: scanFormatOf(mime),
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

  // The bytes are counted as they go past anyway, so they are weighed for sameness at the same time: an upload of a
  // file the album already holds is the same file, not another copy of it, however it came to be sent twice.
  const digest = createHash("sha256");
  const weigh = new Transform({ transform(chunk, _enc, cb) { digest.update(chunk); cb(null, chunk); } });
  let contentHash = "";
  try {
    const { bytes } = await storage().putStream(originalPath, Readable.fromWeb(request.body as never).pipe(weigh), { maxBytes: isVideo ? env().MAX_VIDEO_UPLOAD_BYTES : env().MAX_UPLOAD_BYTES });
    contentHash = digest.digest("hex");
    const already = await db.photo.findFirst({
      where: { contentHash, trashedAt: null, id: { not: photo.id } },
      select: { id: true, originalName: true, trip: { select: { slug: true, title: true } }, uploader: { select: { name: true, email: true } } },
    });
    if (already) {
      // Nothing is kept: neither the bytes just written nor the row that was waiting for them. The member is told
      // which one the album already has, so "it did not appear" is never the impression left behind. Sent to a
      // particular trip, activity or collection, the one the album has is put there instead of a second copy.
      await storage().deletePrefix(storageKey).catch(() => undefined);
      await db.photo.delete({ where: { id: photo.id } }).catch(() => {});
      const filed = await fileExisting(viewer.user, already.id, { tripId: tripId ?? null, activityId: activityId ?? null, collectionId: collectionId ?? null });
      return Response.json({
        photoId: already.id,
        duplicate: true,
        originalName: already.originalName,
        trip: already.trip ?? null,
        filed,
        // Whose it is, only when that is why it stayed put; members see who added what everywhere else too.
        owner: filed.notYours ? uploaderLabel(already.uploader.name, already.uploader.email) : null,
      });
    }
    await db.photo.update({ where: { id: photo.id }, data: { storageKey, originalPath, sizeBytes: bytes, contentHash } });
    if (collectionId) await fileExisting(viewer.user, photo.id, { collectionId });
  } catch (err) {
    await db.photo.delete({ where: { id: photo.id } }).catch(() => {});
    if (err instanceof StorageLimitError) return Response.json({ error: `File is larger than ${Math.round(err.maxBytes / 1048576)} MB` }, { status: 413 });
    console.error("[upload]", err);
    return Response.json({ error: "Upload failed" }, { status: 500 });
  }

  try {
    // A scan goes through the photo handler too, which dates it and files it on a trip — it just has no pixels to
    // render, so nothing is made from it.
    if (isVideo) await enqueue(QUEUES.transcodeVideo, { photoId: photo.id, tripId: tripId ?? null });
    else await enqueue(QUEUES.processPhoto, { photoId: photo.id, tripId: tripId ?? null });
  } catch (err) {
    console.error("[upload] could not queue processing", err);
    await db.photo.update({ where: { id: photo.id }, data: { status: "FAILED", error: "Could not queue processing; use Re-process on the photo page." } }).catch(() => {});
    return Response.json({ error: "Upload stored but processing could not be queued" }, { status: 500 });
  }
  return Response.json({ photoId: photo.id });
}

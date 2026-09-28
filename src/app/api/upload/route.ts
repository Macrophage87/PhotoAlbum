import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { storage, StorageLimitError } from "@/lib/storage";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { fileExisting } from "@/lib/photos/file-existing";
import { decodeHeaderName } from "@/lib/media/header-name";
import { uploaderLabel } from "@/components/photos/toGrid";
import { ALLOWED_MIMES as ALLOWED, EXT_BY_MIME, isGlbHeader, kindForMime, scanFormatOf, VIDEO_MIMES as VIDEO } from "@/lib/media/mime";
import { claimContentHash } from "@/lib/media/content-hash";
import { mimeAsSent } from "@/lib/media/picker";
import { EMPTY_FILE_MESSAGE, maxUploadBytes } from "@/lib/media/limits";
import { uploadByteLimits } from "@/lib/media/upload-limits";
import { processAgainIfStuck } from "@/lib/media/requeue";
import { isResend } from "@/lib/media/resend";

export const dynamic = "force-dynamic";

const headerSchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().optional(),
  tripId: z.string().optional(),
  activityId: z.string().optional(),
  collectionId: z.string().optional(),
  lastModified: z.coerce.number().optional(),
  annotationOptOut: z.string().optional(),
  attempt: z.coerce.number().int().positive().optional(),
});

/** The album looked at what arrived and will not keep it; the reason is the member's to read. */
class Refused extends Error {}

/** The first `n` bytes of a stored file. */
async function headOf(key: string, n: number): Promise<Buffer> {
  const { stream } = await storage().getStream(key, { start: 0, end: n - 1 });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Streams one file to storage and queues processing. Body is the raw file; metadata rides in headers. */
export async function POST(request: Request) {
  const viewer = await getViewer();
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  // A zero-byte file may arrive with no body at all.
  if (!request.body) return Response.json({ error: EMPTY_FILE_MESSAGE }, { status: 422 });

  const parsed = headerSchema.safeParse({
    // A name that will not decode fails the schema, and so is a bad request rather than a crash.
    fileName: decodeHeaderName(request.headers.get("x-file-name")) ?? "",
    contentType: request.headers.get("content-type") ?? undefined,
    tripId: request.headers.get("x-trip-id") ?? undefined,
    activityId: request.headers.get("x-activity-id") ?? undefined,
    collectionId: request.headers.get("x-collection-id") ?? undefined,
    lastModified: request.headers.get("x-last-modified") ?? undefined,
    annotationOptOut: request.headers.get("x-annotation-opt-out") ?? undefined,
    attempt: request.headers.get("x-upload-attempt") ?? undefined,
  });
  if (!parsed.success) return Response.json({ error: "Bad upload headers" }, { status: 400 });
  const { fileName, lastModified } = parsed.data;
  let tripId = parsed.data.tripId;

  const mime = mimeAsSent({ name: fileName, type: parsed.data.contentType ?? "" }) ?? "";
  if (!ALLOWED.has(mime)) return Response.json({ error: `Unsupported file type: ${fileName}` }, { status: 415 });

  if (tripId) {
    const trip = await db.trip.findUnique({ where: { id: tripId, deletingAt: null }, select: { id: true } });
    if (!trip) return Response.json({ error: "Trip not found" }, { status: 404 });
  }
  // Uploading into an activity says both where it belongs and which trip it is on, whatever its own date turns out
  // to be — a scan of a photograph from the walk belongs on the walk.
  const activityId = parsed.data.activityId;
  if (activityId) {
    const activity = await db.activity.findUnique({ where: { id: activityId, trip: { deletingAt: null } }, select: { id: true, tripId: true } });
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
  try {
    // The request's own signal goes with the body, so a client that goes away mid-file ends the pipeline (and this
    // handler) instead of leaving it waiting for bytes that will never come.
    const body = Readable.fromWeb(request.body as never, { signal: request.signal });
    const { bytes } = await storage().putStream(originalPath, body, { maxBytes: maxUploadBytes(mime, uploadByteLimits()), onChunk: (chunk) => digest.update(chunk) });
    // Before it takes a hash: every empty file is the same file, and would be answered as one the album already has.
    if (bytes === 0) throw new Refused(EMPTY_FILE_MESSAGE);
    if (mime === "model/gltf-binary" && !isGlbHeader(await headOf(originalPath, 12), bytes)) throw new Refused("This .glb file is not a 3D model the album can read. Export it from the scanning app again and upload that.");
    const contentHash = digest.digest("hex");
    const match = await claimContentHash(photo.id, contentHash, { storageKey, originalPath, sizeBytes: bytes });
    if (match) {
      const already = await db.photo.findUniqueOrThrow({
        where: { id: match.id },
        select: { id: true, kind: true, tripId: true, status: true, originalPath: true, updatedAt: true, originalName: true, uploaderId: true, createdAt: true, trip: { select: { slug: true, title: true } }, uploader: { select: { name: true, email: true } } },
      });
      // Nothing is kept: neither the bytes just written nor the row that was waiting for them. The member is told
      // which one the album already has, so "it did not appear" is never the impression left behind. Sent to a
      // particular trip, activity or collection, the one the album has is put there instead of a second copy.
      await storage().deletePrefix(storageKey).catch(() => undefined);
      await db.photo.delete({ where: { id: photo.id } }).catch(() => {});
      // The one the album has never became a picture (or its job was lost): sending it again is the moment to try.
      // Before filing it, which changes it, so the check sees it as it was read.
      const status = (await processAgainIfStuck(already)) ? "PENDING" : already.status;
      const filed = await fileExisting(viewer.user, already.id, { tripId: tripId ?? null, activityId: activityId ?? null, collectionId: collectionId ?? null });
      return Response.json({
        photoId: already.id,
        // A retry of this very file whose earlier answer was lost (the phone locked as it came back) finds the row that
        // earlier attempt made. That is their upload arriving, not something the album already had. The same file
        // chosen again is a first attempt, and is told the album has it.
        duplicate: !isResend(already, parsed.data.attempt ?? 1, viewer.user.id, fileName),
        // How far along it is, so one still being processed is watched until it is done rather than called ready.
        status,
        originalName: already.originalName,
        trip: already.trip ?? null,
        filed,
        // Whose it is, only when that is why it stayed put; members see who added what everywhere else too.
        owner: filed.notYours ? uploaderLabel(already.uploader.name, already.uploader.email) : null,
      });
    }
  } catch (err) {
    // The prefix is this row's own folder, so whatever reached it — the whole original, when a later step failed —
    // goes with the row.
    await storage().deletePrefix(storageKey).catch(() => undefined);
    await db.photo.delete({ where: { id: photo.id } }).catch(() => {});
    if (err instanceof StorageLimitError) return Response.json({ error: `File is larger than ${Math.round(err.maxBytes / 1048576)} MB` }, { status: 413 });
    if (err instanceof Refused) return Response.json({ error: err.message }, { status: 422 });
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error("[upload]", err);
    return Response.json({ error: "Upload failed" }, { status: 500 });
  }

  // From here the row has its hash, so another upload of the same bytes may already have been answered with it: it
  // is kept whatever goes wrong now, and says what did.
  if (collectionId) {
    await fileExisting(viewer.user, photo.id, { collectionId }).catch((err) => console.error("[upload] could not add to the collection", err));
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

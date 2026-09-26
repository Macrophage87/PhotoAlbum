import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getViewer } from "@/lib/auth/viewer";
import { canEditContainer } from "@/lib/auth/ownership";
import { decodeHeaderName } from "@/lib/media/header-name";
import { storage, StorageLimitError } from "@/lib/storage";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";

export const dynamic = "force-dynamic";

const headerSchema = z.object({
  fileName: z.string().min(1).max(255),
  tripId: z.string().min(1),
  sourceHint: z.enum(["auto", "gpx", "fit", "google"]).default("auto"),
});

/** Streams a GPX / FIT / Google JSON file to disk and queues the import job. */
export async function POST(request: Request) {
  const viewer = await getViewer();
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!request.body) return Response.json({ error: "Empty body" }, { status: 400 });
  const parsed = headerSchema.safeParse({
    // A name that will not decode fails the schema, and so is a bad request rather than a crash.
    fileName: decodeHeaderName(request.headers.get("x-file-name")) ?? "",
    tripId: request.headers.get("x-trip-id") ?? "",
    sourceHint: request.headers.get("x-source-hint") ?? "auto",
  });
  if (!parsed.success) return Response.json({ error: "Bad import headers" }, { status: 400 });
  const { tripId, sourceHint } = parsed.data;
  const trip = await db.trip.findUnique({ where: { id: tripId }, select: { id: true, createdById: true } });
  if (!trip) return Response.json({ error: "Trip not found" }, { status: 404 });
  // Each file becomes an activity and re-places the trip's photographs, so this is arranging the trip: its maker's
  // (and admins') to do, as the import page already says.
  if (!canEditContainer(viewer.user, trip)) return Response.json({ error: "Only the family member who made this trip, or an admin, can import tracks into it." }, { status: 403 });

  const ext = (parsed.data.fileName.toLowerCase().split(".").pop() ?? "bin").replace(/[^a-z0-9]/g, "") || "bin";
  const importKey = `imports/${randomUUID()}.${ext}`;
  try {
    // With the request's signal, so a client that goes away mid-file ends this instead of leaving it waiting.
    await storage().putStream(importKey, Readable.fromWeb(request.body as never, { signal: request.signal }), { maxBytes: env().MAX_IMPORT_BYTES });
  } catch (err) {
    await storage().delete(importKey).catch(() => {});
    if (err instanceof StorageLimitError) return Response.json({ error: `File is larger than ${Math.round(err.maxBytes / 1048576)} MB` }, { status: 413 });
    console.error("[import]", err);
    return Response.json({ error: "Upload failed" }, { status: 500 });
  }
  let jobId: string | null;
  try {
    jobId = await enqueue(QUEUES.importTrack, { importKey, tripId, userId: viewer.user.id, sourceHint, originalName: parsed.data.fileName }, { retryLimit: 0, expireInSeconds: 3600 });
  } catch (err) {
    // No job will ever read it, so it is not kept (it may be somebody's whole location history).
    await storage().delete(importKey).catch(() => {});
    console.error("[import] could not queue the import", err);
    return Response.json({ error: "The import could not be started" }, { status: 500 });
  }
  return Response.json({ jobId, importKey });
}

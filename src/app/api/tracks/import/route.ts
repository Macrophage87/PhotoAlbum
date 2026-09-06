import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getViewer } from "@/lib/auth/viewer";
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
    fileName: decodeURIComponent(request.headers.get("x-file-name") ?? ""),
    tripId: request.headers.get("x-trip-id") ?? "",
    sourceHint: request.headers.get("x-source-hint") ?? "auto",
  });
  if (!parsed.success) return Response.json({ error: "Bad import headers" }, { status: 400 });
  const { fileName, tripId, sourceHint } = parsed.data;
  const trip = await db.trip.findUnique({ where: { id: tripId }, select: { id: true } });
  if (!trip) return Response.json({ error: "Trip not found" }, { status: 404 });

  const ext = (fileName.toLowerCase().split(".").pop() ?? "bin").replace(/[^a-z0-9]/g, "") || "bin";
  const importKey = `imports/${randomUUID()}.${ext}`;
  try {
    await storage().putStream(importKey, Readable.fromWeb(request.body as never), { maxBytes: env().MAX_IMPORT_BYTES });
  } catch (err) {
    await storage().delete(importKey).catch(() => {});
    if (err instanceof StorageLimitError) return Response.json({ error: `File is larger than ${Math.round(err.maxBytes / 1048576)} MB` }, { status: 413 });
    console.error("[import]", err);
    return Response.json({ error: "Upload failed" }, { status: 500 });
  }
  const jobId = await enqueue(QUEUES.importTrack, { importKey, tripId, userId: viewer.user.id, sourceHint, originalName: fileName }, { retryLimit: 0, expireInSeconds: 3600 });
  return Response.json({ jobId, importKey });
}

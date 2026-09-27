import { z } from "zod";
import { getViewer } from "@/lib/auth/viewer";
import { isAdmin } from "@/lib/auth/ownership";
import { getBoss } from "@/lib/jobs/boss";
import { QUEUES, type ImportTrackJob } from "@/lib/jobs/queues";

/** pg-boss ids are UUIDs, and it throws on anything else rather than finding nothing. */
const jobIdSchema = z.uuid();

/** Poll endpoint for the importer. An import's summary is its importer's (and admins'): anyone else finds nothing. */
export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const viewer = await getViewer();
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = jobIdSchema.safeParse((await params).jobId);
  if (!parsed.success) return Response.json({ error: "Not found" }, { status: 404 });
  const boss = await getBoss();
  const job = await boss.getJobById(QUEUES.importTrack, parsed.data);
  if (!job) return Response.json({ error: "Not found" }, { status: 404 });
  const data = job.data as Partial<ImportTrackJob> | null;
  if (!isAdmin(viewer.user) && data?.userId !== viewer.user.id) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({
    state: job.state,
    summary: job.state === "completed" ? job.output : null,
    error: job.state === "failed" ? failureMessage(job.output) : null,
  });
}

/**
 * Why a failed import failed, from where pg-boss put it: an Error is stored as its own fields, anything else thrown
 * (a parser that rejects with a bare string) under `value`. A job pg-boss stopped for running too long says so in
 * pg-boss's words, which are put in the album's.
 */
function failureMessage(output: unknown): string {
  const o = output as { message?: unknown; value?: unknown } | null;
  const value = o?.value as { message?: unknown } | string | null | undefined;
  const message = typeof o?.message === "string" ? o.message : typeof value === "string" ? value : typeof value?.message === "string" ? value.message : null;
  if (!message?.trim()) return "Import failed";
  if (/^handler execution exceeded/.test(message)) return "The import took too long and was stopped.";
  return message;
}

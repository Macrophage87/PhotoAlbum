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
  const output = job.output as { message?: string } | null;
  return Response.json({
    state: job.state,
    summary: job.state === "completed" ? job.output : null,
    error: job.state === "failed" ? (output?.message ?? "Import failed") : null,
  });
}

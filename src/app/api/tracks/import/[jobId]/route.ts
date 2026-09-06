import { getViewer } from "@/lib/auth/viewer";
import { getBoss } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";

/** Poll endpoint for the importer. */
export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const viewer = await getViewer();
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await params;
  const boss = await getBoss();
  const job = await boss.getJobById(QUEUES.importTrack, jobId);
  if (!job) return Response.json({ error: "Not found" }, { status: 404 });
  const output = job.output as { message?: string } | null;
  return Response.json({
    state: job.state,
    summary: job.state === "completed" ? job.output : null,
    error: job.state === "failed" ? (output?.message ?? "Import failed") : null,
  });
}

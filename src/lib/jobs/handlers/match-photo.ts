import { db } from "@/lib/db";
import { proposeForPhoto } from "@/lib/people/matching";
import { faceGates } from "@/lib/people/gates";
import { enqueue } from "../boss";
import { QUEUES, type MatchPhotoJob } from "../queues";

/** Re-run proposals for a photo's open faces (after notes change, a date is confirmed, or someone's recognition is turned on). */
export async function matchPhoto(job: MatchPhotoJob): Promise<void> {
  await proposeForPhoto(job.photoId);
}

export async function enqueueMatch(photoIds: string[]): Promise<void> {
  const gates = await faceGates();
  if (!gates.active) return;
  for (const id of photoIds) await enqueue(QUEUES.matchPhoto, { photoId: id }, { singletonKey: `match:${id}`, singletonSeconds: 30 });
}

/** Every photo with an open face: run after a person's recognition is switched on. */
export async function enqueueMatchAllOpen(): Promise<number> {
  const rows = await db.face.findMany({ where: { status: "DETECTED" }, select: { photoId: true }, distinct: ["photoId"] });
  await enqueueMatch(rows.map((r) => r.photoId));
  return rows.length;
}

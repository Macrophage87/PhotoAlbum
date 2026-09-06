import type { ImportTrackJob } from "../queues";

/** Phase 3 fills this in: GPX/FIT/Google parsing, stats, activities. */
export async function importTrack(job: ImportTrackJob): Promise<unknown> {
  console.log("[import-track] not implemented yet", job.importKey);
  return { tracks: [], activities: [] };
}

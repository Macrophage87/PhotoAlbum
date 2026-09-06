import type { ProcessPhotoJob } from "../queues";

/** Phase 1 fills this in: EXIF, renditions, assignment. */
export async function processPhoto(job: ProcessPhotoJob): Promise<void> {
  console.log("[process-photo] not implemented yet", job.photoId);
}

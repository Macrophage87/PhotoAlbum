import { storage } from "@/lib/storage";
import type { DeletePhotoJob } from "../queues";

export async function deletePhoto(job: DeletePhotoJob): Promise<void> {
  await storage().deletePrefix(job.storageKey);
}

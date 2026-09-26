import { env } from "@/lib/env";
import type { UploadByteLimits } from "./limits";

/** The configured limits, read on the server and passed down to the uploader. */
export function uploadByteLimits(): UploadByteLimits {
  const e = env();
  return { photo: e.MAX_UPLOAD_BYTES, video: e.MAX_VIDEO_UPLOAD_BYTES, scan: e.MAX_SCAN_UPLOAD_BYTES };
}

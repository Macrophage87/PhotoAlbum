import { getApiViewer } from "@/lib/auth/viewer";
import { env } from "@/lib/env";
import { IMAGE_MIMES, VIDEO_MIMES } from "@/lib/media/mime";
import { uploadByteLimits } from "@/lib/media/upload-limits";

export const dynamic = "force-dynamic";

/**
 * Who the app is signed in as, and what the album will take from it. The limits are the server's own, so the app
 * can refuse a file that is too big or a clip that is too long before sending it, in step with what the upload and
 * the transcoder would say afterwards.
 */
export async function GET(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id, email, name, role } = viewer.user;
  const bytes = uploadByteLimits();
  return Response.json({
    user: { id, email, name, role },
    limits: {
      photoBytes: bytes.photo,
      videoBytes: bytes.video,
      clipSeconds: env().MAX_CLIP_SECONDS,
      imageTypes: [...IMAGE_MIMES],
      videoTypes: [...VIDEO_MIMES],
    },
  });
}

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getApiViewer } from "@/lib/auth/viewer";
import { addYouTube } from "@/lib/video/add-youtube";

export const dynamic = "force-dynamic";

const schema = z.object({
  url: z.string().trim().min(1).max(500),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tripId: z.string().min(1).max(100).nullish(),
});

/**
 * Adds a YouTube link from the app: what a member does with a video too big or too long to keep here, once they
 * have put it on YouTube. The same thing the website's form does, and the same words when it cannot be done.
 */
export async function POST(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Paste a YouTube link, and say which day the video is from." }, { status: 400 });
  const added = await addYouTube(viewer.user.id, { url: parsed.data.url, date: parsed.data.date, tripId: parsed.data.tripId ?? null });
  if (added.status === "error") return Response.json({ error: added.message }, { status: 422 });
  revalidatePath("/", "layout");
  return Response.json({ photoId: added.photoId, title: added.title });
}

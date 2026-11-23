import { getApiViewer } from "@/lib/auth/viewer";
import { onThisDay, parseCalendarDay } from "@/lib/photos/on-this-day";
import { photoUrl } from "@/lib/photos/urls";

export const dynamic = "force-dynamic";

/** The website's "On this day" for the app: photos from this day in earlier years, for the phone's own date. */
export async function GET(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const today = parseCalendarDay(new URL(request.url).searchParams.get("date"));
  if (!today) return Response.json({ error: "Give the date as YYYY-MM-DD" }, { status: 400 });
  const photos = await onThisDay(viewer, today);
  return Response.json({
    photos: photos.map((p) => ({ id: p.id, year: p.year, title: p.title, caption: p.caption, trip: p.tripSlug ? { slug: p.tripSlug, title: p.tripTitle } : null, width: p.width, height: p.height, thumb: photoUrl(p, "thumb"), medium: photoUrl(p, "medium"), page: `/photos/${p.id}` })),
  });
}

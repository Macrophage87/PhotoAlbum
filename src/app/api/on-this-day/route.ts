import { getViewer } from "@/lib/auth/viewer";
import { onThisDay, parseCalendarDay } from "@/lib/photos/on-this-day";
import { photoUrl } from "@/lib/photos/urls";

export const dynamic = "force-dynamic";

/**
 * The front page's "On this day": photographs from this day of the year in earlier years. Asked with the date the
 * viewer's own browser reads (`?date=2026-11-23`), because only it knows which day it is where they are sitting.
 */
export async function GET(request: Request) {
  const today = parseCalendarDay(new URL(request.url).searchParams.get("date"));
  if (!today) return Response.json({ error: "Give the date as YYYY-MM-DD" }, { status: 400 });
  const viewer = await getViewer();
  const photos = await onThisDay(viewer, today);
  return Response.json(
    {
      photos: photos.map((p) => ({
        id: p.id,
        year: p.year,
        title: p.title,
        caption: p.caption,
        trip: p.tripSlug ? { slug: p.tripSlug, title: p.tripTitle } : null,
        width: p.width,
        height: p.height,
        thumb: photoUrl(p, "thumb"),
      })),
    },
    // What it says depends on who is asking, and changes when a photo is added or hearted.
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

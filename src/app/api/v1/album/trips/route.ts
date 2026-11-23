import { getApiViewer } from "@/lib/auth/viewer";
import { coverFor, countVisibleTrips, listVisibleTrips } from "@/lib/trips/queries";
import { APP_PAGE, pageOffset, toAppTrip } from "@/lib/app-api/album";

export const dynamic = "force-dynamic";

/** The album's trips for the app's browsing screen, newest first, a page at a time (`?from=100` for the next). */
export async function GET(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const from = pageOffset(new URL(request.url).searchParams.get("from"));
  const [trips, total] = await Promise.all([listVisibleTrips(viewer, { take: APP_PAGE, skip: from, order: "newest" }), countVisibleTrips(viewer)]);
  const covers = await Promise.all(trips.map((t) => coverFor(t)));
  return Response.json({
    trips: trips.map((t, i) => toAppTrip(t, covers[i])),
    total,
    next: from + trips.length < total ? from + trips.length : null,
  });
}

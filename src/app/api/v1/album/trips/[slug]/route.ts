import { getApiViewer } from "@/lib/auth/viewer";
import { coverFor, tripCardSelect } from "@/lib/trips/queries";
import { tripPhotoPage } from "@/lib/photos/page";
import { db } from "@/lib/db";
import { APP_PAGE, toAppItem, toAppTrip } from "@/lib/app-api/album";

export const dynamic = "force-dynamic";

/**
 * One trip for the app: what it is, and its finished items in the order the trip happened, a page at a time. The
 * next page is asked for with the `next` this one gave (`?cursor=…`).
 */
export async function GET(request: Request, { params }: RouteContext<"/api/v1/album/trips/[slug]">) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { slug } = await params;
  const trip = await db.trip.findUnique({ where: { slug, deletingAt: null }, select: tripCardSelect });
  if (!trip) return Response.json({ error: "Not found" }, { status: 404 });
  const cursor = new URL(request.url).searchParams.get("cursor");
  const page = await tripPhotoPage(trip.id, { cursor, take: APP_PAGE, order: "taken", readyOnly: true });
  return Response.json({
    trip: toAppTrip(trip, await coverFor(trip)),
    items: page.photos.map(toAppItem),
    total: page.total,
    next: page.nextCursor,
  });
}

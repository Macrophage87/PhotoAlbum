import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canViewActivity, canViewTrip } from "@/lib/auth/access";
import { buildActivityMapPayload } from "@/lib/map/geojson";

/**
 * One activity's route and its own photographs, for its page on the trip and for whoever holds the activity's link.
 * The link opens this and nothing else: no other activity, none of the trip's other photographs, and the trip itself
 * is named only to a viewer who may open it.
 */
export async function GET(_req: Request, { params }: RouteContext<"/api/activities/[id]/geojson">) {
  const { id } = await params;
  const viewer = await getViewer();
  const activity = await db.activity.findUnique({ where: { id }, select: { id: true, shareToken: true, trip: { select: { id: true, visibility: true, shareToken: true } } } });
  if (!activity) return Response.json({ error: "Not found" }, { status: 404 });
  const tripOpen = canViewTrip(viewer, activity.trip);
  if (!tripOpen && !canViewActivity(viewer, activity)) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(await buildActivityMapPayload(viewer, activity.id, tripOpen), { headers: { "Cache-Control": "private, no-store" } });
}

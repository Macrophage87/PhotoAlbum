import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { visibleContainersWhere } from "@/lib/auth/access";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { localDayInZone } from "@/lib/time/local-day";

export const dynamic = "force-dynamic";

/** One page of a search. Small on purpose: a picker shows a shortlist, it does not show the library. */
export const PAGE = 20;

export type ContainerHit = { id: string; slug: string; title: string; visibility: string; items: number; when: string | null };

/**
 * Trips, collections and one trip's activities by name, for the pickers. A family that has been doing this for years has hundreds of both,
 * which is more than any dropdown should ever hold: the picker asks here as someone types and shows a shortlist,
 * and with no query it answers with the most recent, which is what people reach for most of the time.
 */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const asked = url.searchParams.get("kind");
  const kind = asked === "collection" || asked === "activity" ? asked : "trip";
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const where = q ? { title: { contains: q, mode: "insensitive" as const } } : {};

  // Activities belong to one trip, so the picker for them only makes sense with that trip named.
  if (kind === "activity") {
    const tripId = url.searchParams.get("trip") ?? "";
    const trip = tripId ? await db.trip.findFirst({ where: { id: tripId, ...visibleContainersWhere(viewer) }, select: { id: true, slug: true, timezone: true } }) : null;
    if (!trip) return Response.json({ hits: [] }, { headers: { "Cache-Control": "private, no-store" } });
    const activities = await db.activity.findMany({
      where: { tripId: trip.id, ...where },
      orderBy: { startTime: "asc" },
      take: PAGE,
      select: { id: true, title: true, startTime: true, _count: { select: { photos: { where: NOT_TRASHED } } } },
    });
    const hits: ContainerHit[] = activities.map((a) => ({ id: a.id, slug: trip.slug, title: a.title, visibility: "", items: a._count.photos, when: localDayInZone(a.startTime, trip.timezone) }));
    return Response.json({ hits }, { headers: { "Cache-Control": "private, no-store" } });
  }

  if (kind === "trip") {
    const trips = await db.trip.findMany({
      where: { ...visibleContainersWhere(viewer), ...where },
      orderBy: { startDate: "desc" },
      take: PAGE,
      select: { id: true, slug: true, title: true, visibility: true, startDate: true, _count: { select: { photos: { where: NOT_TRASHED } } } },
    });
    const hits: ContainerHit[] = trips.map((t) => ({ id: t.id, slug: t.slug, title: t.title, visibility: t.visibility, items: t._count.photos, when: t.startDate.toISOString().slice(0, 10) }));
    return Response.json({ hits }, { headers: { "Cache-Control": "private, no-store" } });
  }

  const collections = await db.collection.findMany({
    where: { ...visibleContainersWhere(viewer), ...where },
    orderBy: { createdAt: "desc" },
    take: PAGE,
    select: { id: true, slug: true, title: true, visibility: true, createdAt: true, _count: { select: { items: { where: { photo: NOT_TRASHED } } } } },
  });
  const hits: ContainerHit[] = collections.map((c) => ({ id: c.id, slug: c.slug, title: c.title, visibility: c.visibility, items: c._count.items, when: null }));
  return Response.json({ hits }, { headers: { "Cache-Control": "private, no-store" } });
}

import { db } from "@/lib/db";
import { getApiViewer } from "@/lib/auth/viewer";

export const dynamic = "force-dynamic";

/** A trip's day as it is written on a calendar; the column holds a date with no time of day. */
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The trips a member can send photos to, newest first: the same list the website's upload page offers. The app
 * shows it so that what is sent can be put on a trip by name; left unchosen, the album files each by its date.
 */
export async function GET(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const trips = await db.trip.findMany({
    where: { deletingAt: null },
    orderBy: [{ startDate: "desc" }, { id: "asc" }],
    select: { id: true, slug: true, title: true, startDate: true, endDate: true },
  });
  return Response.json({ trips: trips.map((t) => ({ id: t.id, slug: t.slug, title: t.title, startDate: day(t.startDate), endDate: day(t.endDate) })) });
}

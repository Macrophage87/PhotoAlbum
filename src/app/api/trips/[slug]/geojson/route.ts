import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canViewTrip, viewerFor } from "@/lib/auth/access";
import { buildMapPayload } from "@/lib/map/geojson";
import { parseGalleryFilter } from "@/lib/photos/filters";
import { searchParamsObject } from "@/lib/search-params";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const sp = new URL(req.url).searchParams;
  const viewer = await getViewer();
  const trip = await db.trip.findUnique({ where: { slug }, select: { id: true, visibility: true, shareToken: true } });
  if (!trip || !canViewTrip(viewer, trip)) return Response.json({ error: "Not found" }, { status: 404 });
  // A shared link's map is drawn as anybody holding the link sees it, a member looking at it included.
  const answer = viewerFor(viewer, sp.get("view"));
  const filter = parseGalleryFilter(searchParamsObject(sp), { member: answer.kind === "user", inTrip: true });
  return Response.json(await buildMapPayload(answer, trip.id, filter), { headers: { "Cache-Control": "private, no-store" } });
}

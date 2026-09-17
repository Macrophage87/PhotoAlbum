import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canViewTrip } from "@/lib/auth/access";
import { buildMapPayload } from "@/lib/map/geojson";
import { parseGalleryFilter } from "@/lib/photos/filters";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const viewer = await getViewer();
  const trip = await db.trip.findUnique({ where: { slug }, select: { id: true, visibility: true, shareToken: true } });
  if (!trip || !canViewTrip(viewer, trip)) return Response.json({ error: "Not found" }, { status: 404 });
  const filter = parseGalleryFilter(Object.fromEntries(new URL(req.url).searchParams), { member: viewer.kind === "user" });
  return Response.json(await buildMapPayload(viewer, trip.id, filter), { headers: { "Cache-Control": "private, no-store" } });
}

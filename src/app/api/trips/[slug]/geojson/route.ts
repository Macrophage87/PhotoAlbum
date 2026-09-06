import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canViewTrip } from "@/lib/auth/access";
import { buildMapPayload } from "@/lib/map/geojson";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const viewer = await getViewer();
  const trip = await db.trip.findUnique({ where: { slug }, select: { id: true, visibility: true, shareToken: true } });
  if (!trip || !canViewTrip(viewer, trip)) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(await buildMapPayload(viewer, trip.id), { headers: { "Cache-Control": "private, no-store" } });
}

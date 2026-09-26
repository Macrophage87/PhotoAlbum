import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canViewTrip } from "@/lib/auth/access";
import { tripPhotoPage } from "@/lib/photos/page";
import { toGridPhoto } from "@/components/photos/toGrid";
import { parseGalleryFilter } from "@/lib/photos/filters";

/** The next page of a trip gallery, under the same visibility rule as the page itself; uploader names for members only. */
export async function GET(request: NextRequest, { params }: RouteContext<"/api/trips/[slug]/photos">) {
  const { slug } = await params;
  const viewer = await getViewer();
  const trip = await db.trip.findUnique({ where: { slug }, select: { id: true, visibility: true, shareToken: true } });
  if (!trip || !canViewTrip(viewer, trip)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const member = viewer.kind === "user";
  const sp = request.nextUrl.searchParams;
  // The next page of a narrowed gallery is the next page of that same narrowing, read the same way the page reads it.
  const filter = parseGalleryFilter(Object.fromEntries(sp.entries()), { member });
  // The same order the page was built in, or the next page would continue a different list.
  const asked = sp.get("order");
  const order = asked === "oldest" ? "taken" : asked === "newest" ? "newest" : "favorites";
  const page = await tripPhotoPage(trip.id, { cursor: sp.get("cursor"), filter, order, viewerId: member ? viewer.user.id : null });
  return NextResponse.json({ photos: page.photos.map((p) => toGridPhoto(p, null, member)), nextCursor: page.nextCursor, total: page.total }, { headers: { "Cache-Control": "private, no-store" } });
}

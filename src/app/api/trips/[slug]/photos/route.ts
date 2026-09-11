import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canViewTrip } from "@/lib/auth/access";
import { tripPhotoPage } from "@/lib/photos/page";
import { toGridPhoto } from "@/components/photos/toGrid";

/** The next page of a trip gallery, under the same visibility rule as the page itself; uploader names for members only. */
export async function GET(request: NextRequest, { params }: RouteContext<"/api/trips/[slug]/photos">) {
  const { slug } = await params;
  const viewer = await getViewer();
  const trip = await db.trip.findUnique({ where: { slug }, select: { id: true, visibility: true, shareToken: true } });
  if (!trip || !canViewTrip(viewer, trip)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const member = viewer.kind === "user";
  const sp = request.nextUrl.searchParams;
  const page = await tripPhotoPage(trip.id, { cursor: sp.get("cursor"), uploaderId: member ? sp.get("uploader") || undefined : undefined });
  return NextResponse.json({ photos: page.photos.map((p) => toGridPhoto(p, null, member)), nextCursor: page.nextCursor, total: page.total }, { headers: { "Cache-Control": "private, no-store" } });
}

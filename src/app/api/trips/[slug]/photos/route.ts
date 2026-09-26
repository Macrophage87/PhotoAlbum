import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canViewTrip } from "@/lib/auth/access";
import { tripPhotoPage, type PhotoOrder } from "@/lib/photos/page";
import { toGridPhoto } from "@/components/photos/toGrid";
import { parseGalleryFilter } from "@/lib/photos/filters";
import { photoFavourites } from "@/lib/favourites/queries";

/** How many photos one re-read may name: short enough for an address. The gallery asks in pieces this size. */
const REREAD_MAX = 200;

/** The next page of a trip gallery, under the same visibility rule as the page itself; uploader names for members only. */
export async function GET(request: NextRequest, { params }: RouteContext<"/api/trips/[slug]/photos">) {
  const { slug } = await params;
  const viewer = await getViewer();
  const trip = await db.trip.findUnique({ where: { slug }, select: { id: true, visibility: true, shareToken: true } });
  if (!trip || !canViewTrip(viewer, trip)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const sp = request.nextUrl.searchParams;
  // A share page draws its first page as any visitor sees it, members included; its later pages must match.
  const member = viewer.kind === "user" && sp.get("view") !== "share";
  // The next page of a narrowed gallery is the next page of that same narrowing, read the same way the page reads it.
  const filter = parseGalleryFilter(Object.fromEntries(sp.entries()), { member });
  // The same order the page was built in, or the next page would continue a different list.
  const asked = sp.get("order");
  const order: PhotoOrder = asked === "oldest" ? "taken" : asked === "newest" ? "newest" : "favorites";
  // `ids` re-reads photos the gallery already shows, after an action changed them, under the same rules and filter.
  const ids = sp.get("ids")?.split(",").filter(Boolean).slice(0, REREAD_MAX);
  const viewerId = member && viewer.kind === "user" ? viewer.user.id : null;
  // A visitor's gallery (and a share page's, whoever is looking) shows only finished items, as its first page does;
  // their words never match names.
  const common = { filter, order, viewerId, member, readyOnly: !member };
  const page = await tripPhotoPage(trip.id, ids ? { ...common, ids, take: Math.max(ids.length, 1) } : { ...common, cursor: sp.get("cursor") });
  // Hearts as the page draws them, so a tile from a later page has one too.
  const favourites = member ? await photoFavourites(page.photos.map((p) => p.id), viewer) : new Map();
  return NextResponse.json({ photos: page.photos.map((p) => toGridPhoto(p, null, member, favourites.get(p.id))), nextCursor: ids ? null : page.nextCursor, total: page.total }, { headers: { "Cache-Control": "private, no-store" } });
}

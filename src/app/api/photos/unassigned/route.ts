import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth/viewer";
import { unassignedPhotoPage } from "@/lib/photos/queries";
import { toGridPhoto } from "@/components/photos/toGrid";
import { parseGalleryFilter } from "@/lib/photos/filters";
import { searchParamsObject } from "@/lib/search-params";

/** How many photos one re-read may name: short enough for an address. The gallery asks in pieces this size. */
const REREAD_MAX = 200;

/** The next page of the photos on no trip, members only like the page itself, narrowed the same way the page is. */
export async function GET(request: NextRequest) {
  const viewer = await getViewer();
  if (viewer.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sp = request.nextUrl.searchParams;
  const filter = parseGalleryFilter(searchParamsObject(sp), { member: true });
  // `ids` re-reads photos the gallery already shows, after an action changed them (filed onto a trip, say), under the
  // same filter; without it the answer would be the first page, and every photo held from a later one would drop out.
  const ids = sp.get("ids")?.split(",").filter(Boolean).slice(0, REREAD_MAX);
  const page = await unassignedPhotoPage(filter, ids ? { ids, take: Math.max(ids.length, 1) } : { cursor: sp.get("cursor") });
  return NextResponse.json({ photos: page.photos.map((p) => toGridPhoto(p, null, viewer.user)), nextCursor: ids ? null : page.nextCursor, total: page.matched }, { headers: { "Cache-Control": "private, no-store" } });
}

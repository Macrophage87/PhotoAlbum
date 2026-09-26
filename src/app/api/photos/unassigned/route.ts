import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth/viewer";
import { unassignedPhotoPage } from "@/lib/photos/queries";
import { toGridPhoto } from "@/components/photos/toGrid";
import { parseGalleryFilter } from "@/lib/photos/filters";
import { searchParamsObject } from "@/lib/search-params";

/** The next page of the photos on no trip, members only like the page itself, narrowed the same way the page is. */
export async function GET(request: NextRequest) {
  const viewer = await getViewer();
  if (viewer.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sp = request.nextUrl.searchParams;
  const filter = parseGalleryFilter(searchParamsObject(sp), { member: true });
  const page = await unassignedPhotoPage(filter, { cursor: sp.get("cursor") });
  return NextResponse.json({ photos: page.photos.map((p) => toGridPhoto(p, null, true)), nextCursor: page.nextCursor, total: page.matched }, { headers: { "Cache-Control": "private, no-store" } });
}

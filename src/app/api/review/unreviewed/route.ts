import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth/viewer";
import { photoCardSelect } from "@/lib/photos/queries";
import { toGridPhoto } from "@/components/photos/toGrid";
import { unreviewedPage } from "@/lib/review/queue";

/** How many items one re-read may name, as the gallery asks (see LoadMore). */
const REREAD_MAX = 200;

/** The next page of the viewer's Unreviewed queue, for the review screen's grid; members only, like the page. */
export async function GET(request: NextRequest) {
  const viewer = await getViewer();
  if (viewer.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sp = request.nextUrl.searchParams;
  const ids = sp.get("ids")?.split(",").filter(Boolean).slice(0, REREAD_MAX);
  const page = await unreviewedPage(viewer.user, photoCardSelect, ids ? { ids, take: Math.max(ids.length, 1) } : { cursor: sp.get("cursor") });
  return NextResponse.json({ photos: page.photos.map((p) => toGridPhoto(p, "unreviewed", viewer.user)), nextCursor: ids ? null : page.nextCursor }, { headers: { "Cache-Control": "private, no-store" } });
}

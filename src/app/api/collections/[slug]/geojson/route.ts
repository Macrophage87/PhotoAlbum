import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canViewCollection, viewerFor } from "@/lib/auth/access";
import { buildCollectionMapPayload } from "@/lib/map/geojson";
import { parseGalleryFilter } from "@/lib/photos/filters";
import { searchParamsObject } from "@/lib/search-params";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const sp = new URL(req.url).searchParams;
  const viewer = await getViewer();
  const collection = await db.collection.findUnique({ where: { slug }, select: { id: true, visibility: true, shareToken: true } });
  if (!collection || !canViewCollection(viewer, collection)) return Response.json({ error: "Not found" }, { status: 404 });
  // A shared link's map is drawn as anybody holding the link sees it, a member looking at it included.
  const answer = viewerFor(viewer, sp.get("view"));
  const filter = parseGalleryFilter(searchParamsObject(sp), { member: answer.kind === "user" });
  return Response.json(await buildCollectionMapPayload(answer, collection.id, filter), { headers: { "Cache-Control": "private, no-store" } });
}

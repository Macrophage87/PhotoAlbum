import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canViewCollection, viewerFor } from "@/lib/auth/access";
import { buildCollectionMapPayload, buildCollectionMapView } from "@/lib/map/geojson";
import { parseViewport } from "@/lib/map/view";
import { parseGalleryFilter } from "@/lib/photos/filters";
import { searchParamsObject } from "@/lib/search-params";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const sp = new URL(req.url).searchParams;
  const view = parseViewport(sp);
  if (view === "bad") return Response.json({ error: "Bad request" }, { status: 400 });
  const viewer = await getViewer();
  const collection = await db.collection.findUnique({ where: { slug }, select: { id: true, visibility: true, shareToken: true } });
  if (!collection || !canViewCollection(viewer, collection)) return Response.json({ error: "Not found" }, { status: 404 });
  // A shared link's map is drawn as anybody holding the link sees it, a member looking at it included.
  const answer = viewerFor(viewer, sp.get("view"));
  const filter = parseGalleryFilter(searchParamsObject(sp), { member: answer.kind === "user" });
  // With a view, only the photographs in it: the rest of the map was sent when it opened.
  // `fresh=1` is a member's (the placing screen's): nobody else may make the server work a map out again at will.
  const ask = { fresh: viewer.kind === "user" && sp.get("fresh") === "1" };
  const body = view ? await buildCollectionMapView(answer, collection.id, filter, view, ask) : await buildCollectionMapPayload(answer, collection.id, filter, ask);
  return Response.json(body, { headers: { "Cache-Control": "private, no-store" } });
}

import { getViewer } from "@/lib/auth/viewer";
import { buildMapPayload, buildMapView } from "@/lib/map/geojson";
import { parseViewport } from "@/lib/map/view";
import { parseGalleryFilter } from "@/lib/photos/filters";
import { searchParamsObject } from "@/lib/search-params";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const view = parseViewport(sp);
  if (view === "bad") return Response.json({ error: "Bad request" }, { status: 400 });
  const viewer = await getViewer();
  const filter = parseGalleryFilter(searchParamsObject(sp), { member: viewer.kind === "user" });
  // With a view, only the photographs in it: the rest of the map was sent when it opened.
  const body = view ? await buildMapView(viewer, undefined, filter, view) : await buildMapPayload(viewer, undefined, filter);
  return Response.json(body, { headers: { "Cache-Control": "private, no-store" } });
}

import { getViewer } from "@/lib/auth/viewer";
import { buildMapPayload } from "@/lib/map/geojson";
import { parseGalleryFilter } from "@/lib/photos/filters";

export async function GET(req: Request) {
  const viewer = await getViewer();
  const filter = parseGalleryFilter(Object.fromEntries(new URL(req.url).searchParams), { member: viewer.kind === "user" });
  return Response.json(await buildMapPayload(viewer, undefined, filter), { headers: { "Cache-Control": "private, no-store" } });
}

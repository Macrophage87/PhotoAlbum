import { getViewer } from "@/lib/auth/viewer";
import { buildMapPayload } from "@/lib/map/geojson";

export async function GET() {
  const viewer = await getViewer();
  return Response.json(await buildMapPayload(viewer), { headers: { "Cache-Control": "private, no-store" } });
}

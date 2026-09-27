import { getViewer } from "@/lib/auth/viewer";
import { describeMapPhotos } from "@/lib/map/details";
import { MAX_DESCRIBED } from "@/lib/map/view";

/**
 * What a map shows of the photographs it was clicked on (`?ids=a,b,c`), which the pins themselves do not carry. Each
 * is described only to a viewer who may see it; the rest are simply not in the answer.
 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const ids = [...new Set((sp.get("ids") ?? "").split(",").filter(Boolean))];
  if (!ids.length || ids.length > MAX_DESCRIBED || ids.some((id) => id.length > 64)) return Response.json({ error: "Bad request" }, { status: 400 });
  const viewer = await getViewer();
  return Response.json({ photos: await describeMapPhotos(viewer, ids, sp.get("view")) }, { headers: { "Cache-Control": "private, no-store" } });
}

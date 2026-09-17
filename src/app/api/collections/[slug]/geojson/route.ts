import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canViewCollection } from "@/lib/auth/access";
import { buildCollectionMapPayload } from "@/lib/map/geojson";
import { parseGalleryFilter } from "@/lib/photos/filters";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const viewer = await getViewer();
  const collection = await db.collection.findUnique({ where: { slug }, select: { id: true, visibility: true, shareToken: true } });
  if (!collection || !canViewCollection(viewer, collection)) return Response.json({ error: "Not found" }, { status: 404 });
  const filter = parseGalleryFilter(Object.fromEntries(new URL(req.url).searchParams), { member: viewer.kind === "user" });
  return Response.json(await buildCollectionMapPayload(viewer, collection.id, filter), { headers: { "Cache-Control": "private, no-store" } });
}

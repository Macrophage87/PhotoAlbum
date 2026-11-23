import { getApiViewer } from "@/lib/auth/viewer";
import { collectionCardSelect, collectionCoverFor, defaultCollectionOrder, listCollectionItems } from "@/lib/collections/queries";
import { db } from "@/lib/db";
import { APP_PAGE, pageOffset, toAppCollection, toAppItem } from "@/lib/app-api/album";

export const dynamic = "force-dynamic";

/**
 * One collection for the app: what it is, and its finished items in the order the website shows them by default,
 * a page at a time (`?from=100` for the next).
 */
export async function GET(request: Request, { params }: RouteContext<"/api/v1/album/collections/[slug]">) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { slug } = await params;
  const collection = await db.collection.findUnique({ where: { slug }, select: { ...collectionCardSelect, arrangedAt: true } });
  if (!collection) return Response.json({ error: "Not found" }, { status: 404 });
  const from = pageOffset(new URL(request.url).searchParams.get("from"));
  const items = (await listCollectionItems(collection.id, { viewerId: viewer.user.id, order: defaultCollectionOrder(collection, true) })).filter((i) => i.status === "READY");
  const page = items.slice(from, from + APP_PAGE);
  return Response.json({
    collection: toAppCollection(collection, await collectionCoverFor(collection)),
    items: page.map(toAppItem),
    total: items.length,
    next: from + page.length < items.length ? from + page.length : null,
  });
}

import { getApiViewer } from "@/lib/auth/viewer";
import { collectionCoverFor, countVisibleCollections, listVisibleCollections } from "@/lib/collections/queries";
import { APP_PAGE, pageOffset, toAppCollection } from "@/lib/app-api/album";

export const dynamic = "force-dynamic";

/** The album's collections for the app's browsing screen, a page at a time (`?from=100` for the next). */
export async function GET(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const from = pageOffset(new URL(request.url).searchParams.get("from"));
  const [collections, total] = await Promise.all([listVisibleCollections(viewer, { take: APP_PAGE, skip: from }), countVisibleCollections(viewer)]);
  const covers = await Promise.all(collections.map((c) => collectionCoverFor(c)));
  return Response.json({
    collections: collections.map((c, i) => toAppCollection(c, covers[i])),
    total,
    next: from + collections.length < total ? from + collections.length : null,
  });
}

import Link from "next/link";
import { db } from "@/lib/db";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { photoCardSelect } from "@/lib/photos/queries";
import { AppShell, Container } from "@/components/layout/AppShell";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";
import { SelectionProvider } from "@/components/photos/selection";
import { ReviewPanel } from "@/components/review/ReviewPanel";

export const metadata = { title: "Review uploads" };

/**
 * The review screen: a batch just uploaded (`?ids=`), or everything not yet reviewed. Members add notes, attach
 * items to trips and collections, and mark the batch reviewed. Later phases add annotation, suggestions and naming here.
 */
export default async function ReviewPage({ searchParams }: PageProps<"/review">) {
  await requireUser("/review");
  const viewer = await getViewer();
  const sp = await searchParams;
  const ids = typeof sp.ids === "string" ? sp.ids.split(",").filter(Boolean).slice(0, 500) : [];
  const batch = ids.length > 0;
  const [photos, trips, collections, unreviewedCount] = await Promise.all([
    db.photo.findMany({ where: batch ? { id: { in: ids } } : { reviewedAt: null }, orderBy: { createdAt: "desc" }, select: { ...photoCardSelect, context: true, reviewedAt: true } }),
    db.trip.findMany({ orderBy: { startDate: "desc" }, select: { id: true, title: true } }),
    db.collection.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } }),
    db.photo.count({ where: { reviewedAt: null } }),
  ]);
  const allIds = photos.map((p) => p.id);
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-semibold">{batch ? "Review this upload" : "Unreviewed"}</h1>
            <p className="text-muted mt-1">
              {batch ? `${photos.length} item${photos.length === 1 ? "" : "s"} just uploaded. Add a note, file them, then mark them reviewed.` : `${unreviewedCount} item${unreviewedCount === 1 ? "" : "s"} nobody has reviewed yet.`}
              {batch && unreviewedCount > photos.length && (
                <>
                  {" "}
                  <Link href="/review" className="text-primary hover:underline">{unreviewedCount} unreviewed in all.</Link>
                </>
              )}
            </p>
          </div>
        </div>
        {photos.length === 0 ? (
          <p className="text-muted">Nothing to review.</p>
        ) : (
          <SelectionProvider trips={trips} collections={collections}>
            <ReviewPanel allIds={allIds} />
            <PhotoGrid photos={photos.map((p) => toGridPhoto(p, p.reviewedAt ? null : "unreviewed", true))} />
            <ul className="text-sm text-muted space-y-1">
              {photos.filter((p) => p.context).map((p) => (
                <li key={p.id} className="truncate">
                  <Link href={`/photos/${p.id}`} className="text-primary hover:underline">{p.caption ?? p.title ?? p.originalName}</Link>: {p.context}
                </li>
              ))}
            </ul>
          </SelectionProvider>
        )}
      </Container>
    </AppShell>
  );
}

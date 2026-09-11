import Link from "next/link";
import { db } from "@/lib/db";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { photoCardSelect } from "@/lib/photos/queries";
import { AppShell, Container } from "@/components/layout/AppShell";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";
import { SelectionProvider } from "@/components/photos/selection";
import { ReviewPanel } from "@/components/review/ReviewPanel";
import { annotationGates } from "@/lib/annotation/eligibility";
import { env } from "@/lib/env";
import { EstimatedDate } from "@/components/annotation/EstimatedDate";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { suggestionsFor } from "@/lib/suggest";
import { SuggestionList } from "@/components/suggest/SuggestionList";

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
  const gates = await annotationGates();
  const [photos, trips, collections, unreviewedCount] = await Promise.all([
    db.photo.findMany({ where: batch ? { id: { in: ids } } : { reviewedAt: null }, orderBy: { createdAt: "desc" }, select: { ...photoCardSelect, context: true, reviewedAt: true, annotation: true, annotationOptOut: true, annotatedAt: true, estimatedDate: true, estimatedDateConfidence: true, estimatedDateNote: true, takenAtSource: true, trip: { select: { annotationOptOut: true } } } }),
    db.trip.findMany({ orderBy: { startDate: "desc" }, select: { id: true, title: true } }),
    db.collection.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } }),
    db.photo.count({ where: { reviewedAt: null } }),
  ]);
  const allIds = photos.map((p) => p.id);
  const suggestions = await suggestionsFor(allIds);
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
            <ReviewPanel allIds={allIds} annotation={gates.active ? { quietMinutes: env().ANNOTATION_QUIET_MINUTES, pending: photos.filter((p) => !p.annotatedAt && !p.annotationOptOut && !p.trip?.annotationOptOut).length } : null} />
            <PhotoGrid photos={photos.map((p) => toGridPhoto(p, p.reviewedAt ? null : "unreviewed", true))} />
            {photos.some((p) => suggestions[p.id]?.length) && (
              <section className="space-y-3">
                <h2 className="font-display text-lg font-semibold">Where these might belong</h2>
                {photos.filter((p) => suggestions[p.id]?.length).map((p) => (
                  <SuggestionList key={p.id} photoId={p.id} label={p.caption ?? p.title ?? p.originalName} suggestions={suggestions[p.id]} />
                ))}
              </section>
            )}
            <ul className="text-sm space-y-2">
              {photos.filter((p) => p.context || p.annotation || p.annotationOptOut).map((p) => {
                const a = p.annotation as StoredAnnotation | null;
                return (
                  <li key={p.id} className="rounded-theme border border-border p-3 space-y-1">
                    <Link href={`/photos/${p.id}`} className="text-primary hover:underline font-medium">{a?.caption ?? p.caption ?? p.title ?? p.originalName}</Link>
                    {p.context && <p className="text-muted">Note: {p.context}</p>}
                    {a && <p>{a.description}{a.tags.length > 0 && <span className="text-muted"> · {a.tags.slice(0, 8).join(", ")}</span>}</p>}
                    {(p.annotationOptOut || p.trip?.annotationOptOut) && <p className="text-xs text-muted">Not sent to the AI helper.</p>}
                  </li>
                );
              })}
            </ul>
            {photos.some((p) => p.estimatedDate && p.estimatedDateNote) && (
              <section className="space-y-2">
                <h2 className="font-display text-lg font-semibold">Dates to confirm</h2>
                {photos.filter((p) => p.estimatedDate && p.estimatedDateNote).map((p) => (
                  <div key={p.id} className="rounded-theme border border-amber-200 bg-amber-50 p-3 text-amber-900">
                    <Link href={`/photos/${p.id}`} className="text-sm font-medium hover:underline">{p.caption ?? p.title ?? p.originalName}</Link>
                    <EstimatedDate photoId={p.id} estimatedDate={p.estimatedDate} confidence={p.estimatedDateConfidence} note={p.estimatedDateNote} compact />
                  </div>
                ))}
              </section>
            )}
          </SelectionProvider>
        )}
      </Container>
    </AppShell>
  );
}

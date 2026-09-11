import Link from "next/link";
import { db } from "@/lib/db";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { graphPayload, parseScope } from "@/lib/graph/query";
import { MIN_SCORE } from "@/lib/graph/neighbours";
import { mlConfigured } from "@/lib/ml/client";
import { AppShell, Container } from "@/components/layout/AppShell";
import { GraphViewDynamic } from "@/components/graph/GraphViewDynamic";

export const metadata = { title: "Similarity graph", robots: { index: false, follow: false } };

/** Members-only. Admins may view the whole library (capped); everyone may view a trip, collection or person they can see. */
export default async function GraphPage({ searchParams }: PageProps<"/graph">) {
  const user = await requireUser("/graph");
  const viewer = await getViewer();
  const sp = new URLSearchParams(Object.entries(await searchParams).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
  const scope = parseScope(sp);
  const isAdmin = user.role === "ADMIN";
  const [trips, collections, people] = await Promise.all([
    db.trip.findMany({ orderBy: { startDate: "desc" }, select: { slug: true, title: true } }),
    db.collection.findMany({ orderBy: { title: "asc" }, select: { slug: true, title: true } }),
    db.person.findMany({ where: { faces: { some: { status: "CONFIRMED" } } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const effective = scope.kind === "all" && !isAdmin ? (trips[0] ? ({ kind: "trip", slug: trips[0].slug } as const) : scope) : scope;
  const data = mlConfigured() ? await graphPayload(viewer, effective, MIN_SCORE) : null;
  const current = effective.kind === "all" ? "" : effective.kind === "trip" ? `trip=${effective.slug}` : effective.kind === "collection" ? `collection=${effective.slug}` : `person=${effective.id}`;
  return (
    <AppShell viewer={viewer}>
      <Container className="py-8 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-semibold">Similar photos</h1>
            <p className="text-muted mt-1">Items that look alike sit close together. Drag to pan, scroll to zoom, click a photo to open it.</p>
          </div>
          <form method="get" className="flex flex-wrap items-center gap-2 text-sm">
            <select name="scope" aria-label="Scope" defaultValue={current} className="h-9 rounded-theme border border-border bg-surface px-2" onChange={undefined}>
              {isAdmin && <option value="">Whole library</option>}
              {trips.map((t) => (
                <option key={t.slug} value={`trip=${t.slug}`}>Trip: {t.title}</option>
              ))}
              {collections.map((c) => (
                <option key={c.slug} value={`collection=${c.slug}`}>Collection: {c.title}</option>
              ))}
              {people.map((p) => (
                <option key={p.id} value={`person=${p.id}`}>Person: {p.name}</option>
              ))}
            </select>
            <ScopeSubmit />
          </form>
        </div>
        {!mlConfigured() ? (
          <p className="text-muted">The similarity graph needs the ML sidecar (set <code>ML_URL</code> and <code>ML_TOKEN</code>).</p>
        ) : !data ? (
          <p className="text-muted">Nothing to show for this scope.</p>
        ) : data.nodes.length === 0 ? (
          <p className="text-muted">No embedded items here yet. Embeddings are computed in the background after upload.</p>
        ) : (
          <GraphViewDynamic data={data} minScore={MIN_SCORE} />
        )}
        <p className="text-xs text-muted">Members only. Edges are shown only between items you can see. <Link href="/privacy" className="underline">Privacy</Link></p>
      </Container>
    </AppShell>
  );
}

function ScopeSubmit() {
  return <button type="submit" className="h-9 px-3 rounded-theme border border-border bg-surface text-sm hover:bg-surface-alt">Show</button>;
}

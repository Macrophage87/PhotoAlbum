import { getViewer, requireUser } from "@/lib/auth/viewer";
import { ScopedGraph } from "@/components/graph/ScopedGraph";

export const metadata = { title: "Similar photos", robots: { index: false, follow: false } };

/** Members only, even on a public trip: what the album thinks looks alike is not part of what a trip shows the world. */
export default async function TripGraphPage({ params }: PageProps<"/trips/[slug]/graph">) {
  const { slug } = await params;
  await requireUser(`/trips/${slug}/graph`);
  const viewer = await getViewer();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-semibold">Photographs that look alike</h1>
        <p className="text-muted mt-1">The ones that resemble each other sit together. Drag to pan, scroll to zoom, press one to open it.</p>
      </div>
      <ScopedGraph viewer={viewer} scope={{ kind: "trip", slug }} of="this trip" />
    </div>
  );
}

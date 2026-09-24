import Link from "next/link";
import { loadViewableCollection } from "@/lib/collections/access";
import { listCollectionItems } from "@/lib/collections/queries";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";
import { ButtonLink, Card } from "@/components/ui";
import { CollectionUploader } from "@/components/collections/CollectionUploader";
import { env } from "@/lib/env";
import { annotationGates } from "@/lib/annotation/eligibility";

export default async function CollectionOverviewPage({ params }: PageProps<"/collections/[slug]/overview">) {
  const { slug } = await params;
  const { collection, editable } = await loadViewableCollection(slug);
  const [items, gates] = await Promise.all([listCollectionItems(collection.id), editable ? annotationGates() : Promise.resolve(null)]);
  const upload = editable ? <CollectionUploader collectionId={collection.id} slug={slug} maxClipSeconds={env().MAX_CLIP_SECONDS} annotationActive={Boolean(gates?.active)} /> : null;
  const ready = items.filter((i) => i.status === "READY");
  const dated = ready.filter((i) => i.takenAt).map((i) => i.takenAt!.getTime());
  const span = dated.length ? `${new Date(Math.min(...dated)).getFullYear()}–${new Date(Math.max(...dated)).getFullYear()}` : null;
  const stats: [string, string][] = [
    ["Photos", String(ready.length)],
    ...(span ? ([["Years", span.split("–")[0] === span.split("–")[1] ? span.split("–")[0] : span]] as [string, string][]) : []),
  ];
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stats.map(([k, v]) => (
          <Card key={k} className="p-4">
            <div className="text-2xl font-semibold font-display">{v}</div>
            <div className="text-sm text-muted">{k}</div>
          </Card>
        ))}
      </div>
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-xl font-semibold">Photos</h2>
          <div className="flex gap-2">
            {editable && <ButtonLink href={`/collections/${slug}/add`} size="sm">Add existing photos</ButtonLink>}
            <Link href={`/collections/${slug}/photos`} className="text-sm text-primary underline-offset-2 hover:underline self-center">All photos →</Link>
          </div>
        </div>
        {/* Uploading here, not a trip away on the upload page: the button opens the uploader in place. */}
        {editable && ready.length > 0 && <div className="mb-3">{upload}</div>}
        {editable && ready.length === 0 ? (
          <Card className="p-5 space-y-2">
            <p className="font-medium">Nothing here yet.</p>
            <p className="text-sm text-muted">Pick photos that are already in the album, upload new ones, or open any photo and tick this collection.</p>
            <div className="flex flex-wrap gap-2 pt-1"><ButtonLink href={`/collections/${slug}/add`} size="sm">Add existing photos</ButtonLink>{upload}</div>
          </Card>
        ) : (
          <PhotoGrid photos={ready.slice(0, 12).map((p) => toGridPhoto(p, null, editable))} emptyMessage="Nothing here yet." />
        )}
      </section>
    </div>
  );
}

import Link from "next/link";
import { loadViewableCollection } from "@/lib/collections/access";
import { listCollectionItems } from "@/lib/collections/queries";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";
import { ButtonLink, Card } from "@/components/ui";

export default async function CollectionOverviewPage({ params }: PageProps<"/collections/[slug]">) {
  const { slug } = await params;
  const { collection, editable } = await loadViewableCollection(slug);
  const items = await listCollectionItems(collection.id);
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
            {editable && <ButtonLink href="/upload" size="sm">Upload</ButtonLink>}
            <Link href={`/collections/${slug}/photos`} className="text-sm text-primary underline-offset-2 hover:underline self-center">All photos →</Link>
          </div>
        </div>
        <PhotoGrid photos={ready.slice(0, 12).map((p) => toGridPhoto(p, null, editable))} showDetailLink={editable} emptyMessage={editable ? "Nothing here yet. Open a photo and tick this collection, or select photos in any gallery." : "Nothing here yet."} />
      </section>
    </div>
  );
}

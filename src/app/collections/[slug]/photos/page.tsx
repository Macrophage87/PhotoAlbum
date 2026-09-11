import { loadViewableCollection } from "@/lib/collections/access";
import { listCollectionItems } from "@/lib/collections/queries";
import { CollectionGallery } from "@/components/collections/CollectionGallery";
import { toGridPhoto } from "@/components/photos/toGrid";
import { db } from "@/lib/db";
import { YouTubeAddForm } from "@/components/videos/YouTubeAddForm";
import { ButtonLink } from "@/components/ui";

export default async function CollectionPhotosPage({ params, searchParams }: PageProps<"/collections/[slug]/photos">) {
  const { slug } = await params;
  const sp = await searchParams;
  const added = typeof sp.added === "string" ? Number(sp.added) : NaN;
  const { collection, editable } = await loadViewableCollection(slug, `/collections/${slug}/photos`);
  const [items, trips, collections] = await Promise.all([
    listCollectionItems(collection.id),
    editable ? db.trip.findMany({ orderBy: { startDate: "desc" }, select: { id: true, title: true } }) : Promise.resolve([]),
    editable ? db.collection.findMany({ where: { id: { not: collection.id } }, orderBy: { title: "asc" }, select: { id: true, title: true } }) : Promise.resolve([]),
  ]);
  const shown = editable ? items : items.filter((i) => i.status === "READY");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold">
          {shown.length} item{shown.length === 1 ? "" : "s"}
        </h2>
        {editable && <ButtonLink href={`/collections/${slug}/add`} size="sm">Add existing photos</ButtonLink>}
      </div>
      {Number.isFinite(added) && <p role="status" className="text-sm rounded-theme bg-emerald-50 border border-emerald-200 text-emerald-900 p-3">Added {added} photo{added === 1 ? "" : "s"} to this collection.</p>}
      {editable && <YouTubeAddForm collectionId={collection.id} defaultDate={new Date().toISOString().slice(0, 10)} />}
      <CollectionGallery collectionId={collection.id} slug={slug} photos={shown.map((p) => ({ ...toGridPhoto(p, null, editable), itemId: p.itemId }))} trips={trips} collections={collections} editable={editable} emptyMessage={editable ? "Nothing here yet. Use Add existing photos, open a photo and tick this collection, or select photos in any gallery." : "Nothing here yet."} />
    </div>
  );
}

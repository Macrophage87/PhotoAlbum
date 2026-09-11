import { loadViewableCollection } from "@/lib/collections/access";
import { listCollectionItems } from "@/lib/collections/queries";
import { CollectionGallery } from "@/components/collections/CollectionGallery";
import { toGridPhoto } from "@/components/photos/toGrid";
import { db } from "@/lib/db";

export default async function CollectionPhotosPage({ params }: PageProps<"/collections/[slug]/photos">) {
  const { slug } = await params;
  const { collection, editable } = await loadViewableCollection(slug, `/collections/${slug}/photos`);
  const [items, trips, collections] = await Promise.all([
    listCollectionItems(collection.id),
    editable ? db.trip.findMany({ orderBy: { startDate: "desc" }, select: { id: true, title: true } }) : Promise.resolve([]),
    editable ? db.collection.findMany({ where: { id: { not: collection.id } }, orderBy: { title: "asc" }, select: { id: true, title: true } }) : Promise.resolve([]),
  ]);
  const shown = editable ? items : items.filter((i) => i.status === "READY");
  return (
    <div className="space-y-4">
      <h2 className="font-display text-xl font-semibold">
        {shown.length} photo{shown.length === 1 ? "" : "s"}
      </h2>
      <CollectionGallery collectionId={collection.id} slug={slug} photos={shown.map((p) => ({ ...toGridPhoto(p, null, editable), itemId: p.itemId }))} trips={trips} collections={collections} editable={editable} emptyMessage={editable ? "Nothing here yet. Open a photo and tick this collection, or select photos in any gallery." : "Nothing here yet."} />
    </div>
  );
}

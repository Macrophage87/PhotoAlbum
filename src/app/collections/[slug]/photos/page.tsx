import { loadViewableCollection } from "@/lib/collections/access";
import { getViewer } from "@/lib/auth/viewer";
import { photoFavourites } from "@/lib/favourites/queries";
import { listCollectionItems } from "@/lib/collections/queries";
import { CollectionGallery } from "@/components/collections/CollectionGallery";
import { toGridPhoto } from "@/components/photos/toGrid";
import { YouTubeAddForm } from "@/components/videos/YouTubeAddForm";
import { ButtonLink } from "@/components/ui";
import { collectionSortChoice, SORT_COOKIES, type CollectionSort } from "@/lib/sort-choice";
import { SortToggle } from "@/components/ui/SortToggle";

export default async function CollectionPhotosPage({ params, searchParams }: PageProps<"/collections/[slug]/photos">) {
  const { slug } = await params;
  const sp = await searchParams;
  const added = typeof sp.added === "string" ? Number(sp.added) : NaN;
  const { collection, editable, owns } = await loadViewableCollection(slug, `/collections/${slug}/photos`);
  const viewer = await getViewer();
  const arranged = Boolean(collection.arrangedAt);
  const sort = await collectionSortChoice(sp, arranged, editable);
  const items = await listCollectionItems(collection.id, { viewerId: viewer.kind === "user" ? viewer.user.id : null, order: sort });
  const shown = editable ? items : items.filter((i) => i.status === "READY");
  const favourites = await photoFavourites(shown.map((p) => p.id), viewer);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold">
          {shown.length} item{shown.length === 1 ? "" : "s"}
        </h2>
        <div className="flex items-center gap-2">
          {owns && <ButtonLink href={`/collections/${slug}/cover`} size="sm" variant="secondary">Cover photo</ButtonLink>}
          {editable && <ButtonLink href={`/collections/${slug}/add`} size="sm">Add existing photos</ButtonLink>}
        </div>
      </div>
      <SortToggle
        value={sort}
        options={[
          // Only where somebody has arranged it; the saved order is this collection's own, not a habit for other grids.
          ...(arranged ? [{ value: "arranged" as CollectionSort, label: "Saved order", remember: false as const }] : []),
          ...(editable ? [{ value: "favorites" as CollectionSort, label: "Favorites first" }] : []),
          { value: "newest", label: "Newest first" },
          { value: "oldest", label: "Oldest first" },
        ]}
        cookie={SORT_COOKIES.photos}
        label="How the photos are ordered"
        testId="photos-order"
      />
      {Number.isFinite(added) && <p role="status" className="text-sm rounded-theme bg-emerald-50 border border-emerald-200 text-emerald-900 p-3">Added {added} photo{added === 1 ? "" : "s"} to this collection.</p>}
      {editable && <YouTubeAddForm collectionId={collection.id} />}
      <CollectionGallery key={sort} arranged={arranged} collectionId={collection.id} slug={slug} photos={shown.map((p) => ({ ...toGridPhoto(p, null, editable, favourites.get(p.id)), itemId: p.itemId, arranged: p.arranged }))} editable={owns} emptyMessage={editable ? "Nothing here yet. Use Add existing photos, open a photo and check this collection, or select photos in any gallery." : "Nothing here yet."} />
    </div>
  );
}

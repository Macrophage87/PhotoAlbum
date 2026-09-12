"use client";

import { PhotoGrid, type GridPhoto } from "./PhotoGrid";
import { LoadMoreSentinel, useLoadMore } from "./LoadMore";

/** Read-only gallery for share pages and public trips, paged by cursor like the members' gallery. */
export function SharedGallery({ photos: initial, more }: { photos: GridPhoto[]; more: { url: string; nextCursor: string | null; total: number } }) {
  const paged = useLoadMore(more.url, more.nextCursor, initial);
  return (
    <>
      <PhotoGrid photos={paged.photos} />
      <LoadMoreSentinel hasMore={paged.hasMore} loading={paged.loading} error={paged.error} onLoad={paged.loadMore} shown={paged.photos.length} total={more.total} />
    </>
  );
}

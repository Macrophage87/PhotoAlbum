"use client";

import { PhotoGrid, type GridPhoto } from "./PhotoGrid";
import { LoadMoreSentinel, useLoadMore } from "./LoadMore";

/**
 * The photos on no trip, a page at a time. Selection comes from the page's provider, so a tile loaded further down
 * is picked and filed exactly like one from the first page.
 */
export function UnassignedGallery({ photos: initial, emptyMessage, more }: { photos: GridPhoto[]; emptyMessage: string; more: { url: string; nextCursor: string | null; total: number } }) {
  const paged = useLoadMore(more.url, more.nextCursor, initial);
  return (
    <>
      <PhotoGrid photos={paged.photos} emptyMessage={emptyMessage} />
      <LoadMoreSentinel hasMore={paged.hasMore} loading={paged.loading} error={paged.error} onLoad={paged.loadMore} shown={paged.photos.length} total={more.total} />
    </>
  );
}

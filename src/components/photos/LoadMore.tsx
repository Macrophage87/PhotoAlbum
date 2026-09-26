"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "@/components/ui";
import type { GridPhoto } from "./PhotoGrid";

/** The first page as the server last sent it, then whatever further pages were fetched here that it does not hold. */
export function mergePages(first: GridPhoto[], fetched: GridPhoto[]): GridPhoto[] {
  const seen = new Set(first.map((p) => p.id));
  return [...first, ...fetched.filter((p) => !seen.has(p.id))];
}

/**
 * Photos held from later pages, brought up to date from a re-read of them: each one asked about is replaced by what
 * came back, or dropped if nothing did (trashed, moved off the trip, no longer matching the filter).
 */
export function patchFetched(held: GridPhoto[], asked: Set<string>, got: GridPhoto[]): GridPhoto[] {
  const fresh = new Map(got.map((p) => [p.id, p]));
  return held.flatMap((p) => (asked.has(p.id) ? (fresh.has(p.id) ? [fresh.get(p.id)!] : []) : [p]));
}

/** How many photos one re-read names, the most the gallery's route will take in one address. */
const REREAD_CHUNK = 200;

/**
 * Fetches further gallery pages by cursor when the sentinel scrolls into view (or on click). Key the owner on its query so a new filter starts fresh.
 *
 * Only the pages fetched here are held in state; the first page is always the latest one passed in, so when an action
 * refreshes the page (a collection added, colours corrected, a heart moved up the order) the grid shows it. The later
 * pages are re-read by id at the same moment, so a photo far down the grid shows the change too.
 */
export function useLoadMore(url: string, initialCursor: string | null, initialPhotos: GridPhoto[]) {
  const [fetched, setFetched] = useState<{ photos: GridPhoto[]; cursor: string | null; pages: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  // Until a further page has been fetched, where to go next is whatever the server said most recently.
  const cursor = fetched ? fetched.cursor : initialCursor;
  const photos = mergePages(initialPhotos, fetched?.photos ?? []);
  const loadMore = async () => {
    if (!cursor || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { photos: GridPhoto[]; nextCursor: string | null };
      setFetched((prev) => ({ photos: mergePages(prev?.photos ?? [], body.photos), cursor: body.nextCursor, pages: (prev?.pages ?? 0) + 1 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };

  // New props mean the server has refreshed the page after an action; the first page came with them, the rest is asked for.
  const rereads = useRef(0);
  const reread = useEffectEvent(() => {
    const held = fetched?.photos.map((p) => p.id) ?? [];
    if (!held.length || !url) return;
    // Two refreshes in quick succession: only the later re-read may land, or an older answer could overwrite a newer one.
    const seq = ++rereads.current;
    const chunks: string[][] = [];
    for (let i = 0; i < held.length; i += REREAD_CHUNK) chunks.push(held.slice(i, i + REREAD_CHUNK));
    Promise.all(
      chunks.map(async (ids) => {
        const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}ids=${ids.map(encodeURIComponent).join(",")}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return ((await res.json()) as { photos: GridPhoto[] }).photos;
      }),
    )
      .then((pages) => {
        if (seq !== rereads.current) return;
        const asked = new Set(held);
        setFetched((prev) => prev && { ...prev, photos: patchFetched(prev.photos, asked, pages.flat()) });
      })
      // What was there stays: slightly stale tiles are better than an error over a gallery that works.
      .catch(() => {});
  });
  useEffect(() => reread(), [initialPhotos]);

  return { photos, hasMore: Boolean(cursor), loading, error, loadMore, pages: fetched?.pages ?? 0 };
}

export function LoadMoreSentinel({ hasMore, loading, error, onLoad, shown, total, pages }: { hasMore: boolean; loading: boolean; error: string | null; onLoad: () => void; shown: number; total: number; /** How many pages have arrived: each one re-arms the observer, even one that added nothing new. */ pages: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const load = useEffectEvent(onLoad);
  // Re-armed only when a page arrives (a fresh observer reports at once, so a sentinel still in view fetches the
  // next, even after a page that was all repeats and grew nothing), never on every render. After a failure it stays disarmed and only the button retries, rather than
  // refetching as fast as the server can fail.
  useEffect(() => {
    if (!hasMore || error || !ref.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && load(), { rootMargin: "600px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [hasMore, error, pages]);
  if (!hasMore && !error) return null;
  return (
    <div ref={ref} className="flex items-center justify-center gap-3 py-4 text-sm text-muted">
      <span>{shown} of {total}</span>
      {error && <span className="text-red-700">{error}</span>}
      <Button size="sm" variant="secondary" disabled={loading} onClick={onLoad}>{loading ? "Loading…" : "Load more"}</Button>
    </div>
  );
}

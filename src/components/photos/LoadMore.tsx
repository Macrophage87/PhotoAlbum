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
 * Fetches further gallery pages by cursor when the sentinel scrolls into view (or on click). Key the owner on its query so a new filter starts fresh.
 *
 * Only the pages fetched here are held in state; the first page is always the latest one passed in, so when an action
 * refreshes the page (a collection added, colours corrected, a heart moved up the order) the grid shows it.
 */
export function useLoadMore(url: string, initialCursor: string | null, initialPhotos: GridPhoto[]) {
  const [fetched, setFetched] = useState<{ photos: GridPhoto[]; cursor: string | null } | null>(null);
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
      setFetched((prev) => ({ photos: mergePages(prev?.photos ?? [], body.photos), cursor: body.nextCursor }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };
  return { photos, hasMore: Boolean(cursor), loading, error, loadMore };
}

export function LoadMoreSentinel({ hasMore, loading, error, onLoad, shown, total }: { hasMore: boolean; loading: boolean; error: string | null; onLoad: () => void; shown: number; total: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const load = useEffectEvent(onLoad);
  // Re-armed only when a page arrives (a fresh observer reports at once, so a sentinel still in view fetches the
  // next), never on every render. After a failure it stays disarmed and only the button retries, rather than
  // refetching as fast as the server can fail.
  useEffect(() => {
    if (!hasMore || error || !ref.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && load(), { rootMargin: "600px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [hasMore, error, shown]);
  if (!hasMore && !error) return null;
  return (
    <div ref={ref} className="flex items-center justify-center gap-3 py-4 text-sm text-muted">
      <span>{shown} of {total}</span>
      {error && <span className="text-red-700">{error}</span>}
      <Button size="sm" variant="secondary" disabled={loading} onClick={onLoad}>{loading ? "Loading…" : "Load more"}</Button>
    </div>
  );
}

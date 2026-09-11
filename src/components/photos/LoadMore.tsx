"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import type { GridPhoto } from "./PhotoGrid";

/** Fetches further gallery pages by cursor when the sentinel scrolls into view (or on click). Key the owner on its query so a new filter starts fresh. */
export function useLoadMore(url: string, initialCursor: string | null, initialPhotos: GridPhoto[]) {
  const [photos, setPhotos] = useState(initialPhotos);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadMore = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { photos: GridPhoto[]; nextCursor: string | null };
      setPhotos((prev) => [...prev, ...body.photos.filter((p) => !prev.some((q) => q.id === p.id))]);
      setCursor(body.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more");
    } finally {
      setLoading(false);
    }
  };
  return { photos, hasMore: Boolean(cursor), loading, error, loadMore };
}

export function LoadMoreSentinel({ hasMore, loading, error, onLoad, shown, total }: { hasMore: boolean; loading: boolean; error: string | null; onLoad: () => void; shown: number; total: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasMore || !ref.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onLoad(), { rootMargin: "600px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [hasMore, onLoad]);
  if (!hasMore && !error) return null;
  return (
    <div ref={ref} className="flex items-center justify-center gap-3 py-4 text-sm text-muted">
      <span>{shown} of {total}</span>
      {error && <span className="text-red-700">{error}</span>}
      <Button size="sm" variant="secondary" disabled={loading} onClick={onLoad}>{loading ? "Loading…" : "Load more"}</Button>
    </div>
  );
}

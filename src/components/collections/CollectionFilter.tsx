"use client";

import { useRouter } from "next/navigation";

/** A select that narrows a global page (timeline, map) to one collection via `?collection=<slug>`. */
export function CollectionFilter({ collections, current, basePath }: { collections: { slug: string; title: string }[]; current: string; basePath: string }) {
  const router = useRouter();
  if (collections.length === 0) return null;
  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      Show
      <select value={current} onChange={(e) => router.push(e.target.value ? `${basePath}?collection=${encodeURIComponent(e.target.value)}` : basePath)} className="h-9 rounded-theme border border-border bg-surface px-2 text-sm text-text" aria-label="Collection filter">
        <option value="">All trips</option>
        {collections.map((c) => (
          <option key={c.slug} value={c.slug}>Collection: {c.title}</option>
        ))}
      </select>
    </label>
  );
}

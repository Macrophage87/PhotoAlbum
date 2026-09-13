"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ContainerPicker, type Container } from "@/components/containers/ContainerPicker";

/**
 * Narrows a global page (timeline, map) to one collection via `?collection=<slug>`. A search rather than a list of
 * every collection, for the same reason as everywhere else: the list grows without limit and the box does not.
 */
export function CollectionFilter({ current, basePath }: { current: { slug: string; title: string } | null; basePath: string }) {
  const router = useRouter();
  const [chosen, setChosen] = useState<Container | null>(current ? { id: current.slug, title: current.title, slug: current.slug } : null);
  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <span className="shrink-0">Show</span>
      <div className="w-56">
        <ContainerPicker
          kind="collection"
          value={chosen}
          onChange={(v) => {
            setChosen(v);
            router.push(v?.slug ? `${basePath}?collection=${encodeURIComponent(v.slug)}` : basePath);
          }}
          allowNone
          noneLabel="Everything"
          placeholder="One collection…"
        />
      </div>
    </div>
  );
}

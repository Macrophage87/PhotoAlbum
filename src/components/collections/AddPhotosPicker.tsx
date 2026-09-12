"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, Select } from "@/components/ui";
import { PhotoGrid, type GridPhoto } from "@/components/photos/PhotoGrid";
import { addToCollection, moreCandidates } from "@/app/collections/actions";
import { previewAddToCollection } from "@/app/photos/exposure-actions";

type Filter = { trip: string | null; q: string | null; from: string | null; to: string | null };

/** Tick photos from anywhere in the album and add them to one collection; warns first when that would expose them. */
export function AddPhotosPicker({ collection, trips, filter, initial }: { collection: { id: string; slug: string; title: string }; trips: { id: string; title: string }[]; filter: Filter; initial: { photos: GridPhoto[]; nextCursor: string | null; total: number } }) {
  const router = useRouter();
  const [photos, setPhotos] = useState(initial.photos);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const selectShown = () => setSelected(new Set(photos.map((p) => p.id)));
  const loadMore = () => start(async () => {
    if (!nextCursor) return;
    const more = await moreCandidates(collection.slug, filter, nextCursor);
    setPhotos((prev) => [...prev, ...more.photos]);
    setNextCursor(more.nextCursor);
  });
  const add = () => start(async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setMessage(null);
    try {
      const warnings = await previewAddToCollection(ids, collection.id);
      if (warnings.length && !window.confirm(`${warnings.join("\n")}\n\nContinue?`)) return;
      const n = await addToCollection(collection.id, ids);
      router.push(`/collections/${collection.slug}/photos?added=${n}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong");
    }
  });

  return (
    <div className="space-y-4" data-testid="add-photos">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold">Add existing photos to {collection.title}</h2>
          <p className="text-sm text-muted mt-1">Tick the photos that belong here. {initial.total} item{initial.total === 1 ? "" : "s"} to choose from{filter.trip || filter.q || filter.from || filter.to ? " with this filter" : ""}; photos already in the collection are not shown.</p>
        </div>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="trip">Trip</Label>
            <Select id="trip" name="trip" defaultValue={filter.trip ?? ""} className="h-9">
              <option value="">Any trip</option>
              <option value="none">Without a trip</option>
              {trips.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </Select>
          </div>
          <div>
            <Label htmlFor="from">From</Label>
            <Input id="from" name="from" type="date" defaultValue={filter.from ?? ""} className="h-9" />
          </div>
          <div>
            <Label htmlFor="to">To</Label>
            <Input id="to" name="to" type="date" defaultValue={filter.to ?? ""} className="h-9" />
          </div>
          <div>
            <Label htmlFor="q">Words in caption, notes or description</Label>
            <Input id="q" name="q" defaultValue={filter.q ?? ""} placeholder="lake, birthday, Biscuit…" className="h-9" />
          </div>
          <Button type="submit" variant="secondary" size="sm">Filter</Button>
        </form>
      </div>
      {message && <p role="alert" className="text-sm rounded-theme bg-red-50 border border-red-200 text-red-900 p-3">{message}</p>}
      <PhotoGrid photos={photos} selectable selected={selected} onToggle={toggle} emptyMessage={filter.trip || filter.q || filter.from || filter.to ? "Nothing matches this filter." : "Every ready photo is already in this collection."} />
      {nextCursor && (
        <div className="text-center">
          <Button variant="secondary" size="sm" onClick={loadMore} disabled={pending}>Load more</Button>
        </div>
      )}
      <div className="sticky bottom-0 z-10 -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 bg-surface/95 backdrop-blur border-t border-border flex flex-wrap items-center justify-between gap-3" role="toolbar" aria-label="Selection">
        <div className="text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <button type="button" className="ml-3 text-primary hover:underline" onClick={selectShown} disabled={photos.length === 0}>Select all shown</button>
          {selected.size > 0 && <button type="button" className="ml-3 text-muted hover:underline" onClick={() => setSelected(new Set())}>Clear</button>}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => router.push(`/collections/${collection.slug}/photos`)} disabled={pending}>Cancel</Button>
          <Button size="sm" onClick={add} disabled={pending || selected.size === 0}>{pending ? "Adding…" : `Add ${selected.size || ""} to collection`.replace("  ", " ")}</Button>
        </div>
      </div>
    </div>
  );
}

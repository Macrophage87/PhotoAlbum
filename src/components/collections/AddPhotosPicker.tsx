"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { PhotoGrid, type GridPhoto } from "@/components/photos/PhotoGrid";
import { PickerFilters, type PickerOption } from "@/components/photos/PickerFilters";
import { addToCollection, moreCandidates } from "@/app/collections/actions";
import { moreActivityCandidates, moreTripCandidates } from "@/app/trips/[slug]/add-actions";
import { attachToActivity } from "@/app/photos/attach-actions";
import { bulkMoveToTrip } from "@/app/photos/bulk-actions";
import { previewAddToCollection, previewMoveToTrip } from "@/app/photos/exposure-actions";
import { describePickerFilter, pickerFilterIsActive, pickerFilterQuery, type PickerFilter } from "@/lib/photos/picker-filter";
import type { FilterPerson } from "@/lib/people/in-photos";

/**
 * Where the ticked photographs are going. A collection gathers them; a trip takes them over; an activity takes them
 * over and puts them on its trip. `slug` is the collection's or the trip's; `home` is where the page goes back to.
 */
export type PickerDestination =
  | { kind: "collection"; id: string; slug: string; title: string }
  | { kind: "trip"; id: string; slug: string; title: string }
  | { kind: "activity"; id: string; slug: string; title: string; tripId: string };

const addPath = (d: PickerDestination) => (d.kind === "collection" ? `/collections/${d.slug}/add` : d.kind === "trip" ? `/trips/${d.slug}/add` : `/trips/${d.slug}/activities/${d.id}/add`);
const homePath = (d: PickerDestination) => (d.kind === "collection" ? `/collections/${d.slug}/photos` : d.kind === "trip" ? `/trips/${d.slug}/photos` : `/trips/${d.slug}/activities/${d.id}`);
const where = { collection: "in the collection", trip: "on the trip", activity: "on this activity" } as const;

/** Tick photos from anywhere in the album and put them somewhere; warns first when that would show them to more people. */
export function AddPhotosPicker({ destination, initialTrip, filter, members, people, initial, extra }: {
  destination: PickerDestination;
  /** The trip the filter is already narrowed to, so the box shows its name. */
  initialTrip: { id: string; title: string } | null;
  filter: PickerFilter;
  members?: PickerOption[];
  people?: FilterPerson[];
  initial: { photos: GridPhoto[]; nextCursor: string | null; total: number };
  /** Anything to offer above the search, such as taking everything from the time it happened in one go. */
  extra?: React.ReactNode;
}) {
  const router = useRouter();
  const [photos, setPhotos] = useState(initial.photos);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const selectShown = () => setSelected(new Set(photos.map((p) => p.id)));
  const query = pickerFilterQuery(filter);
  const loadMore = () => start(async () => {
    if (!nextCursor) return;
    const more = destination.kind === "collection"
      ? await moreCandidates(destination.slug, query, nextCursor)
      : destination.kind === "activity"
        ? await moreActivityCandidates(destination.id, query, nextCursor)
        : await moreTripCandidates(destination.slug, query, nextCursor);
    setPhotos((prev) => [...prev, ...more.photos]);
    setNextCursor(more.nextCursor);
  });
  const add = () => start(async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setMessage(null);
    try {
      const warnings = destination.kind === "collection" ? await previewAddToCollection(ids, destination.id) : await previewMoveToTrip(ids, destination.kind === "activity" ? destination.tripId : destination.id);
      if (warnings.length && !window.confirm(`${warnings.join("\n")}\n\nContinue?`)) return;
      if (destination.kind === "collection") {
        const n = await addToCollection(destination.id, ids);
        router.push(`/collections/${destination.slug}/photos?added=${n}`);
      } else if (destination.kind === "activity") {
        const n = await attachToActivity(destination.id, ids);
        router.push(`/trips/${destination.slug}/activities/${destination.id}?added=${n}`);
      } else {
        await bulkMoveToTrip(ids, destination.id);
        router.push(`/trips/${destination.slug}/photos?added=${ids.length}`);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong");
    }
  });

  return (
    <div className="space-y-4" data-testid="add-photos">
      <div className="space-y-3">
        <div>
          <h2 className="font-display text-xl font-semibold">
            {destination.kind === "collection" ? `Add existing photos to ${destination.title}` : `Put existing photos on ${destination.title}`}
          </h2>
          <p className="text-sm text-muted mt-1">
            Tick the ones that belong here. {initial.total} item{initial.total === 1 ? "" : "s"} to choose from
            {pickerFilterIsActive(filter) ? ` — ${describePickerFilter(filter).join("; ") || "with this filter"}` : ""}; anything already
            {` ${where[destination.kind]}`} is not shown.
          </p>
        </div>
        {extra}
        <PickerFilters
          filter={filter}
          action={addPath(destination)}
          initialTrip={initialTrip}
          members={members}
          people={people}
          showTrip={destination.kind !== "trip"}
        />
      </div>
      {message && <p role="alert" className="text-sm rounded-theme bg-red-50 border border-red-200 text-red-900 p-3">{message}</p>}
      <PhotoGrid photos={photos} selectable selected={selected} onToggle={toggle} emptyMessage={pickerFilterIsActive(filter) ? "Nothing matches that. Try fewer words, a wider distance, or a longer stretch of days." : `Every ready photo is already ${where[destination.kind]}.`} />
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
          <Button variant="secondary" size="sm" onClick={() => router.push(homePath(destination))} disabled={pending}>Cancel</Button>
          <Button size="sm" onClick={add} disabled={pending || selected.size === 0} data-testid="picker-add">
            {pending
              ? destination.kind === "collection" ? "Adding…" : "Moving…"
              : destination.kind === "collection"
                ? `Add ${selected.size} to collection`
                : destination.kind === "activity"
                  ? `Put ${selected.size} on this activity`
                  : `Put ${selected.size} on the trip`}
          </Button>
        </div>
      </div>
    </div>
  );
}

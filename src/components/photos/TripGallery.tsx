"use client";

import { useState, useTransition } from "react";
import { PhotoGrid, type GridPhoto } from "./PhotoGrid";
import { LoadMoreSentinel, useLoadMore } from "./LoadMore";
import { Button, Select } from "@/components/ui";
import { bulkAssignActivity, bulkDelete, bulkMoveToTrip } from "@/app/photos/bulk-actions";
import { addToCollection } from "@/app/collections/actions";
import { previewAddToCollection, previewMoveToTrip } from "@/app/photos/exposure-actions";

type Option = { id: string; title: string };

/** Gallery with an optional selection mode for members: assign to an activity, move trips, or delete. */
export function TripGallery({ photos: initialPhotos, activities, trips, collections = [], editable, emptyMessage, more }: { photos: GridPhoto[]; activities: Option[]; trips: Option[]; collections?: Option[]; editable: boolean; emptyMessage: string; /** Cursor pagination: where to fetch the next page and how many items there are in all. */ more?: { url: string; nextCursor: string | null; total: number } }) {
  const paged = useLoadMore(more?.url ?? "", more?.nextCursor ?? null, initialPhotos);
  const photos = paged.photos;
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activityId, setActivityId] = useState("");
  const [tripId, setTripId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [pending, start] = useTransition();
  const ids = [...selected];

  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      await fn();
      setSelected(new Set());
      setSelecting(false);
    });
  /** Ask before a change that makes photos visible to more people. */
  const confirmExposure = async (warnings: string[]) => warnings.length === 0 || window.confirm(`${warnings.join("\n")}\n\nContinue?`);

  return (
    <div className="space-y-3">
      {editable && photos.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {!selecting ? (
            <Button variant="secondary" size="sm" onClick={() => setSelecting(true)}>
              Select photos
            </Button>
          ) : (
            <>
              <span className="text-muted">{ids.length} selected</span>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(photos.map((p) => p.id)))}>
                All
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                None
              </Button>
              <span className="mx-1 text-border">|</span>
              <div className="w-48">
                <Select aria-label="Activity to assign" value={activityId} onChange={(e) => setActivityId(e.target.value)} className="h-8 text-sm">
                  <option value="">Activity…</option>
                  <option value="__none">No activity</option>
                  {activities.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title}
                    </option>
                  ))}
                </Select>
              </div>
              <Button size="sm" variant="secondary" disabled={!ids.length || !activityId || pending} onClick={() => run(() => bulkAssignActivity(ids, activityId === "__none" ? null : activityId))}>
                Assign
              </Button>
              <div className="w-48">
                <Select aria-label="Trip to move to" value={tripId} onChange={(e) => setTripId(e.target.value)} className="h-8 text-sm">
                  <option value="">Move to trip…</option>
                  <option value="__none">No trip</option>
                  {trips.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={!ids.length || !tripId || pending}
                onClick={() =>
                  run(async () => {
                    const target = tripId === "__none" ? null : tripId;
                    if (await confirmExposure(await previewMoveToTrip(ids, target))) await bulkMoveToTrip(ids, target);
                  })
                }
              >
                Move
              </Button>
              {collections.length > 0 && (
                <>
                  <div className="w-48">
                    <Select aria-label="Collection to add to" value={collectionId} onChange={(e) => setCollectionId(e.target.value)} className="h-8 text-sm">
                      <option value="">Add to collection…</option>
                      {collections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!ids.length || !collectionId || pending}
                    onClick={() =>
                      run(async () => {
                        if (await confirmExposure(await previewAddToCollection(ids, collectionId))) await addToCollection(collectionId, ids);
                      })
                    }
                  >
                    Add
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="danger"
                disabled={!ids.length || pending}
                onClick={() => {
                  if (window.confirm(`Delete ${ids.length} photo${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) run(() => bulkDelete(ids));
                }}
              >
                Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setSelecting(false); setSelected(new Set()); }}>
                Done
              </Button>
            </>
          )}
        </div>
      )}
      <PhotoGrid
        photos={photos}
        emptyMessage={emptyMessage}
        selectable={selecting}
        selected={selected}
        onToggle={(id) =>
          setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
      />
      {more && <LoadMoreSentinel hasMore={paged.hasMore} loading={paged.loading} error={paged.error} onLoad={paged.loadMore} shown={photos.length} total={more.total} />}
    </div>
  );
}

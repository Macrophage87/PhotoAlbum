"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PhotoGrid, type GridPhoto } from "./PhotoGrid";
import { LoadMoreSentinel, useLoadMore } from "./LoadMore";
import { Button, Select } from "@/components/ui";
import { bulkAssignActivity, bulkAutoColour, bulkMoveToTrip, bulkTrash, undoAutoColour } from "@/app/photos/bulk-actions";
import { describeAutoColour, describeUndoColour } from "@/lib/photos/auto-colour";
import { BulkTrashControl } from "./TrashButton";
import { addToCollection } from "@/app/collections/actions";
import { ContainerPicker, type Container } from "@/components/containers/ContainerPicker";
import { previewAddToCollection, previewMoveToTrip } from "@/app/photos/exposure-actions";

type Option = { id: string; title: string };

/** Gallery with an optional selection mode for members: assign to an activity, move trips, or delete. */
export function TripGallery({ photos: initialPhotos, activities, editable, emptyMessage, more }: { photos: GridPhoto[]; activities: Option[]; editable: boolean; emptyMessage: string; /** Cursor pagination: where to fetch the next page and how many items there are in all. */ more?: { url: string; nextCursor: string | null; total: number } }) {
  const paged = useLoadMore(more?.url ?? "", more?.nextCursor ?? null, initialPhotos);
  const photos = paged.photos;
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activityId, setActivityId] = useState("");
  // The trip and collection are searched for rather than chosen from a list of everything: see ContainerPicker.
  const [trip, setTrip] = useState<Container | null>(null);
  const [moving, setMoving] = useState(false); // "no trip" is a real choice, so a null trip is not the same as nothing chosen
  const [collection, setCollection] = useState<Container | null>(null);
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  /** What the last auto-colour run touched, so the whole batch can be handed back in one press. */
  const [undoable, setUndoable] = useState<string[]>([]);
  const router = useRouter();
  const ids = [...selected];

  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      await fn();
      setSelected(new Set());
      setSelecting(false);
    });
  const autoColour = () =>
    start(async () => {
      const r = await bulkAutoColour(ids);
      setUndoable(r.changed);
      setSelected(new Set());
      setSelecting(false);
      setNotice(describeAutoColour(r));
      router.refresh();
    });

  const undoColour = (which: string[]) =>
    start(async () => {
      const n = await undoAutoColour(which);
      setUndoable([]);
      setNotice(describeUndoColour(n));
      router.refresh();
    });

  /** Ask before a change that makes photos visible to more people. */
  const confirmExposure = async (warnings: string[]) => warnings.length === 0 || window.confirm(`${warnings.join("\n")}\n\nContinue?`);

  return (
    <div className="space-y-3">
      {editable && photos.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {!selecting ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => { setSelecting(true); setNotice(null); }}>
                Select photos
              </Button>
              {notice && <span className="text-muted" role="status">{notice}</span>}
              {undoable.length > 0 && (
                <Button variant="ghost" size="sm" disabled={pending} onClick={() => undoColour(undoable)} data-testid="undo-auto-colour">
                  Undo auto colour
                </Button>
              )}
            </>
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
                <ContainerPicker kind="trip" value={trip} onChange={(v) => { setTrip(v); setMoving(true); }} allowNone noneLabel="No trip" placeholder="Move to trip…" />
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={!ids.length || !moving || pending}
                onClick={() =>
                  run(async () => {
                    const target = trip?.id ?? null;
                    if (await confirmExposure(await previewMoveToTrip(ids, target))) await bulkMoveToTrip(ids, target);
                  })
                }
              >
                Move
              </Button>
              {(
                <>
                  <div className="w-48">
                    <ContainerPicker kind="collection" value={collection} onChange={setCollection} placeholder="Add to collection…" />
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!ids.length || !collection || pending}
                    onClick={() =>
                      run(async () => {
                        if (!collection) return;
                        if (await confirmExposure(await previewAddToCollection(ids, collection.id))) await addToCollection(collection.id, ids);
                      })
                    }
                  >
                    Add
                  </Button>
                </>
              )}
              <Button size="sm" variant="secondary" disabled={!ids.length || pending} onClick={autoColour} data-testid="auto-colour">
                {pending ? "Working…" : "Auto colour"}
              </Button>
              <BulkTrashControl count={ids.length} disabled={!ids.length || pending} onTrash={async (reason, note) => { await bulkTrash(ids, reason, note); setSelected(new Set()); }} />
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

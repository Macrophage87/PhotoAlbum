"use client";

import { useState, useTransition } from "react";
import { PhotoGrid, type GridPhoto } from "@/components/photos/PhotoGrid";
import { Button } from "@/components/ui";
import { bulkTakeOffActivity } from "@/app/photos/activity-actions";

/**
 * An activity's photographs, with a way to take one off it.
 *
 * Filing is a guess until somebody corrects it: the album puts a photograph on whichever activity was happening at
 * the time, and two people on the same afternoon do two different things. Taking one off leaves it on the trip,
 * under its own day — it did not stop being part of the fortnight, it just did not happen on this walk. Dragging
 * it out of the activity card was already possible on the timeline, which is no use on a phone.
 */
export function ActivityGallery({ photos, emptyMessage }: { photos: GridPhoto[]; emptyMessage: string }) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ids = [...selected];

  const take = () =>
    start(async () => {
      const r = await bulkTakeOffActivity(ids);
      setSelected(new Set());
      setSelecting(false);
      setNotice(`${r.n} taken off this activity${r.notYours ? `, ${r.notYours} not yours to change` : ""}. ${r.n === 1 ? "It is" : "They are"} still on the trip, under ${r.n === 1 ? "its" : "their"} own day.`);
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {selecting ? (
          <>
            <Button size="sm" variant="secondary" disabled={!ids.length || pending} onClick={take} data-testid="take-off-activity">
              {pending ? "Working…" : ids.length ? `Take ${ids.length} off this activity` : "Take off this activity"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setSelecting(false); setSelected(new Set()); }}>Cancel</Button>
          </>
        ) : (
          photos.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => { setSelecting(true); setNotice(null); }} data-testid="activity-select">
              Select photos
            </Button>
          )
        )}
      </div>
      {notice && <p role="status" className="text-sm text-muted">{notice}</p>}
      <PhotoGrid
        photos={photos}
        emptyMessage={emptyMessage}
        {...(selecting
          ? {
              selectable: true,
              selected,
              onToggle: (id: string) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                }),
            }
          : {})}
      />
    </div>
  );
}

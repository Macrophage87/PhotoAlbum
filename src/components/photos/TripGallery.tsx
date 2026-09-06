"use client";

import { useState, useTransition } from "react";
import { PhotoGrid, type GridPhoto } from "./PhotoGrid";
import { Button, Select } from "@/components/ui";
import { bulkAssignActivity, bulkDelete, bulkMoveToTrip } from "@/app/photos/bulk-actions";

type Option = { id: string; title: string };

/** Gallery with an optional selection mode for members: assign to an activity, move trips, or delete. */
export function TripGallery({ photos, activities, trips, editable, emptyMessage }: { photos: GridPhoto[]; activities: Option[]; trips: Option[]; editable: boolean; emptyMessage: string }) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activityId, setActivityId] = useState("");
  const [tripId, setTripId] = useState("");
  const [pending, start] = useTransition();
  const ids = [...selected];

  const run = (fn: () => Promise<void>) =>
    start(async () => {
      await fn();
      setSelected(new Set());
      setSelecting(false);
    });

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
                <Select value={activityId} onChange={(e) => setActivityId(e.target.value)} className="h-8 text-sm">
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
                <Select value={tripId} onChange={(e) => setTripId(e.target.value)} className="h-8 text-sm">
                  <option value="">Move to trip…</option>
                  <option value="__none">No trip</option>
                  {trips.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </Select>
              </div>
              <Button size="sm" variant="secondary" disabled={!ids.length || !tripId || pending} onClick={() => run(() => bulkMoveToTrip(ids, tripId === "__none" ? null : tripId))}>
                Move
              </Button>
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
        showDetailLink={editable}
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
    </div>
  );
}

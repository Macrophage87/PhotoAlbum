"use client";

import { useState, useTransition } from "react";
import { PhotoGrid, type GridPhoto } from "@/components/photos/PhotoGrid";
import { Button, Select } from "@/components/ui";
import { addToCollection, removeFromCollection, reorderCollection, setCollectionCover, sortCollectionByDate } from "@/app/collections/actions";
import { bulkMoveToTrip, bulkTrash } from "@/app/photos/bulk-actions";
import { BulkTrashControl } from "@/components/photos/TrashButton";
import { previewAddToCollection, previewMoveToTrip } from "@/app/photos/exposure-actions";

export type CollectionGridPhoto = GridPhoto & { itemId: string };

/**
 * A collection's items for members: select to remove or set the cover, arrange by drag, or sort by date.
 * Read-only viewers get the plain grid.
 */
type Option = { id: string; title: string };

export function CollectionGallery({ collectionId, slug, photos, editable, emptyMessage, trips = [], collections = [] }: { collectionId: string; slug: string; photos: CollectionGridPhoto[]; editable: boolean; emptyMessage: string; trips?: Option[]; collections?: Option[] }) {
  const [mode, setMode] = useState<"view" | "select" | "arrange">("view");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [order, setOrder] = useState<CollectionGridPhoto[]>(photos);
  const [dragging, setDragging] = useState<string | null>(null);
  const [tripId, setTripId] = useState("");
  const [otherId, setOtherId] = useState("");
  const confirmExposure = async (warnings: string[]) => warnings.length === 0 || window.confirm(`${warnings.join("\n")}\n\nContinue?`);
  const [pending, start] = useTransition();
  const ids = [...selected];

  const finish = (fn: () => Promise<unknown>) =>
    start(async () => {
      await fn();
      setSelected(new Set());
      setMode("view");
    });

  const moveTo = (targetId: string) => {
    if (!dragging || dragging === targetId) return;
    setOrder((prev) => {
      const from = prev.findIndex((p) => p.id === dragging);
      const to = prev.findIndex((p) => p.id === targetId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {editable && photos.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {mode === "view" && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setMode("select")}>Select photos</Button>
              <Button variant="secondary" size="sm" onClick={() => { setOrder(photos); setMode("arrange"); }}>Arrange</Button>
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => start(() => sortCollectionByDate(slug))}>Sort by date</Button>
            </>
          )}
          {mode === "select" && (
            <>
              <span className="text-muted">{ids.length} selected</span>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(photos.map((p) => p.id)))}>All</Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>None</Button>
              <span className="mx-1 text-border">|</span>
              <Button size="sm" variant="secondary" disabled={ids.length !== 1 || pending} onClick={() => finish(() => setCollectionCover(slug, ids[0]))}>Set as cover</Button>
              <Button size="sm" variant="danger" disabled={!ids.length || pending} onClick={() => finish(() => removeFromCollection(collectionId, ids))}>Remove from collection</Button>
              {trips.length > 0 && (
                <>
                  <div className="w-44">
                    <Select aria-label="Trip to move to" value={tripId} onChange={(e) => setTripId(e.target.value)} className="h-8 text-sm">
                      <option value="">Add to trip…</option>
                      <option value="__none">No trip</option>
                      {trips.map((t) => (
                        <option key={t.id} value={t.id}>{t.title}</option>
                      ))}
                    </Select>
                  </div>
                  <Button size="sm" variant="secondary" disabled={!ids.length || !tripId || pending} onClick={() => finish(async () => { const target = tripId === "__none" ? null : tripId; if (await confirmExposure(await previewMoveToTrip(ids, target))) await bulkMoveToTrip(ids, target); })}>Move</Button>
                </>
              )}
              {collections.length > 0 && (
                <>
                  <div className="w-44">
                    <Select aria-label="Collection to add to" value={otherId} onChange={(e) => setOtherId(e.target.value)} className="h-8 text-sm">
                      <option value="">Add to collection…</option>
                      {collections.map((c) => (
                        <option key={c.id} value={c.id}>{c.title}</option>
                      ))}
                    </Select>
                  </div>
                  <Button size="sm" variant="secondary" disabled={!ids.length || !otherId || pending} onClick={() => finish(async () => { if (await confirmExposure(await previewAddToCollection(ids, otherId))) await addToCollection(otherId, ids); })}>Add</Button>
                </>
              )}
              <BulkTrashControl count={ids.length} disabled={!ids.length || pending} onTrash={async (reason, note) => { await bulkTrash(ids, reason, note); setSelected(new Set()); }} />
              <Button variant="ghost" size="sm" onClick={() => { setMode("view"); setSelected(new Set()); }}>Done</Button>
            </>
          )}
          {mode === "arrange" && (
            <>
              <span className="text-muted">Drag photos into order</span>
              <Button size="sm" disabled={pending} onClick={() => finish(() => reorderCollection(slug, order.map((p) => p.itemId)))}>Save order</Button>
              <Button variant="ghost" size="sm" onClick={() => setMode("view")}>Cancel</Button>
            </>
          )}
        </div>
      )}
      {mode === "arrange" ? (
        <ul className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2" aria-label="Arrange photos">
          {order.map((p, i) => (
            <li
              key={p.id}
              draggable
              onDragStart={() => setDragging(p.id)}
              onDragOver={(e) => { e.preventDefault(); moveTo(p.id); }}
              onDragEnd={() => setDragging(null)}
              className={`relative aspect-square rounded-theme overflow-hidden border cursor-grab ${dragging === p.id ? "opacity-50 border-primary" : "border-border"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.thumbUrl} alt="" className="w-full h-full object-cover pointer-events-none" />
              <span className="absolute top-1 left-1 text-[10px] bg-black/60 text-white rounded px-1.5 py-0.5">{i + 1}</span>
            </li>
          ))}
        </ul>
      ) : (
        <PhotoGrid
          photos={photos}
          emptyMessage={emptyMessage}
          selectable={mode === "select"}
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
      )}
    </div>
  );
}

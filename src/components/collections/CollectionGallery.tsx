"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PhotoGrid, type GridPhoto } from "@/components/photos/PhotoGrid";
import { Button } from "@/components/ui";
import { ContainerPicker, type Container } from "@/components/containers/ContainerPicker";
import { addToCollection, removeFromCollection, reorderCollection, setCollectionCover, sortCollectionByDate } from "@/app/collections/actions";
import { bulkMoveToTrip, bulkTrash } from "@/app/photos/bulk-actions";
import { BulkTrashControl } from "@/components/photos/TrashButton";
import { previewAddToCollection, previewMoveToTrip } from "@/app/photos/exposure-actions";

/** `arranged`: the item's place in the saved order, whatever order the grid is showing. */
export type CollectionGridPhoto = GridPhoto & { itemId: string; arranged: number };

/**
 * A collection's items for members: select to remove or set the cover, arrange by drag, or sort by date.
 * Read-only viewers get the plain grid.
 */

export function CollectionGallery({ collectionId, slug, photos, editable, emptyMessage, arranged = false }: { collectionId: string; slug: string; photos: CollectionGridPhoto[]; editable: boolean; emptyMessage: string; /** Whether somebody has saved an order of their own, which sorting by date would replace. */ arranged?: boolean }) {
  const [mode, setMode] = useState<"view" | "select" | "arrange">("view");
  /** What the last tidy-up did, said out loud rather than left to be inferred from a shorter grid. */
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [order, setOrder] = useState<CollectionGridPhoto[]>(photos);
  const [dragging, setDragging] = useState<string | null>(null);
  const [trip, setTrip] = useState<Container | null>(null);
  const [moving, setMoving] = useState(false);
  const [other, setOther] = useState<Container | null>(null);
  const confirmExposure = async (warnings: string[]) => warnings.length === 0 || window.confirm(`${warnings.join("\n")}\n\nContinue?`);
  const [pending, start] = useTransition();
  const ids = [...selected];
  const router = useRouter();
  const pathname = usePathname();
  /** The saved order, which is what Arrange starts from and saves over, not whichever order the grid is showing. */
  const saved = () => [...photos].sort((a, b) => a.arranged - b.arranged);
  /** Only a finished photograph with pictures (not a 3D scan nobody has opened) has one to lead with. Trashed ones
   *  are never in this grid. */
  const chosen = ids.length === 1 ? photos.find((p) => p.id === ids[0]) : undefined;
  const coverable = Boolean(chosen && chosen.status === "READY" && chosen.width !== null);

  const finish = (fn: () => Promise<unknown>) =>
    start(async () => {
      await fn();
      setSelected(new Set());
      setMode("view");
    });
  /** Having just put the collection in order, show it in that order rather than the one it was being viewed in. */
  const arrangeAnd = (fn: () => Promise<unknown>) =>
    finish(async () => {
      await fn();
      router.replace(`${pathname}?order=arranged`);
    });

  const remove = () =>
    start(async () => {
      const r = await removeFromCollection(collectionId, ids);
      setSelected(new Set());
      setMode("view");
      setNotice(`${r.removed} taken out of this collection${r.notYours ? `, ${r.notYours} not yours to change` : ""}. ${r.removed === 1 ? "It is" : "They are"} still in the album.`);
    });

  /** Move one item one place, for touch and for the keyboard. */
  const swap = (from: number, to: number) =>
    setOrder((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
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
              <Button variant="secondary" size="sm" onClick={() => { setMode("select"); setNotice(null); }}>Select photos</Button>
              {notice && <span className="text-muted" role="status">{notice}</span>}
              <Button variant="secondary" size="sm" onClick={() => { setOrder(saved()); setMode("arrange"); }}>Arrange</Button>
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => {
                  // Unlike "Oldest first" above, this is saved, and over whatever order somebody put the items in.
                  if (arranged && !window.confirm("Replace your saved order with date order?")) return;
                  arrangeAnd(() => sortCollectionByDate(slug));
                }}>Save in date order</Button>
            </>
          )}
          {mode === "select" && (
            <>
              <span className="text-muted">{ids.length} selected</span>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(photos.map((p) => p.id)))}>All</Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>None</Button>
              <span className="mx-1 text-border">|</span>
              <Button size="sm" variant="secondary" disabled={!coverable || pending} onClick={() => finish(() => setCollectionCover(slug, ids[0]))}>Set as cover</Button>
              {ids.length === 1 && !coverable && <span className="text-muted" role="status">{chosen?.status === "READY" ? "This item has no picture to lead with." : "Only a finished photo can be the cover."}</span>}
              <Button size="sm" variant="danger" disabled={!ids.length || pending} onClick={remove} data-testid="remove-from-collection">Remove from collection</Button>
              {(
                <>
                  <div className="w-44">
                    <ContainerPicker kind="trip" value={trip} onChange={(v) => { setTrip(v); setMoving(true); }} allowNone noneLabel="No trip" placeholder="Add to trip…" />
                  </div>
                  <Button size="sm" variant="secondary" disabled={!ids.length || !moving || pending} onClick={() => finish(async () => { const target = trip?.id ?? null; if (await confirmExposure(await previewMoveToTrip(ids, target))) await bulkMoveToTrip(ids, target); })}>Move</Button>
                </>
              )}
              {(
                <>
                  <div className="w-44">
                    <ContainerPicker kind="collection" value={other} onChange={setOther} placeholder="Add to collection…" />
                  </div>
                  <Button size="sm" variant="secondary" disabled={!ids.length || !other || pending} onClick={() => finish(async () => { if (!other) return; if (await confirmExposure(await previewAddToCollection(ids, other.id))) await addToCollection(other.id, ids); })}>Add</Button>
                </>
              )}
              <BulkTrashControl count={ids.length} disabled={!ids.length || pending} onTrash={async (reason, note) => { await bulkTrash(ids, reason, note); setSelected(new Set()); }} />
              <Button variant="ghost" size="sm" onClick={() => { setMode("view"); setSelected(new Set()); }}>Done</Button>
            </>
          )}
          {mode === "arrange" && (
            <>
              {/* A phone cannot drag, so it is told about the arrows instead. */}
              <span className="text-muted pointer-coarse:hidden" data-testid="arrange-hint">Drag photos into order, or use the ‹ › arrows</span>
              <span className="text-muted hidden pointer-coarse:inline" data-testid="arrange-hint-touch">Use the ‹ › arrows on each photo to put them in order</span>
              <Button size="sm" disabled={pending} onClick={() => arrangeAnd(() => reorderCollection(slug, order.map((p) => p.itemId)))}>Save order</Button>
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
              // Firefox refuses to start a drag unless something is put on the dataTransfer, which is why dragging
              // these never worked. Dropping is handled too, rather than relying on dragover alone.
              onDragStart={(e) => { e.dataTransfer.setData("text/plain", p.id); e.dataTransfer.effectAllowed = "move"; setDragging(p.id); }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; moveTo(p.id); }}
              onDrop={(e) => { e.preventDefault(); moveTo(p.id); setDragging(null); }}
              onDragEnd={() => setDragging(null)}
              className={`relative aspect-square rounded-theme overflow-hidden border ${dragging === p.id ? "opacity-50 border-primary" : "border-border"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.thumbUrl} alt="" className="w-full h-full object-cover pointer-events-none" />
              <span className="absolute top-1 left-1 text-[10px] bg-black/60 text-white rounded px-1.5 py-0.5">{i + 1}</span>
              {/* Dragging does not exist on a phone and is awkward with a keyboard, so the same move is a button: at
                  least 24px to aim a mouse at, and a full 44px for a finger. */}
              <span className="absolute inset-x-1 bottom-1 flex justify-between">
                <button type="button" aria-label={`Move ${p.caption ?? p.alt} earlier`} disabled={i === 0} className="inline-flex items-center justify-center min-w-6 min-h-6 pointer-coarse:min-w-11 pointer-coarse:min-h-11 rounded bg-black/60 text-white px-1.5 text-sm pointer-coarse:text-lg disabled:opacity-30" onClick={() => swap(i, i - 1)}>‹</button>
                <button type="button" aria-label={`Move ${p.caption ?? p.alt} later`} disabled={i === order.length - 1} className="inline-flex items-center justify-center min-w-6 min-h-6 pointer-coarse:min-w-11 pointer-coarse:min-h-11 rounded bg-black/60 text-white px-1.5 text-sm pointer-coarse:text-lg disabled:opacity-30" onClick={() => swap(i, i + 1)}>›</button>
              </span>
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

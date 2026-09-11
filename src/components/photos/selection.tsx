"use client";

import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, Select } from "@/components/ui";
import { bulkMoveToTrip } from "@/app/photos/bulk-actions";
import { addToCollection } from "@/app/collections/actions";
import { previewAddToCollection, previewMoveToTrip } from "@/app/photos/exposure-actions";

type Option = { id: string; title: string };
type Ctx = { active: boolean; selected: Set<string>; toggle: (id: string) => void };
const SelectionContext = createContext<Ctx | null>(null);

/** Grids inside a provider read the selection from context when they are not given explicit selection props. */
export function useSelectionContext(): Ctx | null {
  return useContext(SelectionContext);
}

/**
 * Wraps any page of photo grids with a selection mode and a bar of bulk actions (add to trip, add to collection).
 * Both actions preview the exposure change and ask for confirmation when photos would become more visible.
 */
export function SelectionProvider({ trips, collections, children }: { trips: Option[]; collections: Option[]; children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tripId, setTripId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();
  const ids = [...selected];
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const finish = (message: string) => {
    setSelected(new Set());
    setActive(false);
    setNotice(message);
    router.refresh();
  };
  const moveToTrip = () =>
    start(async () => {
      const target = tripId === "__none" ? null : tripId;
      const warnings = await previewMoveToTrip(ids, target);
      if (warnings.length && !window.confirm(`${warnings.join("\n")}\n\nContinue?`)) return;
      await bulkMoveToTrip(ids, target);
      finish(`${ids.length} photo${ids.length === 1 ? "" : "s"} moved.`);
    });
  const addToCol = () =>
    start(async () => {
      const warnings = await previewAddToCollection(ids, collectionId);
      if (warnings.length && !window.confirm(`${warnings.join("\n")}\n\nContinue?`)) return;
      const n = await addToCollection(collectionId, ids);
      finish(`${n} photo${n === 1 ? "" : "s"} added to the collection.`);
    });

  return (
    <SelectionContext.Provider value={{ active, selected, toggle }}>
      <div className="flex flex-wrap items-center gap-2 text-sm mb-4">
        {!active ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => { setActive(true); setNotice(null); }}>Select photos</Button>
            {notice && <span className="text-muted" role="status">{notice}</span>}
          </>
        ) : (
          <>
            <span className="text-muted">{ids.length} selected</span>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>None</Button>
            <span className="mx-1 text-border">|</span>
            <div className="w-44">
              <Select aria-label="Trip to move to" value={tripId} onChange={(e) => setTripId(e.target.value)} className="h-8 text-sm">
                <option value="">Add to trip…</option>
                <option value="__none">No trip</option>
                {trips.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </Select>
            </div>
            <Button size="sm" variant="secondary" disabled={!ids.length || !tripId || pending} onClick={moveToTrip}>Move</Button>
            <div className="w-44">
              <Select aria-label="Collection to add to" value={collectionId} onChange={(e) => setCollectionId(e.target.value)} className="h-8 text-sm">
                <option value="">Add to collection…</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>{c.title}</option>
                ))}
              </Select>
            </div>
            <Button size="sm" variant="secondary" disabled={!ids.length || !collectionId || pending} onClick={addToCol}>Add</Button>
            <Button variant="ghost" size="sm" onClick={() => { setActive(false); setSelected(new Set()); }}>Done</Button>
          </>
        )}
      </div>
      {children}
    </SelectionContext.Provider>
  );
}

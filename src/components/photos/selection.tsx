"use client";

import { createContext, useContext, useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { bulkMoveToTrip } from "@/app/photos/bulk-actions";
import { addToCollection } from "@/app/collections/actions";
import { bulkSetPlace } from "@/app/photos/bulk-actions";
import { PlacePicker, type PlaceValue } from "./PlacePicker";
import { ContainerPicker, type Container } from "@/components/containers/ContainerPicker";
import { mapThemeOf } from "@/lib/map/theme";
import { getTheme } from "@/themes";
import { previewAddToCollection, previewMoveToTrip } from "@/app/photos/exposure-actions";
import { BulkDate } from "./BulkDate";
import { bulkPutInActivity, tripOfSelection } from "@/app/photos/activity-actions";

type Ctx = { active: boolean; selected: Set<string>; toggle: (id: string) => void; /** Take a whole run at once — a timeline day whose dates are all wrong. */ add: (ids: string[]) => void };
const SelectionContext = createContext<Ctx | null>(null);

/** Grids inside a provider read the selection from context when they are not given explicit selection props. */
export function useSelectionContext(): Ctx | null {
  return useContext(SelectionContext);
}

/**
 * Wraps any page of photo grids with a selection mode and a bar of bulk actions (add to trip, add to collection).
 * Both actions preview the exposure change and ask for confirmation when photos would become more visible.
 */
export function SelectionProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [trip, setTrip] = useState<Container | null>(null);
  const [moving, setMoving] = useState(false);
  const [collection, setCollection] = useState<Container | null>(null);
  const [activity, setActivity] = useState<Container | null>(null);
  // Activities belong to one trip, so the picker can only be offered when the selection sits on a single trip.
  const [selectionTrip, setSelectionTrip] = useState<{ key: string; trip: { id: string; title: string } | null } | null>(null);
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [dating, setDating] = useState(false);
  const [place, setPlace] = useState<PlaceValue | null>(null);
  const router = useRouter();
  const ids = [...selected];
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const add = (list: string[]) => {
    setActive(true);
    setNotice(null);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of list) next.add(id);
      return next;
    });
  };
  const key = ids.join(",");
  useEffect(() => {
    if (!active || !key) return;
    let live = true;
    tripOfSelection(key.split(","))
      .then((trip) => { if (live) setSelectionTrip({ key, trip }); })
      .catch(() => {});
    return () => { live = false; };
  }, [active, key]);
  const onOneTrip = selectionTrip && selectionTrip.key === key ? selectionTrip.trip : null;

  const finish = (message: string) => {
    setSelected(new Set());
    setActive(false);
    setPlacing(false);
    setDating(false);
    setActivity(null);
    setNotice(message);
    router.refresh();
  };
  const putInActivity = () =>
    start(async () => {
      if (!activity) return;
      const r = await bulkPutInActivity(ids, activity.id);
      finish(`${r.n} item${r.n === 1 ? "" : "s"} put in ${activity.title}${r.notYours ? `, ${r.notYours} not yours to change` : ""}.`);
    });

  const moveToTrip = () =>
    start(async () => {
      const target = trip?.id ?? null;
      const warnings = await previewMoveToTrip(ids, target);
      if (warnings.length && !window.confirm(`${warnings.join("\n")}\n\nContinue?`)) return;
      await bulkMoveToTrip(ids, target);
      finish(`${ids.length} photo${ids.length === 1 ? "" : "s"} moved.`);
    });
  const applyPlace = () =>
    start(async () => {
      if (!place) return;
      const n = await bulkSetPlace(ids, place.lat, place.lng, place.name);
      setPlacing(false);
      finish(`${n} photo${n === 1 ? "" : "s"} placed.`);
    });
  const addToCol = () =>
    start(async () => {
      if (!collection) return;
      const warnings = await previewAddToCollection(ids, collection.id);
      if (warnings.length && !window.confirm(`${warnings.join("\n")}\n\nContinue?`)) return;
      const n = await addToCollection(collection.id, ids);
      finish(`${n} photo${n === 1 ? "" : "s"} added to the collection.`);
    });

  return (
    <SelectionContext.Provider value={{ active, selected, toggle, add }}>
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
              <ContainerPicker kind="trip" value={trip} onChange={(v) => { setTrip(v); setMoving(true); }} allowNone noneLabel="No trip" placeholder="Add to trip…" />
            </div>
            <Button size="sm" variant="secondary" disabled={!ids.length || !moving || pending} onClick={moveToTrip}>Move</Button>
            <div className="w-44">
              <ContainerPicker kind="collection" value={collection} onChange={setCollection} placeholder="Add to collection…" />
            </div>
            <Button size="sm" variant="secondary" disabled={!ids.length || !collection || pending} onClick={addToCol}>Add</Button>
            <Button size="sm" variant="secondary" disabled={!ids.length || pending} onClick={() => setPlacing((v) => !v)}>Set a place…</Button>
            <Button size="sm" variant="secondary" disabled={!ids.length || pending} onClick={() => setDating((v) => !v)}>Fix dates…</Button>
            {/* The way to file a batch on an activity without dragging one tile at a time. */}
            {onOneTrip && (
              <>
                <div className="w-44">
                  <ContainerPicker kind="activity" tripId={onOneTrip.id} value={activity} onChange={setActivity} placeholder={`Activity on ${onOneTrip.title}…`} />
                </div>
                <Button size="sm" variant="secondary" disabled={!ids.length || !activity || pending} onClick={putInActivity}>Put in</Button>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={() => { setActive(false); setSelected(new Set()); setPlacing(false); setDating(false); }}>Done</Button>
          </>
        )}
      </div>
      {active && placing && (
        <div className="mb-4 rounded-theme border border-border bg-surface p-3 space-y-2 max-w-xl" data-testid="bulk-place">
          <p className="text-sm">Pin the {ids.length} selected photo{ids.length === 1 ? "" : "s"} to one spot.</p>
          <PlacePicker initial={null} theme={mapThemeOf(getTheme(null))} onChange={setPlace} />
          <div className="flex gap-2">
            <Button size="sm" disabled={!place || pending} onClick={applyPlace}>Place them</Button>
            <Button size="sm" variant="ghost" onClick={() => setPlacing(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {active && dating && ids.length > 0 && (
        <BulkDate ids={ids} onDone={(message) => (message ? finish(message) : setDating(false))} />
      )}
      {children}
    </SelectionContext.Provider>
  );
}

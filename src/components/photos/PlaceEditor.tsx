"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { PlacePicker, type PlaceValue } from "./PlacePicker";
import { clearPhotoPlace, confirmPlaceEstimate, setPhotoPlace } from "@/app/photos/[id]/actions";
import type { MapTheme } from "@/lib/map/theme";

const SOURCE: Record<string, string> = { EXIF: "from the camera", TRACK: "from a track", MANUAL: "set by hand", SIDECAR: "from Google Photos", ESTIMATE: "estimated from the photo" };

/** What the helper recognised and how sure it was, kept beside the pin so a guess never passes for a record. */
export type PlaceEstimate = { name: string | null; confidence: number | null; radiusM: number | null; note: string | null; /** EXACT, or CITY/REGION when the spot itself is private and only the area is given. */ precision: string | null };

/** The same wording as the date estimate uses, so "fairly sure" means the same thing everywhere. */
function sureness(confidence: number | null): string {
  return confidence === null ? "" : confidence >= 0.7 ? "fairly sure" : confidence >= 0.4 ? "a guess" : "a rough guess";
}

/**
 * How tightly the guess is pinned, in words a family reads rather than metres. Somewhere private is only ever placed
 * at its town, and the label says so rather than leaving a wide circle to be read as a vague pin.
 */
export function withinLabel(radiusM: number | null, precision?: string | null): string {
  if (precision === "CITY") return "the town, not the exact spot";
  if (precision === "REGION") return "the area, not the exact spot";
  if (radiusM === null) return "";
  if (radiusM < 1000) return `within about ${Math.round(radiusM / 50) * 50} m`;
  if (radiusM < 20_000) return `within about ${Number((radiusM / 1000).toFixed(1))} km`;
  return `somewhere within about ${Math.round(radiusM / 1000)} km`;
}

/** The helper's guess, shown under the pin: the place, how sure it was, and what it recognised. */
export function PlaceProvenance({ estimate, muted }: { estimate: PlaceEstimate; muted: string }) {
  const detail = [sureness(estimate.confidence), withinLabel(estimate.radiusM, estimate.precision)].filter(Boolean).join(" · ");
  return (
    <span className={`block text-xs ${muted}`} data-testid="place-estimate">
      {estimate.name && <span className="block">{estimate.name}{detail && ` · ${detail}`}</span>}
      {estimate.note && <span className="block">{estimate.note}</span>}
    </span>
  );
}

/** "set by Grandma Jo" where the album knows who did it, "set by a family member" where it does not. */
export function sourceLabel(source: string | null, setBy: string | null): string | null {
  if (!source) return null;
  if (source !== "MANUAL") return SOURCE[source] ?? source;
  return setBy ? `set by ${setBy}` : "set by a family member";
}

/** Where an item was taken: shows the current position and its source, and lets a member set or clear it. */
export function PlaceEditor({ photoId, initial, gpsSource, setBy, placeName, estimate, theme, dark = false, onSaved }: { photoId: string; initial: PlaceValue | null; gpsSource: string | null; /** Who pinned it, when a member did. */ setBy?: string | null; /** What the place is called, when the album knows. */ placeName?: string | null; /** What the helper recognised, when the position is its guess. */ estimate?: PlaceEstimate | null; theme: MapTheme; dark?: boolean; onSaved?: (v: { lat: number | null; lng: number | null; gpsSource: string | null; setBy: string | null; placeName: string | null }) => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<{ pos: PlaceValue | null; source: string | null; setBy: string | null; name: string | null }>({ pos: initial, source: gpsSource, setBy: setBy ?? null, name: placeName ?? null });
  const [draft, setDraft] = useState<PlaceValue | null>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const muted = dark ? "text-white/60" : "text-muted";

  const save = () => start(async () => {
    if (!draft) return;
    setMessage(null);
    const fd = new FormData();
    fd.set("lat", String(draft.lat)); fd.set("lng", String(draft.lng));
    if (draft.name) fd.set("name", draft.name);
    const r = await setPhotoPlace(photoId, fd);
    if (!r.ok) { setMessage(r.message); return; }
    setCurrent({ pos: { lat: r.lat!, lng: r.lng! }, source: r.gpsSource, setBy: r.setBy, name: r.placeName });
    setOpen(false);
    onSaved?.(r);
    router.refresh();
  });
  const accept = () => start(async () => {
    setMessage(null);
    const r = await confirmPlaceEstimate(photoId);
    if (!r.ok) { setMessage(r.message); return; }
    setCurrent({ pos: { lat: r.lat!, lng: r.lng! }, source: r.gpsSource, setBy: r.setBy, name: r.placeName });
    onSaved?.(r);
    router.refresh();
  });
  const clear = () => start(async () => {
    const r = await clearPhotoPlace(photoId);
    if (!r.ok) { setMessage(r.message); return; }
    setCurrent({ pos: null, source: null, setBy: null, name: null });
    setDraft(null);
    setOpen(false);
    onSaved?.(r);
    router.refresh();
  });

  return (
    <div className="space-y-2 text-sm" data-testid="place-editor">
      {current.pos ? (
        <p>
          {/* The name leads where there is one: "Jordan Pond" is what a family recognises, the coordinates are only proof. */}
          {current.name ? (
            <>
              <span className="block font-medium" data-testid="place-name">{current.name}</span>
              <span className={`block text-xs ${muted}`}>{current.pos.lat.toFixed(5)}, {current.pos.lng.toFixed(5)}</span>
            </>
          ) : (
            <>{current.pos.lat.toFixed(5)}, {current.pos.lng.toFixed(5)}</>
          )}
          {current.source && <span className={`block text-xs ${muted}`}>{sourceLabel(current.source, current.setBy)}</span>}
          {current.source === "ESTIMATE" && estimate && <PlaceProvenance estimate={estimate} muted={muted} />}
        </p>
      ) : (
        <p className={muted}>No place yet. {gpsSource === null ? "The file has no location and no track covers its time." : ""}</p>
      )}
      {!open ? (
        <div className="flex flex-wrap gap-2">
          {current.source === "ESTIMATE" && <Button size="sm" onClick={accept} disabled={pending}>Use this place</Button>}
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{current.pos ? "Change place" : "Set a place"}</Button>
          {current.pos && <Button size="sm" variant="ghost" onClick={clear} disabled={pending}>Clear</Button>}
        </div>
      ) : (
        <div className="space-y-2">
          <PlacePicker initial={current.pos} theme={theme} onChange={setDraft} dark={dark} />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={pending || !draft}>{pending ? "Saving…" : "Save place"}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setMessage(null); }}>Cancel</Button>
          </div>
        </div>
      )}
      {message && <p role="alert" className={`text-xs ${dark ? "text-amber-300" : "text-red-800"}`}>{message}</p>}
    </div>
  );
}

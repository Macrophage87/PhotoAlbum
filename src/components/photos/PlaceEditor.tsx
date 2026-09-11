"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { PlacePicker, type PlaceValue } from "./PlacePicker";
import { clearPhotoPlace, setPhotoPlace } from "@/app/photos/[id]/actions";
import type { MapTheme } from "@/lib/map/theme";

const SOURCE: Record<string, string> = { EXIF: "from the camera", TRACK: "from a track", MANUAL: "set by a family member", SIDECAR: "from Google Photos" };

/** Where an item was taken: shows the current position and its source, and lets a member set or clear it. */
export function PlaceEditor({ photoId, initial, gpsSource, theme, dark = false, onSaved }: { photoId: string; initial: PlaceValue | null; gpsSource: string | null; theme: MapTheme; dark?: boolean; onSaved?: (v: { lat: number | null; lng: number | null; gpsSource: string | null }) => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<{ pos: PlaceValue | null; source: string | null }>({ pos: initial, source: gpsSource });
  const [draft, setDraft] = useState<PlaceValue | null>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const muted = dark ? "text-white/60" : "text-muted";

  const save = () => start(async () => {
    if (!draft) return;
    setMessage(null);
    const fd = new FormData();
    fd.set("lat", String(draft.lat)); fd.set("lng", String(draft.lng));
    const r = await setPhotoPlace(photoId, fd);
    if (!r.ok) { setMessage(r.message); return; }
    setCurrent({ pos: { lat: r.lat!, lng: r.lng! }, source: r.gpsSource });
    setOpen(false);
    onSaved?.(r);
    router.refresh();
  });
  const clear = () => start(async () => {
    const r = await clearPhotoPlace(photoId);
    if (!r.ok) { setMessage(r.message); return; }
    setCurrent({ pos: null, source: null });
    setDraft(null);
    setOpen(false);
    onSaved?.(r);
    router.refresh();
  });

  return (
    <div className="space-y-2 text-sm" data-testid="place-editor">
      {current.pos ? (
        <p>
          {current.pos.lat.toFixed(5)}, {current.pos.lng.toFixed(5)}
          {current.source && <span className={`block text-xs ${muted}`}>{SOURCE[current.source] ?? current.source}</span>}
        </p>
      ) : (
        <p className={muted}>No place yet. {gpsSource === null ? "The file has no location and no track covers its time." : ""}</p>
      )}
      {!open ? (
        <div className="flex gap-2">
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

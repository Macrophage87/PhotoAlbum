"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { StaticMapTile } from "@/components/map/StaticMapTile";
import { PlaceEditor, PlaceProvenance } from "./PlaceEditor";
import { mapThemeOf } from "@/lib/map/theme";
import { getTheme } from "@/themes";
import { resetPhotoDateToCamera, setPhotoDate } from "@/app/photos/[id]/actions";
import type { PhotoInfo } from "@/app/api/photos/[id]/info/route";

const SOURCE_LABEL: Record<string, string> = { EXIF_OFFSET: "from the camera", EXIF_TZLOOKUP: "from the camera", TRIP_TZ: "from the camera, in the trip's zone", SIDECAR: "from Google Photos", FILE_NAME: "from the file name", EXIF_CREATED: "from the file\u2019s created-date tag, which may be when it was edited", FILE_MTIME: "from the file's modified time", UPLOAD_TIME: "the upload time" };

/** "set by Grandma Jo" where the album knows whose choice it was, "set by a family member" where it does not. */
function dateSourceLabel(source: string, setBy: string | null): string {
  if (source !== "MANUAL") return SOURCE_LABEL[source] ?? source;
  return setBy ? `set by ${setBy}` : "set by a family member";
}

/** "Wed, Aug 12, 2025 · 3:04 PM" in the item's own zone, from the instant and its offset. */
export function formatTaken(takenAt: string, tzOffsetMin: number | null): string {
  const d = new Date(new Date(takenAt).getTime() + (tzOffsetMin ?? 0) * 60_000);
  return d.toLocaleString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The value a datetime-local input wants: the wall-clock time in the item's zone. */
export function wallInputValue(takenAt: string, tzOffsetMin: number | null): string {
  return new Date(new Date(takenAt).getTime() + (tzOffsetMin ?? 0) * 60_000).toISOString().slice(0, 16);
}

/** The panel beside a lightbox image: date, place, caption and description, with date editing and an Edit link for members. */
export function LightboxInfo({ photoId, share }: { photoId: string; share?: { token: string; kind: string } | null }) {
  const [info, setInfo] = useState<PhotoInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // The lightbox mounts this panel afresh per photo (keyed by id), so there is no state to reset here.
  useEffect(() => {
    let live = true;
    const q = share ? `?share=${encodeURIComponent(share.token)}&kind=${encodeURIComponent(share.kind)}` : "";
    fetch(`/api/photos/${photoId}/info${q}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: PhotoInfo) => { if (live) setInfo(j); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [photoId, share]);

  if (failed) return null;
  if (!info) return <div className="text-white/50 text-sm p-4" aria-busy="true">Loading…</div>;

  const apply = (fn: () => Promise<{ ok: true; takenAt: string; tzOffsetMin: number; source: string; setBy: string | null } | { ok: false; message: string }>) =>
    start(async () => {
      setMessage(null);
      const r = await fn();
      if (!r.ok) { setMessage(r.message); return; }
      setInfo((prev) => (prev ? { ...prev, takenAt: r.takenAt, tzOffsetMin: r.tzOffsetMin, takenAtSource: r.source, dateSetBy: r.setBy } : prev));
      setEditingDate(false);
    });

  return (
    <div className="text-sm text-white/90 space-y-3 p-4" data-testid="lightbox-info">
      {info.title && <h2 className="text-lg font-semibold leading-snug">{info.title}</h2>}
      <div>
        <div className="text-white/60 text-xs uppercase tracking-wide">Date</div>
        {info.takenAt ? (
          <p>
            <time dateTime={info.takenAt}>{formatTaken(info.takenAt, info.tzOffsetMin)}</time>
            {info.takenAtSource && <span className="block text-white/50 text-xs">{dateSourceLabel(info.takenAtSource, info.dateSetBy)}</span>}
          </p>
        ) : (
          <p className="text-white/60">Unknown</p>
        )}
        {info.editable && !editingDate && (
          <button type="button" className="text-xs underline underline-offset-2 text-white/70 hover:text-white mt-1" onClick={() => setEditingDate(true)}>Change date</button>
        )}
        {info.editable && editingDate && (
          <form className="mt-2 space-y-2" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); apply(() => setPhotoDate(info.id, fd)); }}>
            <input type="datetime-local" name="takenAt" aria-label="Date taken" defaultValue={info.takenAt ? wallInputValue(info.takenAt, info.tzOffsetMin) : ""} required className="h-8 rounded px-2 bg-white text-black [color-scheme:light] text-sm w-full" />
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={pending} className="px-2 py-1 rounded bg-white text-black text-xs font-medium disabled:opacity-60">Save date</button>
              <button type="button" disabled={pending} onClick={() => apply(() => resetPhotoDateToCamera(info.id))} className="px-2 py-1 rounded border border-white/40 text-xs hover:bg-white/10 disabled:opacity-60">Use camera date</button>
              <button type="button" onClick={() => { setEditingDate(false); setMessage(null); }} className="px-2 py-1 text-xs text-white/70 hover:text-white">Cancel</button>
            </div>
            <p className="text-white/50 text-xs">The time is read in the photo&apos;s own zone. The camera date is what the file itself says.</p>
          </form>
        )}
        {message && <p role="alert" className="text-xs text-amber-300 mt-1">{message}</p>}
      </div>
      {(info.lat !== null && info.lng !== null) || info.editable ? (
        <div>
          <div className="text-white/60 text-xs uppercase tracking-wide mb-1">Place</div>
          {info.lat !== null && info.lng !== null && <StaticMapTile lat={info.lat} lng={info.lng} height={150} />}
          {info.placeName && <p className="text-white/85 mt-1" data-testid="lightbox-place-name">{info.placeName}</p>}
          {info.trip && info.lat !== null && <p className="text-white/60 text-xs mt-1">On <Link href={`/trips/${info.trip.slug}/map`} className="underline underline-offset-2 hover:text-white" onClick={(e) => e.stopPropagation()}>{info.trip.title}</Link></p>}
          {/* A guessed pin says so to everyone who can see it; a member gets the same words inside the editor, with a way to accept it. */}
          {!info.editable && info.placeEstimate && (
            <div className="mt-1">
              <p className="text-white/60 text-xs">Estimated from the photo</p>
              <PlaceProvenance estimate={info.placeEstimate} muted="text-white/50" />
            </div>
          )}
          {info.editable && (
            <div className="mt-2">
              <PlaceEditor photoId={info.id} initial={info.lat !== null && info.lng !== null ? { lat: info.lat, lng: info.lng } : null} gpsSource={info.gpsSource} setBy={info.placeSetBy} placeName={info.placeName} estimate={info.placeEstimate} theme={mapThemeOf(getTheme(info.themeKey))} dark onSaved={(v) => setInfo((prev) => (prev ? { ...prev, lat: v.lat, lng: v.lng, gpsSource: v.gpsSource, placeSetBy: v.setBy, placeName: v.placeName } : prev))} />
            </div>
          )}
        </div>
      ) : null}
      {info.description && (
        <div>
          <div className="text-white/60 text-xs uppercase tracking-wide">Description</div>
          <p className="text-white/85 whitespace-pre-line">{info.description}</p>
        </div>
      )}
      {info.uneditedUrl && (
        <p className="text-white/60 text-xs">
          Cropped or colour-corrected here.{" "}
          <a href={info.uneditedUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-white" onClick={(e) => e.stopPropagation()}>See the original</a>
        </p>
      )}
      {info.uploadedBy && <p className="text-white/50 text-xs">Uploaded by {info.uploadedBy}</p>}
      {info.editable && (
        <Link href={`/photos/${info.id}`} className="inline-block px-3 py-1.5 rounded bg-white/15 hover:bg-white/25 text-white text-sm font-medium" data-testid="lightbox-edit">Edit details</Link>
      )}
    </div>
  );
}

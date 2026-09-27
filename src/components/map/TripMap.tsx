"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MapPayload, MapTrackProps, TrackFeatureProps } from "@/lib/map/geojson";
import type { MapTheme } from "@/lib/map/theme";
import { MapViewDynamic } from "./MapViewDynamic";
import { Lightbox, type LightboxPhoto } from "@/components/photos/Lightbox";
import { ACTIVITY_LABEL } from "@/lib/activities/types";
import type { ActivityType } from "@/generated/prisma/enums";
import { ActivityTypeIcon } from "@/components/activities/ActivityTypeIcon";
import { formatDistance } from "@/lib/time/format";
import { NONE_SLOT, type ColourBy } from "@/lib/map/colour-by";
import { cellFeatures, pointFeatures, useDescribe, useMapData } from "./map-data";

const COLOUR_BY_KEY = "map-colour-by";
const COLOUR_BY_LABEL: Record<ColourBy, string> = { none: "Nothing", day: "Day", activity: "Activity", uploader: "Who uploaded" };

/** A track's ring slot for one way of colouring. */
function trackSlot(t: MapTrackProps, by: Exclude<ColourBy, "none">): number {
  return by === "day" ? t.daySlot : by === "activity" ? t.activitySlot : (t.uploaderSlot ?? NONE_SLOT);
}

export function TripMap({ src, theme, showTripList = false, activityHrefBase, narrowed = false, below }: { src: string; theme: MapTheme; showTripList?: boolean; /** Override the activity link root, e.g. for share pages. */ activityHrefBase?: string; /** Something is being looked for, so an empty map means "no match" rather than "nothing placed yet". */ narrowed?: boolean; /** Shown directly under the map, such as the way to place photos on it. */ below?: ReactNode }) {
  const activityHref = (tripSlug: string, activityId: string) => `${activityHrefBase ?? `/trips/${tripSlug}/activities`}/${activityId}`;
  const { data, error, photos: sent, onViewChange } = useMapData(src);
  const { describe, known } = useDescribe(src);
  // The photographs the lightbox steps through are the ones on the map when it opened, whatever is fetched meanwhile.
  const [lightbox, setLightbox] = useState<{ ids: string[]; index: number } | null>(null);
  const asking = useRef(0);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapPayload["bounds"]>(null);
  // The choice is remembered on this device, so somebody who likes seeing the days keeps seeing them. Read as the
  // state starts rather than after: nothing it affects is drawn until the map's data has arrived, well after hydration.
  const [colourBy, setColourBy] = useState<ColourBy>(() => {
    try {
      const kept = typeof window === "undefined" ? null : localStorage.getItem(COLOUR_BY_KEY);
      return kept === "day" || kept === "activity" || kept === "uploader" ? kept : "none";
    } catch {
      return "none";
    }
  });
  const router = useRouter();

  const chooseColourBy = (value: ColourBy) => {
    setColourBy(value);
    try {
      localStorage.setItem(COLOUR_BY_KEY, value);
    } catch {
      /* not remembered, still applied */
    }
  };

  // Who uploaded what is for members only; the server leaves it out for anybody else, and then so does the choice.
  const canByUploader = Boolean(data?.rings.uploader);
  const by: ColourBy = colourBy === "uploader" && !canByUploader ? "none" : colourBy;
  // The legend and colours are the whole map's, sent once; each photograph and group carries its slot in them.
  const legend = data && by !== "none" ? data.rings[by] : null;
  const pins = useMemo(() => pointFeatures(sent?.points ?? [], legend ? by : "none"), [sent, by, legend]);
  const cells = useMemo(() => cellFeatures(sent?.cells ?? [], legend ? by : "none"), [sent, by, legend]);
  const colouredTracks = useMemo((): MapPayload["tracks"] | null => {
    if (!data || !legend || by === "none") return null;
    // A track takes the colour of what it belongs to, so a walk and the photographs along it match.
    return { ...data.tracks, features: data.tracks.features.map((f) => ({ ...f, properties: { ...f.properties, color: legend.colours[trackSlot(f.properties, by)] } })) };
  }, [data, legend, by]);
  const tracks = (colouredTracks ?? data?.tracks)?.features ?? [];
  const order = useMemo(() => (sent?.points ?? []).map((p) => p[0]), [sent]);
  const photos: LightboxPhoto[] = useMemo(
    () =>
      (lightbox?.ids ?? []).map((id) => {
        const d = known.get(id);
        return { id, mediumUrl: d?.mediumUrl ?? "", width: null, height: null, caption: d?.caption ?? null, alt: d?.caption ?? "Photo" };
      }),
    [lightbox, known],
  );

  /** Open the lightbox on one of these once its picture is known, looking up its neighbours on the way. */
  const show = (ids: string[], index: number) => {
    const n = ids.length;
    const asked = ++asking.current;
    describe([ids[index], ids[(index + 1) % n], ids[(index - 1 + n) % n]])
      .then((found) => {
        if (asked === asking.current && found.has(ids[index])) setLightbox({ ids, index });
      })
      .catch(() => {});
  };

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!data) return <div className="h-[70vh] bg-surface-alt animate-pulse rounded-theme" />;
  const empty = data.total === 0 && data.tracks.features.length === 0;

  return (
    <div className="space-y-2">
      {/* How the photographs are coloured sits right on top of the map, with its key beside it, so the colours are
          explained where they are seen. */}
      {data.total > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="map-colour-by">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Color by</span>
            <select value={by} onChange={(e) => chooseColourBy(e.target.value as ColourBy)} className="h-9 rounded-theme border border-border bg-surface px-2">
              {(["none", "day", "activity", ...(canByUploader ? (["uploader"] as const) : [])] as ColourBy[]).map((v) => (
                <option key={v} value={v}>{COLOUR_BY_LABEL[v]}</option>
              ))}
            </select>
          </label>
          {legend && (
            <ul className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="map-legend">
              {legend.groups.map((g) => (
                <li key={g.slot} className="inline-flex items-center gap-1.5 text-sm" data-slot={g.slot}>
                  <span aria-hidden className="w-3.5 h-3.5 shrink-0 rounded-full border-[3px]" style={{ borderColor: legend.colours[g.slot] }} />
                  <span>{g.label}</span>
                  <span className="text-xs text-muted">{g.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="grid lg:grid-cols-[1fr_18rem] gap-4">
        <div className="space-y-2">
          <div className="h-[70vh] rounded-theme overflow-hidden border border-border relative">
            <MapViewDynamic
              photos={pins}
              cells={cells}
              describe={describe}
              onViewChange={onViewChange}
              tracks={colouredTracks ?? data.tracks}
              rings={Boolean(legend)}
              slotColours={legend?.colours}
              bounds={data.bounds}
              theme={theme}
              highlightTrackId={hover}
              focusBounds={focus}
              onPhotoClick={(id) => {
                const i = order.indexOf(id);
                if (i >= 0) show(order, i);
              }}
              onTrackHover={setHover}
              onTrackClick={(p: TrackFeatureProps) => {
                if (p.activityId) router.push(activityHref(p.tripSlug, p.activityId));
              }}
            />
            {empty && (
              <div className="absolute inset-x-0 top-3 px-3 text-center pointer-events-none">
                <span className="inline-block max-w-md bg-surface/90 text-muted text-sm px-3 py-1.5 rounded-theme border border-border" data-testid={narrowed ? "map-no-matches" : "map-empty"}>
                  {narrowed
                    ? "Nothing with a place on it matches that. A photograph is only on the map once it has somewhere to be."
                    : "Nothing to put on the map here yet. A photo gets its place from the camera, from a track covering the moment it was taken, or from one a family member sets by hand."}
                </span>
              </div>
            )}
          </div>
          {below}
        </div>
        <aside className="space-y-4 lg:max-h-[70vh] overflow-y-auto">
          {showTripList && (
            <div>
              <h3 className="text-sm font-medium text-muted mb-2">Trips</h3>
              <ul className="space-y-1">
                {data.trips.map((t) => (
                  <li key={t.slug} className="flex items-center justify-between gap-2 text-sm">
                    <Link href={`/trips/${t.slug}`} className="hover:underline underline-offset-2 truncate">{t.title}</Link>
                    {t.bounds && <button onClick={() => setFocus(t.bounds)} className="text-xs text-primary hover:underline shrink-0">Show</button>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h3 className="text-sm font-medium text-muted mb-2" data-testid="map-count">
              {tracks.length} track{tracks.length === 1 ? "" : "s"} · {data.total} photo{data.total === 1 ? "" : "s"}
            </h3>
            <ul className="space-y-1">
              {tracks.map((f) => {
                const p = f.properties;
                const inner = (
                  <>
                    {p.activityType ? <ActivityTypeIcon type={p.activityType as ActivityType} className="w-4 h-4 shrink-0" /> : <span className="w-4 h-4 shrink-0 rounded-full border-2 border-dashed" style={{ borderColor: p.color }} />}
                    <span className="truncate">{p.activityTitle ?? p.name}</span>
                    {p.distanceM !== null && p.source !== "GOOGLE" && <span className="ml-auto text-xs text-muted shrink-0">{formatDistance(p.distanceM)}</span>}
                  </>
                );
                const cls = `flex items-center gap-2 text-sm rounded px-2 py-1 ${hover === p.trackId ? "bg-surface-alt" : ""}`;
                return (
                  <li key={p.trackId} onMouseEnter={() => setHover(p.trackId)} onMouseLeave={() => setHover(null)} title={p.activityType ? ACTIVITY_LABEL[p.activityType as ActivityType] : "Location trace"}>
                    {p.activityId ? <Link href={activityHref(p.tripSlug, p.activityId)} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>}
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      </div>
      {lightbox !== null && <Lightbox photos={photos} index={lightbox.index} onClose={() => { asking.current++; setLightbox(null); }} onNavigate={(i) => show(lightbox.ids, i)} />}
    </div>
  );
}

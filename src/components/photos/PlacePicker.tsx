"use client";

import { useState, useTransition, type FormEvent } from "react";
import { MapViewDynamic } from "@/components/map/MapViewDynamic";
import type { MapTheme } from "@/lib/map/theme";
import type { GeocodeHit } from "@/app/api/geocode/route";

const EMPTY = { type: "FeatureCollection" as const, features: [] };

/** A spot, and what it is called when it was chosen by name rather than by pointing at the map. */
export type PlaceValue = { lat: number; lng: number; name?: string | null };

/**
 * Pick a spot: click the map, type coordinates, or look an address up. Purely a chooser; the caller saves. `dark`
 * styles it for the photo viewer's panel.
 */
export function PlacePicker({ initial, theme, onChange, lookup = true, dark = false, height = 220 }: { initial: PlaceValue | null; theme: MapTheme; onChange: (v: PlaceValue) => void; lookup?: boolean; dark?: boolean; height?: number }) {
  const [value, setValue] = useState<PlaceValue | null>(initial);
  const [hits, setHits] = useState<GeocodeHit[] | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [focus, setFocus] = useState<[[number, number], [number, number]] | null>(null);
  const [searching, startSearch] = useTransition();
  const [latText, setLatText] = useState(initial ? String(initial.lat) : "");
  const [lngText, setLngText] = useState(initial ? String(initial.lng) : "");
  const muted = dark ? "text-white/60" : "text-muted";
  const input = `h-8 rounded px-2 text-sm border ${dark ? "bg-white text-black border-white/30" : "border-border bg-surface"}`;

  // A name belongs to a spot, not to the photo: moving the pin or typing coordinates drops it, because those
  // coordinates are no longer the place that was named.
  const pick = (v: PlaceValue, fly = false) => {
    const rounded = { lat: Math.round(v.lat * 1e6) / 1e6, lng: Math.round(v.lng * 1e6) / 1e6, name: v.name ?? null };
    setValue(rounded);
    setLatText(String(rounded.lat));
    setLngText(String(rounded.lng));
    if (fly) setFocus([[rounded.lng - 0.01, rounded.lat - 0.006], [rounded.lng + 0.01, rounded.lat + 0.006]]);
    onChange(rounded);
  };
  const typed = () => {
    const lat = Number(latText), lng = Number(lngText);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) pick({ lat, lng }, true);
  };
  const search = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get("q") ?? "").trim();
    if (q.length < 2) return;
    startSearch(async () => {
      setLookupError(null);
      try {
        const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { credentials: "same-origin" });
        const j = (await r.json()) as { hits: GeocodeHit[]; error?: string; disabled?: boolean };
        if (j.disabled) { setLookupError("Address lookup is turned off on this server; click the map instead."); setHits([]); return; }
        if (!r.ok) { setLookupError("Lookup is not answering right now; click the map instead."); setHits([]); return; }
        setHits(j.hits);
        if (j.hits.length === 0) setLookupError("Nothing found for that; try a town or a landmark.");
      } catch {
        setLookupError("Lookup is not answering right now; click the map instead.");
      }
    });
  };
  const bounds: [[number, number], [number, number]] | null = value ? [[value.lng - 0.01, value.lat - 0.006], [value.lng + 0.01, value.lat + 0.006]] : null;

  return (
    <div className="space-y-2" data-testid="place-picker">
      {lookup && (
        <form onSubmit={search} className="flex gap-2">
          <input name="q" aria-label="Look up a place" placeholder="Town, landmark or address" className={`${input} flex-1 min-w-0`} />
          <button type="submit" disabled={searching} className={`px-2 py-1 rounded text-xs font-medium ${dark ? "bg-white text-black" : "bg-primary text-primary-fg"} disabled:opacity-60`}>{searching ? "Looking…" : "Look up"}</button>
        </form>
      )}
      {hits && hits.length > 0 && (
        <ul className={`text-xs divide-y ${dark ? "divide-white/10" : "divide-border"} max-h-32 overflow-y-auto rounded border ${dark ? "border-white/20" : "border-border"}`} aria-label="Places found">
          {hits.map((h) => (
            <li key={`${h.lat},${h.lng}`}>
              <button type="button" className={`w-full text-left px-2 py-1.5 ${dark ? "hover:bg-white/10" : "hover:bg-surface-alt"}`} onClick={() => { pick({ lat: h.lat, lng: h.lng, name: h.label }, true); setHits(null); }}>{h.label}</button>
            </li>
          ))}
        </ul>
      )}
      {lookupError && <p className={`text-xs ${dark ? "text-amber-300" : "text-amber-800"}`} role="status">{lookupError}</p>}
      <div style={{ height }} className="rounded-theme overflow-hidden border border-white/10">
        <MapViewDynamic photos={EMPTY} tracks={EMPTY} bounds={bounds} theme={theme} className="w-full h-full" marker={value} focusBounds={focus} onMapClick={(pos) => pick(pos)} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={muted}>Or type:</span>
        <input aria-label="Latitude" value={latText} onChange={(e) => setLatText(e.target.value)} onBlur={typed} placeholder="Latitude" className={`${input} w-28`} />
        <input aria-label="Longitude" value={lngText} onChange={(e) => setLngText(e.target.value)} onBlur={typed} placeholder="Longitude" className={`${input} w-28`} />
        <span className={muted}>Click the map to move the pin.</span>
      </div>
    </div>
  );
}

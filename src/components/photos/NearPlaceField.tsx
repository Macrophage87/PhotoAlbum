"use client";

import { useState } from "react";
import { Button, Input, Select } from "@/components/ui";
import { RADIUS_CHOICES, type NearFilter } from "@/lib/photos/picker-filter";
import type { GeocodeHit } from "@/app/api/geocode/route";

/**
 * "Within so many miles of somewhere."
 *
 * A member knows the place by its name, not by its coordinates, so this looks the name up and keeps the point it
 * found in hidden fields the form submits. The lookup goes through the album's own server, never from the browser
 * to an outside service, and nothing about any photograph travels with it.
 */
export function NearPlaceField({ value }: { value: NearFilter | null }) {
  const [query, setQuery] = useState(value?.label ?? "");
  const [point, setPoint] = useState<{ lat: number; lng: number; label: string } | null>(value ? { lat: value.lat, lng: value.lng, label: value.label ?? "" } : null);
  const [hits, setHits] = useState<GeocodeHit[] | null>(null);
  const [state, setState] = useState<"idle" | "looking" | "nothing" | "unavailable">("idle");

  const look = async () => {
    const q = query.trim();
    if (q.length < 2) return;
    setState("looking");
    setHits(null);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const body = (await res.json()) as { hits?: GeocodeHit[]; disabled?: boolean };
      if (body.disabled) return setState("unavailable");
      const found = body.hits ?? [];
      setHits(found);
      setState(found.length ? "idle" : "nothing");
    } catch {
      setState("unavailable");
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          name="place"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPoint(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void look(); } }}
          placeholder="Near a place…"
          aria-label="Near a place"
          className="h-9 w-48"
          data-testid="near-place"
        />
        <Button type="button" variant="ghost" size="sm" onClick={look} disabled={state === "looking"} data-testid="near-lookup">
          {state === "looking" ? "Looking…" : "Find"}
        </Button>
        <Select name="miles" defaultValue={String(value?.miles ?? 25)} aria-label="How far" className="h-9 w-28 text-sm">
          {RADIUS_CHOICES.map((m) => (
            <option key={m} value={m}>within {m} mi</option>
          ))}
        </Select>
        {/* What the form actually submits: the point, not the words that found it. */}
        <input type="hidden" name="lat" value={point?.lat ?? ""} />
        <input type="hidden" name="lng" value={point?.lng ?? ""} />
      </div>

      {state === "nothing" && <p className="text-xs text-muted">Nothing found by that name.</p>}
      {state === "unavailable" && <p className="text-xs text-muted">Looking up places is not switched on, so a place has to be picked on the map instead.</p>}
      {point && <p className="text-xs text-muted" data-testid="near-chosen">Around <b>{point.label || `${point.lat.toFixed(3)}, ${point.lng.toFixed(3)}`}</b>.</p>}
      {hits && hits.length > 0 && !point && (
        <ul className="text-xs space-y-0.5">
          {hits.map((h) => (
            <li key={`${h.lat},${h.lng}`}>
              <button
                type="button"
                className="text-primary underline underline-offset-2 text-left"
                onClick={() => { setPoint({ lat: h.lat, lng: h.lng, label: h.label }); setQuery(h.label); setHits(null); }}
              >
                {h.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import type { MediaKind } from "@/generated/prisma/enums";

/**
 * Narrowing the album down when picking photographs to put somewhere.
 *
 * This is a different job from narrowing a gallery. A gallery is one trip or one collection and you are looking for
 * something you know is in it; here you are looking through everything the family has ever uploaded for the ones
 * that belong somewhere new — so the questions worth asking are about when and where a photograph was taken, and
 * whether anything has claimed it yet.
 */
export type NearFilter = { lat: number; lng: number; miles: number; label: string | null };

export type PickerFilter = {
  /** Words: captions, titles, notes, the helper's description and tags, the place written on it, the file's name. */
  q: string | null;
  /** A trip's id, or "none" for the ones on no trip at all. */
  trip: string | null;
  /** Inclusive days, as YYYY-MM-DD. */
  from: string | null;
  to: string | null;
  kind: MediaKind | null;
  uploaderId: string | null;
  /** Only the ones nothing has claimed: on no trip, and in no collection. */
  loose: boolean;
  near: NearFilter | null;
};

export const NO_PICKER_FILTER: PickerFilter = { q: null, trip: null, from: null, to: null, kind: null, uploaderId: null, loose: false, near: null };

export const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: MediaKind[] = ["PHOTO", "VIDEO", "EXTERNAL_VIDEO", "SCAN"];

/** The distances offered. A family means "at the house", "around the town", "on that trip". */
export const RADIUS_CHOICES = [1, 5, 25, 100, 500] as const;
export const DEFAULT_RADIUS = 25;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  const t = typeof s === "string" ? s.trim() : "";
  return t ? t : null;
};

export function parsePickerFilter(sp: Params): PickerFilter {
  const q = one(sp.q);
  const kind = one(sp.kind);
  const lat = Number(one(sp.lat));
  const lng = Number(one(sp.lng));
  const miles = Number(one(sp.miles));
  const from = one(sp.from);
  const to = one(sp.to);
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && one(sp.lat) !== null && one(sp.lng) !== null;
  return {
    q: q ? q.replace(/\s+/g, " ").slice(0, 200) : null,
    trip: one(sp.trip),
    from: from && DAY.test(from) ? from : null,
    to: to && DAY.test(to) ? to : null,
    kind: kind && (KINDS as string[]).includes(kind) ? (kind as MediaKind) : null,
    uploaderId: one(sp.uploader),
    loose: one(sp.loose) === "1",
    near: hasPoint ? { lat, lng, miles: RADIUS_CHOICES.includes(miles as (typeof RADIUS_CHOICES)[number]) ? miles : DEFAULT_RADIUS, label: one(sp.place) } : null,
  };
}

export function pickerFilterIsActive(f: PickerFilter): boolean {
  return Boolean(f.q || f.trip || f.from || f.to || f.kind || f.uploaderId || f.loose || f.near);
}

/** Back into a URL, so paging and the "load more" button keep the narrowing. */
export function pickerFilterQuery(f: PickerFilter): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.trip) p.set("trip", f.trip);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.kind) p.set("kind", f.kind);
  if (f.uploaderId) p.set("uploader", f.uploaderId);
  if (f.loose) p.set("loose", "1");
  if (f.near) {
    p.set("lat", String(f.near.lat));
    p.set("lng", String(f.near.lng));
    p.set("miles", String(f.near.miles));
    if (f.near.label) p.set("place", f.near.label);
  }
  return p.toString();
}

export const MILE_IN_METRES = 1609.344;

/**
 * The box of latitudes and longitudes that could possibly hold anything within this many miles.
 *
 * A box is not a circle, so this is a first sieve only: it is what lets the database use its index on the two
 * columns instead of measuring the distance to every photograph in the album, and the real distance is then
 * measured on what the box lets through. A degree of latitude is the same length everywhere; a degree of longitude
 * shrinks towards the poles, which is what the cosine is for — and near enough the pole it stops meaning anything,
 * so the box opens out to every longitude there is.
 */
export function boundingBox(lat: number, lng: number, miles: number): { latMin: number; latMax: number; lngMin: number; lngMax: number } {
  // A degree along a great circle of the same mean radius the distance itself is measured with. Using the wider
  // equatorial figure here would make the box a hair narrower than the circle it is meant to contain, and a sieve
  // that lets too much through costs nothing while one that holds something back loses it for good — hence the
  // margin on top as well.
  const metres = miles * MILE_IN_METRES * 1.001;
  const perDegree = (2 * Math.PI * 6_371_008.8) / 360;
  const dLat = metres / perDegree;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLng = Math.abs(cos) < 0.01 ? 180 : metres / (perDegree * Math.abs(cos));
  return {
    latMin: Math.max(-90, lat - dLat),
    latMax: Math.min(90, lat + dLat),
    lngMin: Math.max(-180, lng - dLng),
    lngMax: Math.min(180, lng + dLng),
  };
}

/** How the filter reads back to a member, so a short list of results is never a mystery. */
export function describePickerFilter(f: PickerFilter): string[] {
  const parts: string[] = [];
  if (f.q) parts.push(`words: ${f.q}`);
  if (f.loose) parts.push("in no trip and no collection");
  if (f.from && f.to) parts.push(`${f.from} to ${f.to}`);
  else if (f.from) parts.push(`from ${f.from}`);
  else if (f.to) parts.push(`up to ${f.to}`);
  if (f.near) parts.push(`within ${f.near.miles} ${f.near.miles === 1 ? "mile" : "miles"} of ${f.near.label ?? `${f.near.lat.toFixed(3)}, ${f.near.lng.toFixed(3)}`}`);
  return parts;
}

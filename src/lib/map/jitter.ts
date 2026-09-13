/** A little over a metre: two photos rounded to the same key are on the same spot as far as anyone can tell. */
const KEY_DECIMALS = 5;
/** How far apart the spread pushes them. Small enough that the pins still read as one place, big enough to click. */
export const JITTER_STEP_M = 7;
/** The golden angle, which spreads successive points around a centre without them lining up into spokes. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const M_PER_DEG_LAT = 111_320;

export type Placed = { id: string; lat: number; lng: number };

/**
 * Photos pinned to exactly the same spot hide one another: only the top pin can be clicked, and the rest may as well
 * not be on the map. It happens often here — a bulk "set a place", a place the helper could only put at a town, a
 * burst from one tripod — so overlapping pins are spread on a small spiral around the real spot.
 *
 * The first photo of a group keeps the true position and the others fan out around it, ordered by id so a photo sits
 * in the same place on every load. This moves pins, never the stored position: what the album knows about where a
 * photo was taken is untouched, and the item's own page still shows the real coordinates.
 */
export function spreadOverlapping<T extends Placed>(points: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const p of points) {
    const key = `${p.lat.toFixed(KEY_DECIMALS)},${p.lng.toFixed(KEY_DECIMALS)}`;
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  const moved = new Map<string, { lat: number; lng: number }>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Near the poles a degree of longitude is almost nothing, so fall back to the latitude scale rather than divide by ~0.
    const cos = Math.cos((ordered[0].lat * Math.PI) / 180);
    const mPerDegLng = M_PER_DEG_LAT * (Math.abs(cos) < 0.01 ? 0.01 : cos);
    ordered.forEach((p, i) => {
      if (i === 0) return;
      const radius = JITTER_STEP_M * Math.sqrt(i);
      const angle = i * GOLDEN_ANGLE;
      moved.set(p.id, {
        lat: p.lat + (radius * Math.sin(angle)) / M_PER_DEG_LAT,
        lng: p.lng + (radius * Math.cos(angle)) / mPerDegLng,
      });
    });
  }
  if (!moved.size) return points;
  return points.map((p) => {
    const m = moved.get(p.id);
    return m ? { ...p, lat: m.lat, lng: m.lng } : p;
  });
}

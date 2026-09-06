export type Bounds = { minLat: number; maxLat: number; minLng: number; maxLng: number };

export function boundsOf(points: { lat: number; lng: number }[]): Bounds | null {
  if (!points.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

export function mergeBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  return { minLat: Math.min(a.minLat, b.minLat), maxLat: Math.max(a.maxLat, b.maxLat), minLng: Math.min(a.minLng, b.minLng), maxLng: Math.max(a.maxLng, b.maxLng) };
}

export function isValidCoord(lat: unknown, lng: unknown): lat is number {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

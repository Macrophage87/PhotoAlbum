/** A latitude/longitude pair typed or clicked by a member: finite, in range, not the (0, 0) sentinel, rounded to a metre. */
export function parseLatLng(latRaw: unknown, lngRaw: unknown): { lat: number; lng: number } | null {
  const lat = Number(String(latRaw ?? "").trim());
  const lng = Number(String(lngRaw ?? "").trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

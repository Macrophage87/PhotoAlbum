import tzlookup from "tz-lookup";

/** IANA zone for a coordinate, or null when the lookup fails (e.g. invalid coords). */
export function timezoneForCoords(lat: number, lng: number): string | null {
  try {
    return tzlookup(lat, lng);
  } catch {
    return null;
  }
}

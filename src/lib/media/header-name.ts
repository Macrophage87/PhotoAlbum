/**
 * A file name sent in a request header, which the browser percent-encodes. A malformed one (`%E0.gpx`) is the
 * caller's mistake, so it comes back as null for the route to answer with a 400, rather than throwing into a 500.
 */
export function decodeHeaderName(raw: string | null): string | null {
  try {
    return decodeURIComponent(raw ?? "");
  } catch {
    return null;
  }
}

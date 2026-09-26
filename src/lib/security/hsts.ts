export const HSTS_HEADER = "Strict-Transport-Security";

/** HSTS_INCLUDE_SUBDOMAINS read the way src/lib/env.ts reads a flag, without validating the whole environment. */
export function hstsIncludesSubdomains(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase());
}

/**
 * The HSTS value for an album served over https, or null. It is decided from APP_URL when the server runs (not at
 * build, where the address is unknown), and never for plain http so local development and the e2e server are
 * not pinned to https by a browser that remembers it.
 */
export function hstsValue(appUrl: string | undefined, includeSubDomains = false): string | null {
  if (!appUrl) return null;
  try {
    if (new URL(appUrl).protocol !== "https:") return null;
    // Subdomains only on request (HSTS_INCLUDE_SUBDOMAINS): the album may sit under a name whose other hosts are
    // not all on https yet, and a browser would then refuse them for a year.
    return includeSubDomains ? "max-age=31536000; includeSubDomains" : "max-age=31536000";
  } catch {
    return null;
  }
}

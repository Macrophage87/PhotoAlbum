export const HSTS_HEADER = "Strict-Transport-Security";

/**
 * The HSTS value for an album served over https, or null. It is decided from APP_URL when the server runs (not at
 * build, where the address is unknown), and never for plain http so local development and the e2e server are
 * not pinned to https by a browser that remembers it.
 */
export function hstsValue(appUrl: string | undefined): string | null {
  if (!appUrl) return null;
  try {
    return new URL(appUrl).protocol === "https:" ? "max-age=31536000; includeSubDomains" : null;
  } catch {
    return null;
  }
}

/**
 * Whether a state-changing request was sent by the album's own pages. Browsers label every request with
 * Sec-Fetch-Site; older ones at least send Origin on a POST, which must then name this album (APP_URL, or the host
 * the request came to). A request carrying neither did not come from a browser page, so it cannot be a forged one.
 */
export function isSameOriginRequest(headers: Headers, appUrl: string): boolean {
  const site = headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = headers.get("origin");
  if (!origin) return true;
  if (origin === "null") return false;
  try {
    const o = new URL(origin);
    if (o.origin === new URL(appUrl).origin) return true;
    const host = headers.get("host");
    return Boolean(host) && o.host === host;
  } catch {
    return false;
  }
}

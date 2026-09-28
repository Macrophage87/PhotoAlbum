import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, CSP_HEADER, CSP_REPORT_ONLY_HEADER } from "@/lib/security/csp";
import { HSTS_HEADER, hstsIncludesSubdomains, hstsValue } from "@/lib/security/hsts";
import { looksLikeSessionToken, SESSION_COOKIE, SESSION_REFRESH_MS, sessionCookieOptions } from "@/lib/auth/session-cookie";
import { envFlag } from "@/lib/env-flag";

/** Paths that always need a member: anonymous requests are bounced to sign-in. Real authorization happens per page/action/route. */
const PROTECTED = [/^\/upload$/, /^\/admin(\/|$)/, /^\/trips\/new$/, /^\/trips\/[^/]+\/(settings|import|place)$/, /^\/photos(\/|$)/, /^\/collections\/new$/, /^\/collections\/[^/]+\/settings$/, /^\/privacy$/, /^\/review$/, /^\/people(\/|$)/, /^\/graph$/, /^\/favorites$/];

/**
 * The jobs on every page request: the optimistic sign-in redirect for member-only paths, a per-request nonce
 * for the Content Security Policy (Next picks the nonce up from the request header for its own scripts), HSTS on
 * an https album, and keeping the session cookie's expiry sliding along with the session itself.
 */
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  const hsts = hstsValue(process.env.APP_URL, hstsIncludesSubdomains(process.env.HSTS_INCLUDE_SUBDOMAINS));
  if (!session && PROTECTED.some((re) => re.test(path))) {
    const url = new URL("/auth/signin", request.url);
    url.searchParams.set("next", path + request.nextUrl.search);
    const redirect = NextResponse.redirect(url);
    if (hsts) redirect.headers.set(HSTS_HEADER, hsts);
    return redirect;
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp({ nonce, dev: process.env.NODE_ENV === "development", tileUrl: process.env.NEXT_PUBLIC_TILE_URL, styleUrl: process.env.NEXT_PUBLIC_MAP_STYLE_URL, glyphsUrl: process.env.NEXT_PUBLIC_MAP_GLYPHS_URL });
  // Read as env.ts reads it, so CSP_REPORT_ONLY=yes (or on) reports here just as the rest of the app takes it to.
  const headerName = envFlag(process.env.CSP_REPORT_ONLY) ? CSP_REPORT_ONLY_HEADER : CSP_HEADER;
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(CSP_HEADER, csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(headerName, csp);
  if (hsts) response.headers.set(HSTS_HEADER, hsts);
  // The database slides a session's expiry while it is used, but only a response can move the cookie's, and pages
  // cannot set cookies: so each page visit re-issues the same cookie, for no longer than the row is sure to last
  // (the page's own session read slides it). The database stays the judge of whether it is still good. Only on GET
  // and away from /auth: a POST or a sign-in page may be the sign-out or sign-in that replaces this cookie.
  // Deliberately without asking the database whether the token is still good. The proxy runs on Node and could, but
  // that is a second session query on every page load, and carrying a dead token forward gives nothing away: it is
  // only ever the browser's own cookie handed back to it, and every page, action and route still looks the token up
  // (readSessionUser) and treats an unknown or expired one as signed out. The cost is that a dead cookie is kept
  // alive too, so member-only paths reach the page's own sign-in redirect (requireUser) rather than the one above.
  if (request.method === "GET" && !/^\/auth(\/|$)/.test(path) && looksLikeSessionToken(session)) {
    response.cookies.set(SESSION_COOKIE, session, sessionCookieOptions(new Date(Date.now() + SESSION_REFRESH_MS)));
  }
  return response;
}

export const config = {
  // Every page, but not the API, static assets, the service worker or files with an extension.
  matcher: [{ source: "/((?!api/|_next/static|_next/image|maplibre/|icons/|sw\\.js|.*\\..*).*)", missing: [{ type: "header", key: "next-router-prefetch" }] }],
};

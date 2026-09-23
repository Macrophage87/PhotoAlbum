import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, CSP_HEADER, CSP_REPORT_ONLY_HEADER } from "@/lib/security/csp";

/** Paths that always need a member: anonymous requests are bounced to sign-in. Real authorization happens per page/action/route. */
const PROTECTED = [/^\/upload$/, /^\/admin(\/|$)/, /^\/trips\/new$/, /^\/trips\/[^/]+\/(settings|import|place)$/, /^\/photos(\/|$)/, /^\/collections\/new$/, /^\/collections\/[^/]+\/settings$/, /^\/privacy$/, /^\/review$/, /^\/people(\/|$)/, /^\/graph$/, /^\/favorites$/];

/**
 * Two jobs on every page request: the optimistic sign-in redirect for member-only paths, and a per-request nonce
 * for the Content Security Policy (Next picks the nonce up from the request header for its own scripts).
 */
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const hasSession = Boolean(request.cookies.get("session")?.value);
  if (!hasSession && PROTECTED.some((re) => re.test(path))) {
    const url = new URL("/auth/signin", request.url);
    url.searchParams.set("next", path + request.nextUrl.search);
    return NextResponse.redirect(url);
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp({ nonce, dev: process.env.NODE_ENV === "development", tileUrl: process.env.NEXT_PUBLIC_TILE_URL, styleUrl: process.env.NEXT_PUBLIC_MAP_STYLE_URL, glyphsUrl: process.env.NEXT_PUBLIC_MAP_GLYPHS_URL });
  const headerName = process.env.CSP_REPORT_ONLY === "true" || process.env.CSP_REPORT_ONLY === "1" ? CSP_REPORT_ONLY_HEADER : CSP_HEADER;
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(CSP_HEADER, csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(headerName, csp);
  return response;
}

export const config = {
  // Every page, but not the API, static assets, the service worker or files with an extension.
  matcher: [{ source: "/((?!api/|_next/static|_next/image|maplibre/|icons/|sw\\.js|.*\\..*).*)", missing: [{ type: "header", key: "next-router-prefetch" }] }],
};

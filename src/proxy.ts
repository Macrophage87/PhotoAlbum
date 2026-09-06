import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic check only: paths that always need a member get bounced to sign-in when
 * no session cookie is present. Real authorization happens in each page/action/route
 * via getViewer()/canViewTrip().
 */
export function proxy(request: NextRequest) {
  const hasSession = Boolean(request.cookies.get("session")?.value);
  if (hasSession) return NextResponse.next();
  const url = new URL("/auth/signin", request.url);
  url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/upload", "/admin/:path*", "/trips/new", "/trips/:slug/settings", "/trips/:slug/import", "/photos/:path*"],
};

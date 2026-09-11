import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { getViewer } from "@/lib/auth/viewer";
import { authorizationUrl, googleConfigured } from "@/lib/google/oauth";
import { safeNextPath } from "@/lib/auth/tokens";

export const dynamic = "force-dynamic";

/** Start the Google consent flow. The state cookie ties the callback to this browser. */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (viewer.kind !== "user") return Response.redirect(new URL("/auth/signin?next=/upload", request.url), 303);
  if (!googleConfigured()) return new Response("Google Photos is not configured", { status: 404 });
  const url = new URL(request.url);
  // Same-site paths only: the callback redirects here after Google's consent screen, so it must never leave the album.
  const next = safeNextPath(url.searchParams.get("next"), "/upload");
  const state = randomBytes(24).toString("base64url");
  const store = await cookies();
  store.set("google_oauth_state", `${state}:${next}`, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/google", maxAge: 600 });
  return Response.redirect(authorizationUrl(state), 303);
}

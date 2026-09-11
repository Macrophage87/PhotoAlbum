import { cookies } from "next/headers";
import { getViewer } from "@/lib/auth/viewer";
import { exchangeCode, googleConfigured, PICKER_SCOPE } from "@/lib/google/oauth";
import { storeRefreshToken } from "@/lib/google/account";

export const dynamic = "force-dynamic";

/** Google sends the member back here; the code is exchanged server-side and only the encrypted refresh token is kept. */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (viewer.kind !== "user") return Response.redirect(new URL("/auth/signin", request.url), 303);
  if (!googleConfigured()) return new Response("Google Photos is not configured", { status: 404 });
  const url = new URL(request.url);
  const store = await cookies();
  const saved = store.get("google_oauth_state")?.value ?? "";
  store.delete({ name: "google_oauth_state", path: "/api/google" });
  const sep = saved.indexOf(":");
  const [state, next] = sep > 0 ? [saved.slice(0, sep), saved.slice(sep + 1)] : ["", "/upload"];
  const back = (q: string) => Response.redirect(new URL(`${next}${next.includes("?") ? "&" : "?"}google=${q}`, request.url), 303);
  if (!state || url.searchParams.get("state") !== state) return back("state");
  if (url.searchParams.get("error")) return back("denied");
  const code = url.searchParams.get("code");
  if (!code) return back("denied");
  try {
    const t = await exchangeCode(code);
    if (t.scope && !t.scope.split(" ").includes(PICKER_SCOPE)) return back("scope");
    await storeRefreshToken(viewer.user.id, t.refreshToken);
    return back("connected");
  } catch (err) {
    console.error("[google] code exchange failed", err instanceof Error ? err.message : err);
    return back("failed");
  }
}

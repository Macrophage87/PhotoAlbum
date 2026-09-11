import { env } from "@/lib/env";
import { getViewer } from "@/lib/auth/viewer";

export type GeocodeHit = { label: string; lat: number; lng: number };

/**
 * Address lookup for "Set a place", members only. The query goes to the configured Nominatim-compatible endpoint from
 * the server (never from the browser), with the album's own identification as that service's policy asks; nothing
 * about the photo travels with it. Answers are cached briefly so repeated searches for one place cost one request.
 */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env();
  if (!e.GEOCODER_ENABLED) return Response.json({ hits: [], disabled: true });
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 200);
  if (q.length < 2) return Response.json({ hits: [] });
  const u = new URL(e.GEOCODER_URL);
  u.searchParams.set("q", q);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("limit", "6");
  u.searchParams.set("addressdetails", "0");
  try {
    const res = await fetch(u, { headers: { "user-agent": `FamilyAlbum/1.0 (${new URL(e.APP_URL).host})`, accept: "application/json", "accept-language": "en" }, signal: AbortSignal.timeout(8000), next: { revalidate: 3600 } });
    if (!res.ok) return Response.json({ hits: [], error: `lookup failed (${res.status})` }, { status: 502 });
    const rows = (await res.json()) as { display_name?: string; lat?: string; lon?: string }[];
    const hits: GeocodeHit[] = rows
      .map((r) => ({ label: r.display_name ?? "", lat: Number(r.lat), lng: Number(r.lon) }))
      .filter((h) => h.label && Number.isFinite(h.lat) && Number.isFinite(h.lng));
    return Response.json({ hits }, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch {
    return Response.json({ hits: [], error: "lookup unavailable" }, { status: 502 });
  }
}

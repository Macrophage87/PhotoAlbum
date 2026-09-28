import { getViewer } from "@/lib/auth/viewer";
import { decodePoints } from "@/lib/tracks/encode";
import { loadViewableTrack } from "@/lib/map/access";

/** Full-resolution columnar points for charts and the hover marker. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await getViewer();
  const track = await loadViewableTrack(viewer, id);
  if (!track) return Response.json({ error: "Not found" }, { status: 404 });
  const col = decodePoints(track.pointsBlob);
  // Opened by a link (the trip's or an activity's): a link can be withdrawn, so nothing is kept that would outlive
  // it. Otherwise never cacheable by a shared cache, even for a public trip: a trip made private again (say, once
  // somebody notices the track starts at the house) must stop being served at once, not an hour later from a proxy.
  const cache = track.viaLink ? "private, no-store" : "private, max-age=3600";
  return Response.json(
    { id: track.id, startTime: track.startTime.toISOString(), timezone: track.trip.timezone, points: col },
    { headers: { "Cache-Control": cache } },
  );
}

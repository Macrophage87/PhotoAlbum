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
  return Response.json(
    { id: track.id, startTime: track.startTime.toISOString(), timezone: track.trip.timezone, points: col },
    { headers: { "Cache-Control": `${track.trip.visibility === "PUBLIC" ? "public" : "private"}, max-age=3600` } },
  );
}

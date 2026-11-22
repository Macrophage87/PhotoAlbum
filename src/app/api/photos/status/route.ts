import { db } from "@/lib/db";
import { getApiViewer } from "@/lib/auth/viewer";
import { photoUrl } from "@/lib/photos/urls";

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Poll endpoint for the uploader: ?ids=a,b,c
 *
 * With ?sha256=<hex> it answers one question instead: does the album already hold this exact file? The phone app
 * asks before sending, so a photo the album has is not sent over the mobile network again just to be recognised
 * once it has all arrived. `have` is null when it does not.
 */
export async function GET(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const sha256 = new URL(request.url).searchParams.get("sha256");
  if (sha256 !== null) {
    if (!SHA256.test(sha256)) return Response.json({ error: "Bad hash" }, { status: 400 });
    // The same rule as an upload's own check: the oldest live copy is the one the album kept.
    const have = await db.photo.findFirst({
      where: { contentHash: sha256, trashedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true, uploaderId: true },
    });
    return Response.json({ have: have ? { id: have.id, status: have.status, mine: have.uploaderId === viewer.user.id } : null });
  }
  const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 200);
  const photos = await db.photo.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, error: true, width: true, height: true, updatedAt: true, imageVersion: true, tripId: true, lat: true, lng: true, gpsSource: true, takenAt: true, trip: { select: { slug: true, title: true } } },
  });
  return Response.json({
    photos: photos.map((p) => ({
      id: p.id,
      status: p.status,
      error: p.error,
      width: p.width,
      height: p.height,
      thumbUrl: p.status === "READY" ? photoUrl(p, "thumb") : null,
      // Where and when the album has put it, so whoever sent it can see its place was read from the file itself.
      lat: p.lat,
      lng: p.lng,
      gpsSource: p.gpsSource,
      takenAt: p.takenAt,
      trip: p.trip ? { slug: p.trip.slug, title: p.trip.title } : null,
    })),
  });
}

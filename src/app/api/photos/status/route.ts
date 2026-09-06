import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { photoUrl } from "@/lib/photos/urls";

/** Poll endpoint for the uploader: ?ids=a,b,c */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 200);
  const photos = await db.photo.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, error: true, width: true, height: true, updatedAt: true, tripId: true, trip: { select: { slug: true, title: true } } },
  });
  return Response.json({
    photos: photos.map((p) => ({
      id: p.id,
      status: p.status,
      error: p.error,
      width: p.width,
      height: p.height,
      thumbUrl: p.status === "READY" ? photoUrl(p, "thumb") : null,
      trip: p.trip ? { slug: p.trip.slug, title: p.trip.title } : null,
    })),
  });
}

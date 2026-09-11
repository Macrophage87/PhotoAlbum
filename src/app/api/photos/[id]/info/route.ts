import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canEdit } from "@/lib/auth/access";
import { mediaAccessInclude, mediaBytesAllowed, toMediaAccess } from "@/lib/photos/access";
import { photoUrl } from "@/lib/photos/urls";
import { uploaderLabel } from "@/components/photos/toGrid";

export const dynamic = "force-dynamic";

export type PhotoInfo = {
  id: string;
  title: string | null;
  caption: string | null;
  /** The AI helper's description, or the uploader's notes when there is none (members only). */
  description: string | null;
  takenAt: string | null;
  tzOffsetMin: number | null;
  takenAtSource: string | null;
  timezone: string | null;
  lat: number | null;
  lng: number | null;
  originalUrl: string | null;
  editable: boolean;
  uploadedBy: string | null;
  trip: { slug: string; title: string } | null;
};

/**
 * What the lightbox shows beside an item: date, place, caption and description, plus where to edit it. Follows the
 * same visibility rule as the bytes: anyone who may see the picture may see these, notes and uploader for members only.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const photo = await db.photo.findUnique({
    where: { id },
    select: { id: true, status: true, kind: true, title: true, caption: true, context: true, annotation: true, takenAt: true, tzOffsetMin: true, takenAtSource: true, lat: true, lng: true, updatedAt: true, renditions: true, originalPath: true, uploader: { select: { name: true, email: true } }, ...mediaAccessInclude, trip: { select: { id: true, slug: true, title: true, timezone: true, visibility: true, shareToken: true } } },
  });
  if (!photo || photo.status !== "READY") return Response.json({ error: "Not found" }, { status: 404 });
  const url = new URL(request.url);
  const viewer = await getViewer();
  const media = toMediaAccess(photo);
  if (!mediaBytesAllowed(viewer, media, { token: url.searchParams.get("share"), kind: url.searchParams.get("kind") })) {
    return Response.json({ error: "Forbidden" }, { status: viewer.kind === "user" ? 403 : 401 });
  }
  const member = viewer.kind === "user";
  const ai = (photo.annotation as { description?: string } | null)?.description ?? null;
  const info: PhotoInfo = {
    id: photo.id,
    title: photo.title,
    caption: photo.caption,
    description: ai ?? (member ? photo.context : null),
    takenAt: photo.takenAt?.toISOString() ?? null,
    tzOffsetMin: photo.tzOffsetMin,
    takenAtSource: photo.takenAtSource,
    timezone: photo.trip?.timezone ?? null,
    lat: photo.lat,
    lng: photo.lng,
    originalUrl: photo.kind === "PHOTO" ? photoUrl(photo, "original") : null,
    editable: canEdit(viewer),
    uploadedBy: member ? uploaderLabel(photo.uploader?.name, photo.uploader?.email) : null,
    trip: photo.trip ? { slug: photo.trip.slug, title: photo.trip.title } : null,
  };
  return Response.json(info, { headers: { "Cache-Control": "private, max-age=0, must-revalidate" } });
}

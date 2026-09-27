import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { viewerFor } from "@/lib/auth/access";
import { canEditMedia } from "@/lib/auth/ownership";
import { mediaAccessInclude, mediaBytesAllowed, mediaTripNameable, toMediaAccess } from "@/lib/photos/access";
import { readableDescription, readablePlaceGuess, readableTitle } from "@/lib/photos/readable-text";
import { fullSizeUrl, photoUrl } from "@/lib/photos/urls";
import { uploaderLabel } from "@/components/photos/toGrid";
import type { PlaceEstimate } from "@/components/photos/PlaceEditor";
import { favouritesFor, type FavouriteState } from "@/lib/favourites/queries";
import { photoOffsetMin } from "@/lib/time/local-day";

export const dynamic = "force-dynamic";

export type PhotoInfo = {
  id: string;
  title: string | null;
  caption: string | null;
  /** The AI helper's description, or the uploader's notes when there is none (members only). For anybody else, only a
   * description written from nothing members-only: see `writtenFromMembersOnly`. */
  description: string | null;
  takenAt: string | null;
  tzOffsetMin: number | null;
  takenAtSource: string | null;
  timezone: string | null;
  lat: number | null;
  lng: number | null;
  gpsSource: string | null;
  /** Who pinned the place / set the date by hand, for members; null when the album does not know. */
  placeSetBy: string | null;
  dateSetBy: string | null;
  /** What the place is called, when the album knows: what a family reads instead of coordinates. */
  placeName: string | null;
  /** Set when a member has cropped or colour-corrected it: the file as uploaded, so the family can check it. Members only. */
  uneditedUrl: string | null;
  /** When the position is the helper's guess: what it recognised, and how sure it was. */
  placeEstimate: PlaceEstimate | null;
  themeKey: string | null;
  /** The full-size view: the picture as it is now for a member, the largest rendition for anybody else. */
  originalUrl: string | null;
  editable: boolean;
  uploadedBy: string | null;
  /** Named only where this viewer may open the trip: a private trip's name is the family's, like its photographs. */
  trip: { slug: string; title: string } | null;
  /** This member's heart and the family's count. Null for anyone not signed in: a favourite belongs to a person. */
  favourite: FavouriteState | null;
};

/**
 * What the lightbox shows beside an item: date, place, caption and description, plus where to edit it. Follows the
 * same visibility rule as the bytes: anyone who may see the picture may see these, notes and uploader for members only,
 * and the helper's words for them too wherever it wrote them from names or notes.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const photo = await db.photo.findUnique({
    where: { id },
    select: { id: true, status: true, uploaderId: true, kind: true, title: true, membersTitle: true, caption: true, context: true, annotation: true, annotationMembersOnly: true, takenAt: true, tzOffsetMin: true, takenAtSource: true, lat: true, lng: true, gpsSource: true, edits: true, placeName: true, placeEstimateName: true, placeEstimateConfidence: true, placeEstimateRadiusM: true, placeEstimatePrecision: true, placeEstimateNote: true, placeEstimateMembersOnly: true, updatedAt: true, imageVersion: true, renditions: true, originalPath: true, uploader: { select: { name: true, email: true } }, placeSetBy: { select: { name: true, email: true } }, dateSetBy: { select: { name: true, email: true } }, ...mediaAccessInclude, trip: { select: { id: true, slug: true, title: true, timezone: true, themeKey: true, visibility: true, shareToken: true } } },
  });
  if (!photo || photo.status !== "READY") return Response.json({ error: "Not found" }, { status: 404 });
  const url = new URL(request.url);
  const viewer = await getViewer();
  const media = toMediaAccess(photo);
  const share = { token: url.searchParams.get("share"), kind: url.searchParams.get("kind") };
  if (!mediaBytesAllowed(viewer, media, share)) {
    return Response.json({ error: "Forbidden" }, { status: viewer.kind === "user" ? 403 : 401 });
  }
  // A member reading a share page is answered as the page's visitors are: no names, notes, hearts or originals.
  const shown = viewerFor(viewer, url.searchParams.get("view"));
  const member = shown.kind === "user";
  const tripOpen = mediaTripNameable(shown, photo.trip, share);
  const info: PhotoInfo = {
    id: photo.id,
    title: readableTitle(photo, member),
    caption: photo.caption,
    description: readableDescription(photo, member),
    takenAt: photo.takenAt?.toISOString() ?? null,
    // Where the trip's zone is not this viewer's to know, the offset it gives that moment stands in for it (what the
    // camera would have written), so the panel reads the day it was taken rather than UTC's. Nobody who is sent the
    // offset this way may change the date.
    tzOffsetMin: photo.trip && !tripOpen && photo.takenAt ? photoOffsetMin(photo.takenAt, photo.tzOffsetMin, photo.trip.timezone) : photo.tzOffsetMin,
    takenAtSource: photo.takenAtSource,
    // The trip's zone and look are the trip's, like its name.
    timezone: tripOpen ? photo.trip!.timezone : null,
    lat: photo.lat,
    lng: photo.lng,
    gpsSource: photo.gpsSource,
    placeSetBy: member && photo.placeSetBy ? uploaderLabel(photo.placeSetBy.name, photo.placeSetBy.email) : null,
    dateSetBy: member && photo.dateSetBy ? uploaderLabel(photo.dateSetBy.name, photo.dateSetBy.email) : null,
    // Strictly the name the album holds for the item; a guess keeps its name inside its own provenance line, so the
    // panel never says the same thing twice.
    placeName: photo.placeName,
    // The file as uploaded carries the camera's EXIF and whatever a crop took out: it is the family's.
    uneditedUrl: member && photo.kind === "PHOTO" && photo.edits ? photoUrl(photo, "original") : null,
    // The guess says it is a guess to everybody; what it is called and why are the family's when it came from their notes.
    placeEstimate: photo.gpsSource === "ESTIMATE" ? { ...readablePlaceGuess(photo, member), confidence: photo.placeEstimateConfidence, radiusM: photo.placeEstimateRadiusM, precision: photo.placeEstimatePrecision } : null,
    themeKey: tripOpen ? photo.trip!.themeKey : null,
    originalUrl: photo.kind === "PHOTO" ? fullSizeUrl(photo, member) : null,
    // Editing is the uploader's and an admin's; everyone else in the family gets the same panel, read-only.
    editable: canEditMedia(shown.user, photo),
    uploadedBy: member ? uploaderLabel(photo.uploader?.name, photo.uploader?.email) : null,
    trip: tripOpen ? { slug: photo.trip!.slug, title: photo.trip!.title } : null,
    favourite: member ? (await favouritesFor("photo", [photo.id], shown)).get(photo.id) ?? { mine: false, count: 0 } : null,
  };
  return Response.json(info, { headers: { "Cache-Control": "private, max-age=0, must-revalidate" } });
}

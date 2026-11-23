import { db } from "@/lib/db";
import { getApiViewer } from "@/lib/auth/viewer";
import { collectionSlides, tripSlides, type Slide } from "@/lib/photos/slideshow";
import { CAST_LINK_MS, castUrl } from "@/lib/cast/link";

export const dynamic = "force-dynamic";

/** The version in a slide's own address, which its other addresses carry too. */
const versionOf = (src: string) => Number(new URL(src, "http://album").searchParams.get("v") ?? 0);

/**
 * A trip's or a collection's slideshow for the app to cast to a television (`?trip=<slug>` or `?collection=<slug>`):
 * the same photographs in the same order as the website's Slideshow tab. Each comes with an address the television
 * can fetch on its own for the next few hours (see `lib/cast/link`), and a small one for the phone, which shows
 * what is on the screen and is the remote control.
 */
export async function GET(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const tripSlug = params.get("trip");
  const collectionSlug = params.get("collection");
  if (Boolean(tripSlug) === Boolean(collectionSlug)) return Response.json({ error: "Say which trip or which collection." }, { status: 400 });

  let title: string;
  let slides: Slide[];
  if (tripSlug) {
    const trip = await db.trip.findUnique({ where: { slug: tripSlug, deletingAt: null }, select: { id: true, title: true } });
    if (!trip) return Response.json({ error: "That trip is no longer in the album." }, { status: 404 });
    title = trip.title;
    slides = await tripSlides(trip.id, true);
  } else {
    const collection = await db.collection.findUnique({ where: { slug: collectionSlug! }, select: { id: true, title: true, arrangedAt: true } });
    if (!collection) return Response.json({ error: "That collection is no longer in the album." }, { status: 404 });
    title = collection.title;
    slides = await collectionSlides(collection, true);
  }

  const now = Date.now();
  return Response.json({
    title,
    // When the televisions' addresses stop working; the app asks again rather than cast a dead one.
    expiresAt: new Date(now + CAST_LINK_MS).toISOString(),
    slides: await Promise.all(
      slides.map(async (s) => ({
        id: s.id,
        title: s.title,
        caption: s.caption,
        day: s.day,
        place: s.place,
        thumb: s.src.replace("/medium?", "/thumb?"),
        cast: await castUrl({ id: s.id, imageVersion: versionOf(s.src) }, now),
      })),
    ),
  });
}

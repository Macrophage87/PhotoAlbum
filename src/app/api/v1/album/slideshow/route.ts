import { db } from "@/lib/db";
import { getApiViewer } from "@/lib/auth/viewer";
import { albumSlides, collectionSlides, slideChoices, slideExtras, tripSlides, type Slide, type SlideChoices } from "@/lib/photos/slideshow";
import { parseGalleryFilter } from "@/lib/photos/filters";
import { CAST_LINK_MS, castUrl, castVideoUrl } from "@/lib/cast/link";

export const dynamic = "force-dynamic";

/** The version in a slide's own address, which its other addresses carry too. */
const versionOf = (src: string) => Number(new URL(src, "http://album").searchParams.get("v") ?? 0);

/**
 * A trip's or a collection's slideshow for the app to cast to a television (`?trip=<slug>` or `?collection=<slug>`):
 * the same photographs in the same order as the website's Slideshow tab. Each comes with an address the television
 * can fetch on its own for the next few hours (see `lib/cast/link`), and a small one for the phone, which shows
 * what is on the screen and is the remote control.
 *
 * It can be narrowed the way the website's timeline can (`q`, `uploader`, `person` more than once, `activity`,
 * `year`), and says what there is to narrow by, so the phone can offer the same choices. Each slide says its day,
 * so the phone can lay them out by day and show only the days somebody picks. `?all=1` asks the whole album
 * instead, and gives slides only once something is asked of it.
 *
 * Each slide also says who is in it and where it was taken, for the caption and the small map on the television.
 * `?clips=1` puts the family's own clips among the photographs, each with an address the television plays it from
 * (`video`) and its length; an app that cannot play them does not ask, and gets photographs only.
 */
export async function GET(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const tripSlug = params.get("trip");
  const collectionSlug = params.get("collection");
  // `all=1` is the whole album, which is only ever shown narrowed: a search that can be watched.
  const all = params.get("all") === "1";
  const clips = params.get("clips") === "1";
  if ([Boolean(tripSlug), Boolean(collectionSlug), all].filter(Boolean).length !== 1) return Response.json({ error: "Say which trip or which collection." }, { status: 400 });

  // A member is asking, so the words may match what members read, and who is in the picture may be asked about.
  const filter = { ...parseGalleryFilter({ q: params.getAll("q"), uploader: params.getAll("uploader"), person: params.getAll("person"), activity: params.getAll("activity"), year: params.getAll("year") }, { member: true }), kind: null };

  let title: string;
  let slides: Slide[];
  let choices: SlideChoices;
  // A collection somebody has put in order is shown in that order, not by day.
  let arranged = false;
  if (all) {
    title = "The whole album";
    [slides, choices] = await Promise.all([albumSlides({ ...filter, activityId: null }, clips), slideChoices({})]);
  } else if (tripSlug) {
    const trip = await db.trip.findUnique({ where: { slug: tripSlug, deletingAt: null }, select: { id: true, title: true } });
    if (!trip) return Response.json({ error: "That trip is no longer in the album." }, { status: 404 });
    title = trip.title;
    [slides, choices] = await Promise.all([tripSlides(trip.id, true, filter, clips), slideChoices({ tripId: trip.id })]);
  } else {
    const collection = await db.collection.findUnique({ where: { slug: collectionSlug! }, select: { id: true, title: true, arrangedAt: true } });
    if (!collection) return Response.json({ error: "That collection is no longer in the album." }, { status: 404 });
    title = collection.title;
    arranged = collection.arrangedAt !== null;
    [slides, choices] = await Promise.all([collectionSlides(collection, true, { ...filter, activityId: null }, clips), slideChoices({ collectionId: collection.id })]);
  }

  const { extras, unplayable } = await slideExtras(slides.map((s) => s.id));
  slides = slides.filter((s) => !unplayable.has(s.id));

  const now = Date.now();
  return Response.json({
    title,
    // When the televisions' addresses stop working; the app asks again rather than cast a dead one.
    expiresAt: new Date(now + CAST_LINK_MS).toISOString(),
    total: choices.total,
    arranged,
    choices: { members: choices.members, people: choices.people, activities: choices.activities },
    slides: await Promise.all(
      slides.map(async (s) => {
        const more = extras.get(s.id);
        return {
          id: s.id,
          title: s.title,
          caption: s.caption,
          day: s.day,
          dayKey: s.dayKey,
          place: s.place,
          thumb: s.src.replace("/medium?", "/thumb?"),
          cast: await castUrl({ id: s.id, imageVersion: versionOf(s.src) }, now),
          people: more?.people ?? [],
          lat: more?.lat ?? null,
          lng: more?.lng ?? null,
          video: more?.clip ? await castVideoUrl({ id: s.id, imageVersion: more.clip.imageVersion }, now) : null,
          seconds: more?.clip?.seconds ?? null,
        };
      }),
    ),
  });
}

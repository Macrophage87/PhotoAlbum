import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireTripOwnerPage } from "@/lib/trips/access";
import { activityCover, activityCoverCandidates } from "@/lib/activities/cover";
import { CoverPicker } from "@/components/covers/CoverPicker";
import { setActivityCover } from "../../actions";

export const metadata = { title: "Cover photo" };

/** Choosing the photograph an activity is known by, which is the picture its shared link comes up with. */
export default async function ActivityCoverPage({ params, searchParams }: PageProps<"/trips/[slug]/activities/[id]/cover">) {
  const { slug, id } = await params;
  const path = `/trips/${slug}/activities/${id}/cover`;
  const { trip } = await requireTripOwnerPage(slug, path);
  const activity = await db.activity.findFirst({ where: { id, tripId: trip.id }, select: { id: true, title: true, coverPhotoId: true } });
  if (!activity) notFound();
  const sp = await searchParams;
  const after = typeof sp.after === "string" && sp.after ? sp.after : null;
  const [page, shown] = await Promise.all([activityCoverCandidates(activity.id, after), activityCover(activity)]);
  // What is in use: the hand-chosen one where it still stands, and otherwise what the album leads with by itself.
  const chosen = shown && shown.id === activity.coverPhotoId ? shown : null;
  const automatic = chosen ? await activityCover({ id: activity.id, coverPhotoId: null }) : shown;

  return (
    <CoverPicker
      title={activity.title}
      backHref={`/trips/${slug}/activities/${id}`}
      current={chosen}
      automatic={automatic}
      photos={page.photos}
      nextCursor={page.nextCursor}
      total={page.total}
      pageHref={path}
      usedFor="the picture that comes up when a link to it is shared"
      choose={async (photoId: string) => {
        "use server";
        await setActivityCover(slug, id, photoId);
        redirect(`${path}?chosen=1`);
      }}
      clear={async () => {
        "use server";
        await setActivityCover(slug, id, null);
        redirect(path);
      }}
    />
  );
}

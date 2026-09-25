import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { loadViewableTrip } from "@/lib/trips/access";
import { photoCardSelect } from "@/lib/photos/queries";
import { ActivityDetail } from "@/components/activities/ActivityDetail";
import { deleteActivity, describeActivityWithAi, setActivityDescription, setActivityShare, updateActivity } from "../actions";
import { shareableActivityUrl } from "@/lib/share/social";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { env } from "@/lib/env";
import { annotationGates } from "@/lib/annotation/eligibility";
import { familyMembers } from "@/lib/people/members";
import { activityWindow } from "@/lib/photos/in-window";
import { attachActivityWindow } from "@/app/photos/attach-actions";
import { formatLocalTime } from "@/lib/time/format";
import { activityCover } from "@/lib/activities/cover";
import { photoUrl } from "@/lib/photos/urls";

export default async function ActivityPage({ params, searchParams }: PageProps<"/trips/[slug]/activities/[id]">) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const { viewer, trip, editable, owns } = await loadViewableTrip(slug, `/trips/${slug}/activities/${id}`);
  const activity = await db.activity.findFirst({ where: { id, tripId: trip.id }, include: { track: { select: { id: true, simplified: true, stats: true } }, participants: { select: { id: true } } } });
  if (!activity) notFound();
  const photos = await db.photo.findMany({ where: { activityId: activity.id, ...NOT_TRASHED }, orderBy: [{ takenAt: "asc" }], select: photoCardSelect });

  // Any member may add their own photos to an activity; rearranging the activity itself belongs to the trip's maker.
  // Offered alongside: everything of theirs taken while it was happening, counted now so the button can say how many.
  const during = editable && viewer.kind === "user" ? await activityWindow(viewer.user, activity) : null;
  const added = typeof sp.added === "string" && /^\d+$/.test(sp.added) ? Number(sp.added) : null;
  const upload = editable
    ? {
        maxClipSeconds: env().MAX_CLIP_SECONDS,
        annotationActive: (await annotationGates()).active,
        added,
        during: during
          ? {
              count: during.ids.length,
              elsewhere: during.elsewhere,
              when: `${formatLocalTime(activity.startTime, { timezone: trip.timezone })} – ${formatLocalTime(activity.endTime, { timezone: trip.timezone })}`,
              take: attachActivityWindow.bind(null, activity.id),
            }
          : undefined,
      }
    : undefined;
  if (!owns) return <ActivityDetail trip={trip} activity={activity} photos={photos} upload={upload} editable={false} />;
  // Sharing an activity shapes what leaves the album, so it belongs with the rest of arranging the trip.
  const cover = await activityCover(activity);
  const share = {
    cover: { href: `/trips/${slug}/activities/${activity.id}/cover`, thumbUrl: cover ? photoUrl(cover, "thumb") : null },
    url: shareableActivityUrl(activity, env().APP_URL),
    enable: setActivityShare.bind(null, slug, activity.id, true),
    disable: setActivityShare.bind(null, slug, activity.id, false),
  };
  // Writing it is the trip-arranger's either way; the helper is offered only where there is one to ask and
  // something for it to look at.
  const save = setActivityDescription.bind(null, slug, activity.id);
  const gates = await annotationGates();
  const describe = gates.active && photos.length > 0 ? describeActivityWithAi.bind(null, slug, activity.id) : undefined;
  return (
    <ActivityDetail
      trip={trip}
      activity={activity}
      photos={photos}
      upload={upload}
      share={share}
      save={save}
      describe={describe}
      editable
      editing={sp.edit === "1"}
      members={await familyMembers()}
      updateAction={updateActivity.bind(null, slug, activity.id) as never}
      deleteAction={deleteActivity.bind(null, slug, activity.id)}
    />
  );
}

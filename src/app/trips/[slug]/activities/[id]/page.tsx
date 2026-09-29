import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth/viewer";
import { canViewTrip } from "@/lib/auth/access";
import { getTripBySlug } from "@/lib/trips/queries";
import { previewCard } from "@/lib/share/preview";
import { formatDateTime } from "@/lib/time/format";
import { db } from "@/lib/db";
import { loadViewableTrip } from "@/lib/trips/access";
import { photoCardSelect } from "@/lib/photos/queries";
import { ActivityDetail } from "@/components/activities/ActivityDetail";
import { deleteActivity, describeActivityWithAi, setActivityDescription, setActivityDescriptionShared, setActivityShare, updateActivity } from "../actions";
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
import { uploadByteLimits } from "@/lib/media/upload-limits";

/**
 * The card this page's own address unfurls with. On a public trip anybody may open it, and a link to one walk should
 * show that walk — its title, its day and its cover — not the trip it sits in, which is what the trip's layout would
 * otherwise lend it. Anywhere else the address is the family's own and carries no card (the activity's share link
 * has its own).
 */
export async function generateMetadata({ params }: PageProps<"/trips/[slug]/activities/[id]">): Promise<Metadata> {
  const { slug, id } = await params;
  const [viewer, trip] = await Promise.all([getViewer(), getTripBySlug(slug)]);
  if (!trip || !canViewTrip(viewer, trip)) return {};
  const activity = await db.activity.findFirst({ where: { id, tripId: trip.id }, select: { id: true, title: true, startTime: true, coverPhotoId: true } });
  if (!activity) return {};
  if (trip.visibility !== "PUBLIC") return { title: activity.title };
  const day = formatDateTime(activity.startTime, trip.timezone, "EEEE, MMMM d, yyyy");
  const card = previewCard({
    title: activity.title,
    description: `${trip.title} · ${day}`,
    pageUrl: new URL(`/trips/${slug}/activities/${id}`, env().APP_URL).toString(),
    cover: await activityCover(activity),
    appUrl: env().APP_URL,
  });
  return { title: activity.title, openGraph: card.openGraph, twitter: card.twitter };
}

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
        maxBytes: uploadByteLimits(),
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
  if (!owns) return <ActivityDetail trip={trip} activity={activity} photos={photos} upload={upload} member={viewer.user} editable={false} />;
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
      member={viewer.user}
      trip={trip}
      activity={activity}
      photos={photos}
      upload={upload}
      share={share}
      save={save}
      describe={describe}
      shareDescription={setActivityDescriptionShared.bind(null, slug, activity.id)}
      strangersCanOpen={trip.visibility !== "PRIVATE" || Boolean(activity.shareToken)}
      editable
      editing={sp.edit === "1"}
      members={await familyMembers()}
      updateAction={updateActivity.bind(null, slug, activity.id) as never}
      deleteAction={deleteActivity.bind(null, slug, activity.id)}
    />
  );
}

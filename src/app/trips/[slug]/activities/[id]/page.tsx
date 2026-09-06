import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { canEditTrip } from "@/lib/auth/access";
import { getTripBySlug } from "@/lib/trips/queries";
import { photoCardSelect } from "@/lib/photos/queries";
import { ACTIVITY_LABEL } from "@/lib/activities/types";
import { formatDateTime, formatLocalTime } from "@/lib/time/format";
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { ActivityTypeIcon } from "@/components/activities/ActivityTypeIcon";
import { ActivityForm } from "@/components/activities/ActivityForm";
import { StatsGrid } from "@/components/activities/StatsGrid";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";
import { Button, Card } from "@/components/ui";
import { ActivityMapSection } from "@/components/activities/ActivityMapSection";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { deleteActivity, updateActivity } from "../actions";

export default async function ActivityPage({ params, searchParams }: PageProps<"/trips/[slug]/activities/[id]">) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const [viewer, trip] = await Promise.all([getViewer(), getTripBySlug(slug)]);
  if (!trip) notFound();
  const editable = canEditTrip(viewer);
  const activity = await db.activity.findFirst({
    where: { id, tripId: trip.id },
    include: { track: { select: { id: true, simplified: true, stats: true, source: true, hasElevation: true, hasHeartRate: true, hasCadence: true, hasPower: true, minLat: true, maxLat: true, minLng: true, maxLng: true } } },
  });
  if (!activity) notFound();
  const photos = await db.photo.findMany({ where: { activityId: activity.id }, orderBy: [{ takenAt: "asc" }], select: photoCardSelect });
  const editing = editable && sp.edit === "1";
  const toLocalInput = (d: Date) => format(new TZDate(d, trip.timezone), "yyyy-MM-dd'T'HH:mm");

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted">
            <ActivityTypeIcon type={activity.type} />
            <span>{ACTIVITY_LABEL[activity.type]}</span>
          </div>
          <h2 className="font-display text-2xl sm:text-3xl font-semibold mt-1">{activity.title}</h2>
          <p className="text-muted mt-1">
            {formatDateTime(activity.startTime, trip.timezone)} – {formatLocalTime(activity.endTime, { timezone: trip.timezone })}
          </p>
        </div>
        {editable && !editing && (
          <a href={`?edit=1`} className="text-sm text-primary underline-offset-2 hover:underline">
            Edit
          </a>
        )}
      </div>

      {editing ? (
        <Card className="p-5 max-w-2xl space-y-6">
          <ActivityForm
            action={updateActivity.bind(null, slug, activity.id)}
            submitLabel="Save"
            timezone={trip.timezone}
            initial={{ title: activity.title, type: activity.type, start: toLocalInput(activity.startTime), end: toLocalInput(activity.endTime), description: activity.description ?? "" }}
          />
          <form action={deleteActivity.bind(null, slug, activity.id)} className="border-t border-border pt-4 space-y-2">
            {activity.track && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="deleteTrack" /> Also delete its track
              </label>
            )}
            <Button type="submit" variant="danger" size="sm">
              Delete activity
            </Button>
          </form>
        </Card>
      ) : (
        activity.description && <p className="max-w-3xl whitespace-pre-line">{activity.description}</p>
      )}

      {activity.track?.stats && (
        <Card className="p-5">
          <StatsGrid stats={activity.track.stats} type={activity.type} />
        </Card>
      )}

      {activity.track && <ActivityMapSection tripSlug={slug} trackId={activity.track.id} activityId={activity.id} type={activity.type} theme={mapThemeOf(getTheme(trip.themeKey))} showDetailLink={editable} />}

      <section>
        <h3 className="font-display text-lg font-semibold mb-3">
          {photos.length} photo{photos.length === 1 ? "" : "s"}
        </h3>
        <PhotoGrid photos={photos.map((p) => toGridPhoto(p))} showDetailLink={editable} emptyMessage="No photos in this time window yet." />
      </section>
    </div>
  );
}

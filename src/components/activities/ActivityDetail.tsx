import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import type { ActivityType } from "@/generated/prisma/enums";
import type { PhotoCard } from "@/lib/photos/queries";
import { ACTIVITY_LABEL } from "@/lib/activities/types";
import { formatDateTime, formatLocalTime } from "@/lib/time/format";
import { getTheme } from "@/themes";
import { mapThemeOf } from "@/lib/map/theme";
import { ActivityTypeIcon } from "./ActivityTypeIcon";
import { ActivityForm } from "./ActivityForm";
import { StatsGrid, type StatsLike } from "./StatsGrid";
import { ActivityMapSection } from "./ActivityMapSection";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";
import { Card, ConfirmSubmitButton } from "@/components/ui";

export type ActivityDetailData = {
  id: string;
  title: string;
  type: ActivityType;
  startTime: Date;
  endTime: Date;
  description: string | null;
  track: { id: string; simplified: unknown; stats: StatsLike | null } | null;
};

type EditProps = {
  editable: true;
  editing: boolean;
  updateAction: (prev: never, fd: FormData) => Promise<never>;
  deleteAction: (fd: FormData) => Promise<void>;
};
type ReadOnlyProps = { editable: false };

/** Shared body of the activity page for members (editable) and shared/public viewers. */
export function ActivityDetail({ trip, activity, photos, ...mode }: { trip: { slug: string; timezone: string; themeKey: string }; activity: ActivityDetailData; photos: PhotoCard[] } & (EditProps | ReadOnlyProps)) {
  const toLocalInput = (d: Date) => format(new TZDate(d, trip.timezone), "yyyy-MM-dd'T'HH:mm");
  const editing = mode.editable && mode.editing;
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
        {mode.editable && !editing && (
          <a href="?edit=1" className="text-sm text-primary underline-offset-2 hover:underline">
            Edit
          </a>
        )}
      </div>

      {mode.editable && editing ? (
        <Card className="p-5 max-w-2xl space-y-6">
          <ActivityForm
            action={mode.updateAction as never}
            submitLabel="Save"
            timezone={trip.timezone}
            initial={{ title: activity.title, type: activity.type, start: toLocalInput(activity.startTime), end: toLocalInput(activity.endTime), description: activity.description ?? "" }}
          />
          <form action={mode.deleteAction} className="border-t border-border pt-4 space-y-2">
            {activity.track && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="deleteTrack" /> Also delete its track
              </label>
            )}
            <ConfirmSubmitButton variant="danger" size="sm" confirmMessage={`Delete "${activity.title}"? Photos stay on the trip. This cannot be undone.`}>
              Delete activity
            </ConfirmSubmitButton>
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

      {activity.track && <ActivityMapSection tripSlug={trip.slug} trackId={activity.track.id} activityId={activity.id} type={activity.type} theme={mapThemeOf(getTheme(trip.themeKey))} showDetailLink={mode.editable} />}

      <section>
        <h3 className="font-display text-lg font-semibold mb-3">
          {photos.length} photo{photos.length === 1 ? "" : "s"}
        </h3>
        <PhotoGrid photos={photos.map((p) => toGridPhoto(p))} showDetailLink={mode.editable} emptyMessage="No photos in this time window yet." />
      </section>
    </div>
  );
}

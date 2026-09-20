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
import { ActivityGallery } from "./ActivityGallery";
import { DescriptionEditor } from "@/components/descriptions/DescriptionEditor";
import { toGridPhoto } from "@/components/photos/toGrid";
import { Button, Card, ConfirmSubmitButton } from "@/components/ui";
import { ActivityUploader } from "./ActivityUploader";
import { ShareBar } from "@/components/share/ShareBar";

export type ActivityDetailData = {
  id: string;
  title: string;
  type: ActivityType;
  startTime: Date;
  endTime: Date;
  description: string | null;
  track: { id: string; simplified: unknown; stats: StatsLike | null } | null;
  participants: { id: string }[];
};

type EditProps = {
  editable: true;
  editing: boolean;
  /** The family, so the edit form can say who was on this outing. */
  members: { id: string; label: string }[];
  updateAction: (prev: never, fd: FormData) => Promise<never>;
  deleteAction: (fd: FormData) => Promise<void>;
};
type ReadOnlyProps = { editable: false };

/**
 * The link to this one activity, for whoever arranges the trip. Making a link again replaces it, which is how an
 * old one is retired.
 */
export type ActivityShare = { url: string | null; enable: () => Promise<void>; disable: () => Promise<void> };

/** Shared body of the activity page for members (editable) and shared/public viewers. */
export function ActivityDetail({ trip, activity, photos, upload, share, save, describe, ...mode }: { trip: { slug: string; timezone: string; themeKey: string }; activity: ActivityDetailData; photos: PhotoCard[]; /** Members only: what the uploader needs to offer adding photos straight to this activity. */ upload?: { maxClipSeconds: number; annotationActive: boolean }; /** Whoever arranges the trip: the link to this activity, and the means to make or withdraw it. */ share?: ActivityShare; /** Write the description by hand. Absent for anyone who may not arrange the trip; they read what is there. */ save?: (text: string) => Promise<void>; /** Ask the helper to write it, with whatever is in the box as a note. Absent when the helper is off, or for anyone who may not arrange the trip. */ describe?: (note: string) => Promise<string>; } & (EditProps | ReadOnlyProps)) {
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
        <div className="flex items-center gap-3">
          {/* An afternoon's walk is the piece of a trip worth sending on its own: its own link, which opens this
              and nothing else of the trip, whatever the trip's own visibility is. */}
          {share &&
            (share.url ? (
              <div className="flex items-center gap-2" data-testid="activity-shared">
                <ShareBar url={share.url} what="activity" />
                <form action={share.enable}>
                  <button type="submit" className="text-sm text-muted underline-offset-2 hover:underline" data-testid="activity-share-rotate">New link</button>
                </form>
                <form action={share.disable}>
                  <button type="submit" className="text-sm text-muted underline-offset-2 hover:underline" data-testid="activity-share-off">Stop sharing</button>
                </form>
              </div>
            ) : (
              <form action={share.enable}>
                <Button type="submit" variant="secondary" size="sm" data-testid="activity-share-on">Share this activity</Button>
              </form>
            ))}
          {mode.editable && !editing && (
            <a href="?edit=1" className="text-sm text-primary underline-offset-2 hover:underline">
              Edit
            </a>
          )}
        </div>
      </div>

      {mode.editable && editing ? (
        <Card className="p-5 max-w-2xl space-y-6">
          <ActivityForm
            action={mode.updateAction as never}
            submitLabel="Save"
            timezone={trip.timezone}
            initial={{ title: activity.title, type: activity.type, start: toLocalInput(activity.startTime), end: toLocalInput(activity.endTime), description: activity.description ?? "", participants: activity.participants.map((p) => p.id) }}
            members={mode.members}
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
        /* Written by hand or by the helper, in the same box either way, and editable afterwards whichever it was. */
        <DescriptionEditor what="activity" description={activity.description} save={save} describe={describe} />
      )}

      {activity.track?.stats && (
        <Card className="p-5">
          <StatsGrid stats={activity.track.stats} type={activity.type} />
        </Card>
      )}

      {activity.track && <ActivityMapSection tripSlug={trip.slug} trackId={activity.track.id} activityId={activity.id} type={activity.type} theme={mapThemeOf(getTheme(trip.themeKey))} />}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-lg font-semibold">
            {photos.length} photo{photos.length === 1 ? "" : "s"}
          </h3>
          {upload && <ActivityUploader activityId={activity.id} maxClipSeconds={upload.maxClipSeconds} annotationActive={upload.annotationActive} />}
        </div>
        {mode.editable ? (
          <ActivityGallery photos={photos.map((p) => toGridPhoto(p))} emptyMessage={upload ? "Nothing here yet. Photos taken during these hours arrive on their own; anything else can be added above." : "No photos on this activity yet."} />
        ) : (
          <PhotoGrid photos={photos.map((p) => toGridPhoto(p))} emptyMessage="No photos on this activity yet." />
        )}
      </section>
    </div>
  );
}

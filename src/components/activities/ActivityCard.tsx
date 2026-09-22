import Link from "next/link";
import type { ActivityType } from "@/generated/prisma/enums";
import { ACTIVITY_LABEL } from "@/lib/activities/types";
import { formatLocalTime } from "@/lib/time/format";
import { ActivityTypeIcon } from "./ActivityTypeIcon";
import { StatsGrid, type StatsLike } from "./StatsGrid";
import { MiniMapSvg } from "@/components/map/MiniMapSvg";

export type ActivityCardData = {
  id: string;
  title: string;
  type: ActivityType;
  startTime: Date;
  endTime: Date;
  description: string | null;
  track: { simplified: unknown; stats: StatsLike | null } | null;
  /** How many photographs are on it, where the list has counted them. The timeline shows them instead. */
  photoCount?: number;
};

/**
 * One outing in a list.
 *
 * The whole head of the card opens it, not just the words of the title. Only the title was a link before, and the
 * little map beside it — which is hidden on a phone — so on the screen most of the family actually uses, the card
 * looked like something to press and was not. Anything below the head (the timeline hangs a strip of photographs
 * there) stays outside the link and keeps working on its own.
 */
export function ActivityCard({ activity, tripSlug, timezone, children, hrefBase }: { activity: ActivityCardData; tripSlug: string; timezone: string; children?: React.ReactNode; /** Override the link root, e.g. for share pages. */ hrefBase?: string }) {
  const href = `${hrefBase ?? `/trips/${tripSlug}/activities`}/${activity.id}`;
  const line = activity.track?.simplified as [number, number][] | undefined;
  return (
    <article className="group rounded-theme border border-border bg-surface shadow-sm overflow-hidden">
      <div className="relative flex gap-4 p-4">
        {/* One link over the head of the card, rather than one around it: the photographs below must stay
            draggable, and a link may not contain them. */}
        <Link
          href={href}
          className="absolute inset-0 z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-theme"
          aria-label={`Open ${activity.title}`}
          data-testid="activity-card-link"
        >
          <span className="sr-only">Open {activity.title}</span>
        </Link>
        {line && line.length > 1 && <MiniMapSvg line={line} type={activity.type} className="hidden sm:block shrink-0 w-32 h-24 rounded bg-surface-alt" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted">
            <ActivityTypeIcon type={activity.type} className="w-4 h-4" />
            <span>{ACTIVITY_LABEL[activity.type]}</span>
            <span>·</span>
            <span>
              {formatLocalTime(activity.startTime, { timezone })} – {formatLocalTime(activity.endTime, { timezone })}
            </span>
            {activity.photoCount !== undefined && (
              <>
                <span>·</span>
                <span>
                  {activity.photoCount} photo{activity.photoCount === 1 ? "" : "s"}
                </span>
              </>
            )}
          </div>
          <h3 className="font-display text-lg font-semibold mt-1 group-hover:underline underline-offset-2">{activity.title}</h3>
          {activity.description && <p className="text-sm text-text/80 mt-1 line-clamp-2">{activity.description}</p>}
          {activity.track?.stats && (
            <div className="mt-3">
              <StatsGrid stats={activity.track.stats} type={activity.type} compact />
            </div>
          )}
        </div>
      </div>
      {children}
    </article>
  );
}

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
};

export function ActivityCard({ activity, tripSlug, timezone, children, hrefBase }: { activity: ActivityCardData; tripSlug: string; timezone: string; children?: React.ReactNode; /** Override the link root, e.g. for share pages. */ hrefBase?: string }) {
  const href = `${hrefBase ?? `/trips/${tripSlug}/activities`}/${activity.id}`;
  const line = activity.track?.simplified as [number, number][] | undefined;
  return (
    <article className="rounded-theme border border-border bg-surface shadow-sm overflow-hidden">
      <div className="flex gap-4 p-4">
        {line && line.length > 1 && (
          <Link href={href} className="hidden sm:block shrink-0">
            <MiniMapSvg line={line} type={activity.type} className="w-32 h-24 rounded bg-surface-alt" />
          </Link>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted">
            <ActivityTypeIcon type={activity.type} className="w-4 h-4" />
            <span>{ACTIVITY_LABEL[activity.type]}</span>
            <span>·</span>
            <span>
              {formatLocalTime(activity.startTime, { timezone })} – {formatLocalTime(activity.endTime, { timezone })}
            </span>
          </div>
          <h3 className="font-display text-lg font-semibold mt-1">
            <Link href={href} className="hover:underline underline-offset-2">
              {activity.title}
            </Link>
          </h3>
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

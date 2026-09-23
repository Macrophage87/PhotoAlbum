import { photosOnDay, type DayGroup } from "@/lib/timeline/build";
import type { PhotoCard } from "@/lib/photos/queries";
import { formatDay, formatLocalTime } from "@/lib/time/format";
import { toGridPhoto } from "@/components/photos/toGrid";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { ActivityCard, type ActivityCardData } from "@/components/activities/ActivityCard";
import { TimelineNav } from "./TimelineNav";
import { DaySelect } from "./DaySelect";
import { DayJump } from "./DayJump";
import { TimelineDrop } from "./TimelineDrop";
import { getViewer } from "@/lib/auth/viewer";
import { photoFavourites } from "@/lib/favourites/queries";

export type TimelineGroups = DayGroup<PhotoCard, ActivityCardData>[];

export async function Timeline({ groups, tripSlug, timezone, member, idPrefix = "day", activityHrefBase }: { groups: TimelineGroups; tripSlug: string; timezone: string; member: boolean; idPrefix?: string; activityHrefBase?: string }) {
  if (groups.length === 0) return <p className="text-muted text-sm">Nothing on the timeline yet. Upload photos or add an activity.</p>;
  // The timeline is where most photographs are actually looked at, so it carries the same hearts as the grids: whose
  // favorites they are, loaded for the whole page in two small queries. Members only — a favorite is a person's.
  const hearts = member ? await photoFavourites(groups.flatMap((g) => g.items.flatMap((i) => i.photos.map((p) => p.id))), await getViewer()) : new Map();
  const tile = (p: PhotoCard) => toGridPhoto(p, null, member, hearts.get(p.id) ?? (member ? { mine: false, count: 0 } : null));
  const days = groups.map((g) => {
    const id = `${idPrefix}-${g.dayKey ?? "undated"}`;
    const activities = g.items.flatMap((i) => (i.kind === "activity" ? [{ id: `${id}-${i.activity.id}`, title: i.activity.title, count: i.photos.length }] : []));
    return { key: g.dayKey ?? "undated", id, count: photosOnDay(g), activities };
  });
  return (
    <div className="flex flex-col lg:flex-row gap-8">
      <TimelineNav days={days} />
      <div className="flex-1 min-w-0 space-y-10">
        {groups.map((g, gi) => (
          <section key={days[gi].id} id={days[gi].id} className="scroll-mt-24">
            {/* The heading is a drop target too: a photograph under the wrong day is dragged to the right one. */}
            <TimelineDrop kind="day" target={g.dayKey} label={g.dayKey ? formatDay(g.dayKey, "weekday") : "Undated"} className="sticky top-14 bg-bg/90 backdrop-blur z-10">
              <h2 className="font-display text-xl font-semibold py-2 flex flex-wrap items-baseline gap-x-3">
                <DayJump days={days} current={days[gi].id} label={g.dayKey ? formatDay(g.dayKey, "weekday") : "Undated"} />
                {member && <DaySelect ids={g.items.flatMap((i) => i.photos.map((p) => p.id))} label={g.dayKey ? "this day" : "these"} />}
              </h2>
            </TimelineDrop>
            <ol className="relative border-l border-border ml-2 pl-6 space-y-6 mt-2">
              {g.items.map((item, ii) => (
                // An activity's card is an anchor too, so the panel can take the reader straight to it.
                <li key={ii} className="relative scroll-mt-32" id={item.kind === "activity" ? `${days[gi].id}-${item.activity.id}` : undefined}>
                  <span className="absolute -left-[1.85rem] top-2 w-3 h-3 rounded-full bg-primary ring-4 ring-bg" />
                  {item.kind === "activity" ? (
                    // A photograph dropped on an activity card is filed there by hand, whatever the clock says.
                    <TimelineDrop kind="activity" target={item.activity.id} label={item.activity.title}>
                      <ActivityCard activity={item.activity} tripSlug={tripSlug} timezone={timezone} hrefBase={activityHrefBase}>
                        {item.photos.length > 0 && (
                          <div className="px-4 pb-4">
                            <PhotoGrid photos={item.photos.map(tile)} draggable={member} />
                          </div>
                        )}
                      </ActivityCard>
                    </TimelineDrop>
                  ) : (
                    <div>
                      {g.dayKey && (
                        <div className="text-xs text-muted mb-2">
                          {formatLocalTime(item.photos[0].takenAt!, { offsetMin: item.photos[0].tzOffsetMin, timezone })}
                          {item.photos.length > 1 && <> – {formatLocalTime(item.photos[item.photos.length - 1].takenAt!, { offsetMin: item.photos[item.photos.length - 1].tzOffsetMin, timezone })}</>}
                          <span className="ml-2">· {item.photos.length} photo{item.photos.length === 1 ? "" : "s"}</span>
                        </div>
                      )}
                      {/* Dropped here, a photograph comes off whatever activity it was on and stays on this day. */}
                      <TimelineDrop kind="loose" target={null} label="this day">
                        <PhotoGrid photos={item.photos.map(tile)} draggable={member} />
                      </TimelineDrop>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

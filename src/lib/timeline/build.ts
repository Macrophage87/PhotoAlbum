import { localDayFromOffset, localDayInZone, type LocalDay } from "@/lib/time/local-day";

export type TimelinePhoto = { id: string; takenAt: Date | null; tzOffsetMin: number | null; activityId: string | null };
export type TimelineActivity = { id: string; startTime: Date; endTime: Date };

export type TimelineItem<P, A> =
  | { kind: "activity"; time: Date; activity: A; photos: P[] }
  | { kind: "photos"; time: Date; photos: P[] };

export type DayGroup<P, A> = { dayKey: LocalDay | null; items: TimelineItem<P, A>[] };

/**
 * Merge photos and activities into day groups ordered by local time.
 * - An activity's photos ride inside its card.
 * - Loose photos are batched into strips until an activity interrupts them.
 * - Photos without a time land in a trailing "undated" group (dayKey null).
 */
export function buildTimeline<P extends TimelinePhoto, A extends TimelineActivity>(photos: P[], activities: A[], timezone: string): DayGroup<P, A>[] {
  const byActivity = new Map<string, P[]>();
  const loose: P[] = [];
  const undated: P[] = [];
  for (const p of photos) {
    if (p.activityId && activities.some((a) => a.id === p.activityId)) {
      const list = byActivity.get(p.activityId) ?? [];
      list.push(p);
      byActivity.set(p.activityId, list);
    } else if (p.takenAt) loose.push(p);
    else undated.push(p);
  }
  const byTime = <T extends { takenAt: Date | null }>(a: T, b: T) => (a.takenAt?.getTime() ?? 0) - (b.takenAt?.getTime() ?? 0);
  for (const list of byActivity.values()) list.sort(byTime);
  loose.sort(byTime);

  type Ev = { time: Date; day: LocalDay; activity?: A; photo?: P };
  const events: Ev[] = [
    ...activities.map((a) => ({ time: a.startTime, day: localDayInZone(a.startTime, timezone), activity: a })),
    ...loose.map((p) => ({ time: p.takenAt!, day: p.tzOffsetMin !== null ? localDayFromOffset(p.takenAt!, p.tzOffsetMin) : localDayInZone(p.takenAt!, timezone), photo: p })),
  ];
  events.sort((a, b) => a.time.getTime() - b.time.getTime());

  const groups: DayGroup<P, A>[] = [];
  let current: DayGroup<P, A> | null = null;
  for (const ev of events) {
    if (!current || current.dayKey !== ev.day) {
      current = { dayKey: ev.day, items: [] };
      groups.push(current);
    }
    if (ev.activity) {
      current.items.push({ kind: "activity", time: ev.time, activity: ev.activity, photos: byActivity.get(ev.activity.id) ?? [] });
    } else if (ev.photo) {
      const last = current.items[current.items.length - 1];
      if (last && last.kind === "photos") last.photos.push(ev.photo);
      else current.items.push({ kind: "photos", time: ev.time, photos: [ev.photo] });
    }
  }
  if (undated.length) groups.push({ dayKey: null, items: [{ kind: "photos", time: new Date(0), photos: undated }] });
  return groups;
}

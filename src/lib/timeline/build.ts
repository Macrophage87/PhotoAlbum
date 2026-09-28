import { localDayInZone, photoDay, wallTimeToInstant, type LocalDay } from "@/lib/time/local-day";

export type TimelinePhoto = { id: string; takenAt: Date | null; tzOffsetMin: number | null; activityId: string | null };
export type TimelineActivity = { id: string; startTime: Date; endTime: Date };

export type TimelineItem<P, A> =
  | { kind: "activity"; time: Date; activity: A; photos: P[] }
  | { kind: "photos"; time: Date; photos: P[] }
  /** An activity that began on an earlier day (`from`) and ran on into this one. Its photographs are on its card
   * under `from`, so this carries none: `photos` is always empty, and a day's count does not take them twice. */
  | { kind: "continued"; time: Date; activity: A; from: LocalDay; photos: P[] };

export type DayGroup<P, A> = { dayKey: LocalDay | null; items: TimelineItem<P, A>[] };

/**
 * Merge photos and activities into day groups ordered by local time.
 * - An activity's photos ride inside its card.
 * - Loose photos are batched into strips until an activity interrupts them.
 * - Photos without a time land in a trailing "undated" group (dayKey null).
 * - An activity that runs on past midnight is under the day it began. A later day it runs into that has anything
 *   of its own on the timeline begins with a pointer back to it, not a second copy.
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

  // One day rule everywhere: a photograph's day is the one on its own clock (its offset), falling back to the trip's
  // zone; an activity's is the trip's zone. Offsets can disagree within a trip (a drive across zones, a phone and a
  // camera set differently), so those days need not rise with the instant: events are bucketed by day rather than
  // split into runs, or one day would come out as several same-named groups.
  type Ev = { time: Date; day: LocalDay; activity?: A; photo?: P; continued?: { activity: A; from: LocalDay } };
  const byDay = new Map<LocalDay, Ev[]>();
  const add = (ev: Ev) => {
    const list = byDay.get(ev.day) ?? [];
    list.push(ev);
    byDay.set(ev.day, list);
  };
  for (const a of activities) add({ time: a.startTime, day: localDayInZone(a.startTime, timezone), activity: a });
  for (const p of loose) add({ time: p.takenAt!, day: photoDay(p.takenAt!, p.tzOffsetMin, timezone), photo: p });
  // Only days already on the timeline: a day with nothing of its own is not made up to hold a pointer.
  const onTimeline = [...byDay.keys()];
  for (const a of activities) {
    const from = localDayInZone(a.startTime, timezone);
    // The last day it runs into: one ending on the stroke of midnight does not run into the next.
    const to = localDayInZone(new Date(Math.max(a.startTime.getTime(), a.endTime.getTime() - 1)), timezone);
    for (const day of onTimeline) {
      if (day <= from || day > to) continue;
      const [y, m, d] = day.split("-").map(Number);
      add({ time: wallTimeToInstant({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, timezone), day, continued: { activity: a, from } });
    }
  }

  const groups: DayGroup<P, A>[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const current: DayGroup<P, A> = { dayKey: day, items: [] };
    groups.push(current);
    // Stable sort, so photographs sharing an instant keep the order they came in. What ran on from the day before
    // opens the day, whatever a photograph's own clock says.
    const events = byDay.get(day)!.sort((a, b) => Number(!a.continued) - Number(!b.continued) || a.time.getTime() - b.time.getTime());
    for (const ev of events) {
      if (ev.continued) {
        current.items.push({ kind: "continued", time: ev.time, activity: ev.continued.activity, from: ev.continued.from, photos: [] });
      } else if (ev.activity) {
        current.items.push({ kind: "activity", time: ev.time, activity: ev.activity, photos: byActivity.get(ev.activity.id) ?? [] });
      } else if (ev.photo) {
        const last = current.items[current.items.length - 1];
        if (last && last.kind === "photos") last.photos.push(ev.photo);
        else current.items.push({ kind: "photos", time: ev.time, photos: [ev.photo] });
      }
    }
  }
  if (undated.length) groups.push({ dayKey: null, items: [{ kind: "photos", time: new Date(0), photos: undated }] });
  return groups;
}

/** How many photographs a day holds, the ones filed on its activities included: an outing is part of its day. */
export function photosOnDay<P, A>(group: DayGroup<P, A>): number {
  return group.items.reduce((n, i) => n + i.photos.length, 0);
}

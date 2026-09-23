import { formatDay } from "@/lib/time/format";
import type { PhotoFeatureProps, TrackFeatureProps } from "./geojson";

/** What the rings round the photographs on a map say: nothing (the trip's own markers), or which day, activity or person. */
export type ColourBy = "none" | "day" | "activity" | "uploader";

/**
 * Eight hues, always handed out in this order. Past eight, two colours on a map stop being told apart at a glance —
 * worse still for anybody colour-blind — so the rest are folded together rather than given a ninth hue. The order is
 * not decoration: it is the one that keeps neighbouring hues apart for the common kinds of colour-blindness.
 */
export const RING_HUES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"] as const;
/** Everything past the eighth, folded together. */
export const OTHER_SLOT = RING_HUES.length;
/** No day, no activity: the photographs the question has no answer for. */
export const NONE_SLOT = RING_HUES.length + 1;
/** Every slot's colour, by slot number. The two greys are told apart by the legend, which always names them. */
export const SLOT_COLOURS: readonly string[] = [...RING_HUES, "#6b6a66", "#bdbcb6"];

export type RingGroup = { slot: number; label: string; count: number };
export type Rings = { groups: RingGroup[]; photoSlot: (p: PhotoFeatureProps) => number; trackSlot: (t: TrackFeatureProps) => number };

type Entry = { key: string; label: string; count: number; first: number };

const NONE_LABEL: Record<Exclude<ColourBy, "none">, string> = { day: "No date", activity: "Not on an activity", uploader: "Someone unknown" };
const OTHER_LABEL: Record<Exclude<ColourBy, "none">, string> = { day: "Other days", activity: "Other activities", uploader: "Everyone else" };

/**
 * Which colour each photograph's ring gets, and the legend that explains them.
 *
 * Days are in order, so when there are more than eight they are cut into eight runs of neighbouring days — "Aug 3 –
 * Aug 5" — rather than having all but seven folded into one grey. Activities keep the order they happened in and
 * people are in alphabetical order, and past eight the ones with the most photographs keep their colours and the rest
 * are folded into "Other". A track is coloured the same way as the photographs taken along it.
 */
export function ringsFor(by: Exclude<ColourBy, "none">, photos: PhotoFeatureProps[], tracks: TrackFeatureProps[]): Rings {
  const keyOf = (f: PhotoFeatureProps | TrackFeatureProps): string | null => (by === "day" ? f.day : by === "activity" ? f.activityId : f.uploaderId);
  const labelOf = (f: PhotoFeatureProps | TrackFeatureProps): string => (by === "day" ? f.day! : by === "activity" ? (f.activityTitle ?? "An activity") : (f.uploaderName ?? "Someone"));
  const entries = new Map<string, Entry>();
  let none = 0;
  const see = (f: PhotoFeatureProps | TrackFeatureProps, time: string | null, photo: boolean) => {
    const key = keyOf(f);
    if (key === null) {
      if (photo) none++;
      return;
    }
    const at = time ? Date.parse(time) : Number.POSITIVE_INFINITY;
    const e = entries.get(key) ?? { key, label: labelOf(f), count: 0, first: at };
    if (photo) e.count++;
    e.first = Math.min(e.first, at);
    entries.set(key, e);
  };
  for (const p of photos) see(p, p.takenAt, true);
  for (const t of tracks) see(t, t.startTime, false);

  const order = [...entries.values()].sort(
    by === "day" ? (a, b) => a.key.localeCompare(b.key) : by === "activity" ? (a, b) => a.first - b.first || a.label.localeCompare(b.label) : (a, b) => a.label.localeCompare(b.label),
  );
  const slotOfKey = new Map<string, number>();
  const groups: RingGroup[] = [];

  if (order.length <= RING_HUES.length) {
    order.forEach((e, i) => {
      slotOfKey.set(e.key, i);
      groups.push({ slot: i, label: by === "day" ? formatDay(e.key, "shortDay") : e.label, count: e.count });
    });
  } else if (by === "day") {
    const years = new Set(order.map((e) => e.key.slice(0, 4))).size > 1;
    const style = years ? "shortYear" : "short";
    for (let slot = 0; slot < RING_HUES.length; slot++) {
      const run = order.filter((_, i) => Math.floor((i * RING_HUES.length) / order.length) === slot);
      if (!run.length) continue;
      for (const e of run) slotOfKey.set(e.key, slot);
      const from = formatDay(run[0].key, style);
      const to = formatDay(run[run.length - 1].key, style);
      groups.push({ slot, label: run.length === 1 ? from : `${from} – ${to}`, count: run.reduce((n, e) => n + e.count, 0) });
    }
  } else {
    const kept = new Set([...order].sort((a, b) => b.count - a.count || a.first - b.first).slice(0, RING_HUES.length - 1).map((e) => e.key));
    let slot = 0;
    let folded = 0;
    for (const e of order) {
      if (kept.has(e.key)) {
        slotOfKey.set(e.key, slot);
        groups.push({ slot, label: e.label, count: e.count });
        slot++;
      } else {
        slotOfKey.set(e.key, OTHER_SLOT);
        folded += e.count;
      }
    }
    groups.push({ slot: OTHER_SLOT, label: OTHER_LABEL[by], count: folded });
  }
  if (none > 0) groups.push({ slot: NONE_SLOT, label: NONE_LABEL[by], count: none });

  const slot = (f: PhotoFeatureProps | TrackFeatureProps) => {
    const key = keyOf(f);
    return key === null ? NONE_SLOT : (slotOfKey.get(key) ?? OTHER_SLOT);
  };
  return { groups, photoSlot: slot, trackSlot: slot };
}

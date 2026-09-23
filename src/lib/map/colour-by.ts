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

/**
 * Days are not separate things like people are: they come in order, so they are coloured along one scale, the first
 * day dark and the last bright, and a glance at the map says early or late in the trip. The scale is viridis, which
 * stays in order for colour-blind eyes and in greyscale too. More days can be told apart along a scale than in a set
 * of unrelated hues, because a neighbour is only ever a little lighter or darker, so days keep a colour each up to
 * fourteen; past that they are cut into fourteen runs of neighbouring days.
 */
export const MAX_DAY_SLOTS = 14;

/** Viridis, sampled every eighth of the way from its dark purple end to its yellow end. */
const VIRIDIS = ["#440154", "#472c7a", "#3b528b", "#2c728e", "#21918c", "#28ae80", "#5ec962", "#addc30", "#fde725"];
/** Stop short of the palest yellow, which is hard to see as a thin ring on a pale map. */
const VIRIDIS_TOP = 0.9;

/** The colour `t` of the way along viridis (0 is the dark end), mixed between its two nearest samples. */
export function viridis(t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
  const f = x - i;
  const rgb = (hex: string) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
  const a = rgb(VIRIDIS[i]);
  const b = rgb(VIRIDIS[i + 1]);
  return `#${a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).padStart(2, "0")).join("")}`;
}

/** `n` colours spread evenly along the scale, earliest first. One day on its own takes the middle. */
export function dayScale(n: number): string[] {
  if (n <= 1) return [viridis(VIRIDIS_TOP / 2)];
  return Array.from({ length: n }, (_, i) => viridis((i / (n - 1)) * VIRIDIS_TOP));
}

/** Everything past the last colour, folded together. */
export const OTHER_SLOT = MAX_DAY_SLOTS;
/** No day, no activity: the photographs the question has no answer for. */
export const NONE_SLOT = MAX_DAY_SLOTS + 1;
/** How many slots a map keeps count of, for every way of colouring it. */
export const SLOT_COUNT = MAX_DAY_SLOTS + 2;
const GREYS = ["#6b6a66", "#bdbcb6"];

/** Slot colours for everything but days: the eight hues, then the two greys, which the legend always names. */
export const SLOT_COLOURS: readonly string[] = [...RING_HUES, ...Array<string>(MAX_DAY_SLOTS - RING_HUES.length).fill(GREYS[0]), ...GREYS];

export type RingGroup = { slot: number; label: string; count: number };
export type Rings = { groups: RingGroup[]; photoSlot: (p: PhotoFeatureProps) => number; trackSlot: (t: TrackFeatureProps) => number; /** Each slot's colour for this way of colouring, by slot number. */ colours: string[] };

type Entry = { key: string; label: string; count: number; first: number };

const NONE_LABEL: Record<Exclude<ColourBy, "none">, string> = { day: "No date", activity: "Not on an activity", uploader: "Someone unknown" };
const OTHER_LABEL: Record<Exclude<ColourBy, "none">, string> = { day: "Other days", activity: "Other activities", uploader: "Everyone else" };

/**
 * Which colour each photograph's ring gets, and the legend that explains them.
 *
 * Days are in order and coloured along viridis, one colour a day, and past fourteen they are cut into fourteen runs
 * of neighbouring days — "Aug 3 – Aug 5" — rather than folded into a grey. Activities keep the order they happened in and
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

  const room = by === "day" ? MAX_DAY_SLOTS : RING_HUES.length;
  // The year is worth saying only when the days shown are in more than one of them.
  const years = by === "day" && new Set(order.map((e) => e.key.slice(0, 4))).size > 1;
  if (order.length <= room) {
    order.forEach((e, i) => {
      slotOfKey.set(e.key, i);
      groups.push({ slot: i, label: by === "day" ? formatDay(e.key, years ? "shortYear" : "shortDay") : e.label, count: e.count });
    });
  } else if (by === "day") {
    const style = years ? "shortYear" : "short";
    for (let slot = 0; slot < room; slot++) {
      const run = order.filter((_, i) => Math.floor((i * room) / order.length) === slot);
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
  // Days take as many steps along the scale as there are colours in use, so a three-day trip spans dark to bright
  // rather than using the first three fourteenths of it.
  const colours = by === "day" ? [...dayScale(Math.min(order.length, room)), ...Array<string>(room).fill(GREYS[0])].slice(0, MAX_DAY_SLOTS).concat(GREYS) : [...SLOT_COLOURS];
  return { groups, photoSlot: slot, trackSlot: slot, colours };
}

import { z } from "zod";
import { TZDate } from "@date-fns/tz";
import { ACTIVITY_TYPES } from "./types";
import { dateColumnToDay, localDayInZone, wallTimeToInstant, type LocalDay } from "@/lib/time/local-day";

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "Pick a date and time");

export const activityInputSchema = z
  .object({
    title: z.string().trim().min(1, "Give the activity a title").max(120),
    type: z.enum(ACTIVITY_TYPES as [string, ...string[]]),
    start: localDateTime,
    end: localDateTime,
    description: z.string().trim().max(4000).optional().transform((v) => v || null),
  })
  .refine((v) => v.end >= v.start, { message: "End must be after the start", path: ["end"] });

export type ActivityInput = z.infer<typeof activityInputSchema>;

export function activityInputFromForm(fd: FormData) {
  return activityInputSchema.safeParse({
    title: fd.get("title"),
    type: fd.get("type"),
    start: fd.get("start"),
    end: fd.get("end"),
    description: fd.get("description") ?? undefined,
  });
}

/** "2025-08-12T15:04" typed in the trip's zone -> UTC instant */
export function localInputToInstant(value: string, timezone: string): Date {
  const [d, t] = value.split("T");
  const [year, month, day] = d.split("-").map(Number);
  const [hour, minute, second = 0] = t.split(":").map(Number);
  return wallTimeToInstant({ year, month, day, hour, minute, second }, timezone);
}

/**
 * The stored instant when the submitted one is the same minute of it, else the submitted one. The form works in
 * whole minutes, so an activity made from a track (which ends at 15:42:37) would otherwise lose its seconds on
 * every save — even one that only changed the title — and photographs taken in them would drop off it.
 */
export function keepSeconds(submitted: Date, stored: Date): Date {
  return Math.floor(stored.getTime() / 60_000) === Math.floor(submitted.getTime() / 60_000) ? stored : submitted;
}

/**
 * A time typed into the edit form, as an instant: the stored one wherever the form sends back the wall time it was
 * shown. On the night the clocks go back, 01:30 happens twice and reads back as the first; one stored as the second
 * would otherwise move an hour on every save, taking its photographs with it.
 */
export function formTimeToInstant(value: string, stored: Date, timezone: string): Date {
  const z = new TZDate(stored, timezone);
  const pad = (n: number) => String(n).padStart(2, "0");
  const shown = `${z.getFullYear()}-${pad(z.getMonth() + 1)}-${pad(z.getDate())}T${pad(z.getHours())}:${pad(z.getMinutes())}`;
  if (value.slice(0, 16) === shown) return stored;
  return keepSeconds(localInputToInstant(value, timezone), stored);
}

/**
 * The day a new activity starts on, before anybody touches the form.
 *
 * Today, in the trip's own zone: an outing is nearly always written up the evening it happened, and the trip's
 * first morning — what this used to offer — was right exactly once per trip. Where today falls outside the trip,
 * it is pulled to the nearest day of it, because an activity dated outside its own trip gathers no photographs
 * and sits nowhere on the timeline. That covers both a fortnight being written up afterwards and one somebody is
 * planning ahead of.
 */
export function defaultActivityDay(trip: { startDate: Date; endDate: Date; timezone: string }, now: Date = new Date()): LocalDay {
  const today = localDayInZone(now, trip.timezone);
  const first = dateColumnToDay(trip.startDate);
  const last = dateColumnToDay(trip.endDate);
  return today < first ? first : today > last ? last : today;
}

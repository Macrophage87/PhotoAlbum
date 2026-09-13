import { z } from "zod";
import { wallTimeWithOffsetToInstant, type LocalDay } from "@/lib/time/local-day";

/**
 * Fixing a run of wrong dates at once.
 *
 * A timeline makes a bad date obvious: a box of scans all landed on the day they were scanned, or a camera whose
 * clock was never set put a whole afternoon in 2002. Both are one mistake repeated, so both want one correction
 * applied to the lot — either sliding every date by the same amount (the camera was wrong by so much) or moving
 * them all onto a day the family remembers (these are from the Maine trip, whatever the file says).
 */

export const MIN_YEAR = 1800;
export const MAX_YEAR = 2100;

export const shiftSchema = z.object({
  mode: z.literal("shift"),
  years: z.number().int().min(-200).max(200),
  months: z.number().int().min(-2400).max(2400),
  days: z.number().int().min(-100_000).max(100_000),
  minutes: z.number().int().min(-10_000_000).max(10_000_000),
});

export const daySchema = z.object({
  mode: z.literal("day"),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Keep each item's own time of day, so a morning shot stays before an evening one. */
  keepTime: z.boolean(),
});

export const datePlanSchema = z.discriminatedUnion("mode", [shiftSchema, daySchema]);
export type DatePlan = z.infer<typeof datePlanSchema>;

export type Dated = { takenAt: Date | null; tzOffsetMin: number | null };
export type Planned = { takenAt: Date; tzOffsetMin: number };

/** Nothing to do: a shift of zero moves nobody. */
export function isEmptyPlan(plan: DatePlan): boolean {
  return plan.mode === "shift" && plan.years === 0 && plan.months === 0 && plan.days === 0 && plan.minutes === 0;
}

const pad = (n: number) => String(n).padStart(2, "0");

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function wallOf(instant: Date, tzOffsetMin: number): Wall {
  const d = new Date(instant.getTime() + tzOffsetMin * 60_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Add whole years and months to a calendar date, holding the last day of a short month rather than rolling over. */
export function addMonths(wall: Wall, months: number): Wall {
  const total = (wall.year * 12 + (wall.month - 1)) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  return { ...wall, year, month, day: Math.min(wall.day, daysInMonth(year, month)) };
}

/**
 * What one item becomes under a plan, or null when the plan has nothing to say about it (a shift needs a date to
 * shift, and no correction may land outside the years a family photo can plausibly carry).
 *
 * `index` is the item's position in the selection: undated items moved onto a chosen day are spread a minute apart
 * from midday so the order they were in survives the move.
 */
export function planDate(item: Dated, plan: DatePlan, opts: { index: number; fallbackOffsetMin: number }): Planned | null {
  const tzOffsetMin = item.tzOffsetMin ?? opts.fallbackOffsetMin;
  if (plan.mode === "shift") {
    if (!item.takenAt) return null;
    const shifted = addMonths(wallOf(item.takenAt, tzOffsetMin), plan.years * 12 + plan.months);
    const at = new Date(wallTimeWithOffsetToInstant(shifted, tzOffsetMin).getTime() + (plan.days * 1440 + plan.minutes) * 60_000);
    return inRange(at, tzOffsetMin) ? { takenAt: at, tzOffsetMin } : null;
  }
  const [year, month, day] = plan.day.split("-").map(Number);
  const time = plan.keepTime && item.takenAt ? wallOf(item.takenAt, tzOffsetMin) : { hour: 12, minute: Math.min(opts.index, 719), second: 0 };
  const at = wallTimeWithOffsetToInstant({ year, month, day, hour: time.hour, minute: time.minute, second: time.second }, tzOffsetMin);
  return inRange(at, tzOffsetMin) ? { takenAt: at, tzOffsetMin } : null;
}

function inRange(at: Date, tzOffsetMin: number): boolean {
  if (Number.isNaN(at.getTime())) return false;
  const year = new Date(at.getTime() + tzOffsetMin * 60_000).getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

/** The day an instant falls on, for a plan that wants to name it. */
export function dayOf(instant: Date, tzOffsetMin: number): LocalDay {
  const w = wallOf(instant, tzOffsetMin);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

const unit = (n: number, one: string) => `${Math.abs(n)} ${one}${Math.abs(n) === 1 ? "" : "s"}`;

/** One line saying what the plan does, so nobody applies a correction to fifty photos without reading it back. */
export function describeDatePlan(plan: DatePlan): string {
  if (plan.mode === "day") return `Move them to ${plan.day}${plan.keepTime ? ", keeping each one's time of day" : ""}`;
  const parts: string[] = [];
  if (plan.years) parts.push(unit(plan.years, "year"));
  if (plan.months) parts.push(unit(plan.months, "month"));
  if (plan.days) parts.push(unit(plan.days, "day"));
  if (plan.minutes) {
    const h = Math.trunc(Math.abs(plan.minutes) / 60);
    const m = Math.abs(plan.minutes) % 60;
    if (h) parts.push(unit(h, "hour"));
    if (m) parts.push(unit(m, "minute"));
  }
  if (!parts.length) return "Leave them where they are";
  const sign = (plan.years || plan.months || plan.days || plan.minutes) < 0 ? "back" : "forward";
  return `Move them ${sign} ${parts.join(", ")}`;
}

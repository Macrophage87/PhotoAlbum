import { describe, expect, it } from "vitest";
import { addMonths, dayOf, describeDatePlan, isEmptyPlan, planDate, type DatePlan } from "@/lib/photos/bulk-date";

const item = (iso: string | null, tzOffsetMin: number | null = -240) => ({ takenAt: iso ? new Date(iso) : null, tzOffsetMin });
const opts = { index: 0, fallbackOffsetMin: 0 };
const shift = (over: Partial<Extract<DatePlan, { mode: "shift" }>>): DatePlan => ({ mode: "shift", years: 0, months: 0, days: 0, minutes: 0, ...over });

describe("adding months to a calendar date", () => {
  it("holds the last day of a short month rather than rolling into the next one", () => {
    expect(addMonths({ year: 2025, month: 1, day: 31, hour: 9, minute: 0, second: 0 }, 1)).toMatchObject({ year: 2025, month: 2, day: 28 });
    expect(addMonths({ year: 2024, month: 1, day: 31, hour: 9, minute: 0, second: 0 }, 1)).toMatchObject({ year: 2024, month: 2, day: 29 });
  });

  it("crosses years in both directions", () => {
    expect(addMonths({ year: 2025, month: 11, day: 3, hour: 0, minute: 0, second: 0 }, 3)).toMatchObject({ year: 2026, month: 2, day: 3 });
    expect(addMonths({ year: 2025, month: 2, day: 3, hour: 0, minute: 0, second: 0 }, -3)).toMatchObject({ year: 2024, month: 11, day: 3 });
  });
});

describe("shifting a run of dates", () => {
  it("moves a camera stuck in 2002 forward by whole years, keeping the time of day", () => {
    // 9:15 in the morning, four hours west of UTC.
    const next = planDate(item("2002-07-04T13:15:00Z"), shift({ years: 23 }), opts)!;
    expect(next.takenAt.toISOString()).toBe("2025-07-04T13:15:00.000Z");
    expect(next.tzOffsetMin).toBe(-240);
    expect(dayOf(next.takenAt, next.tzOffsetMin)).toBe("2025-07-04");
  });

  it("shifts by hours and minutes for a clock left in the wrong zone", () => {
    const next = planDate(item("2025-08-12T16:00:00Z"), shift({ minutes: -60 }), opts)!;
    expect(next.takenAt.toISOString()).toBe("2025-08-12T15:00:00.000Z");
  });

  it("adds days after the calendar arithmetic, so a month-end shift lands where it reads", () => {
    const next = planDate(item("2025-01-31T12:00:00Z", 0), shift({ months: 1, days: 1 }), opts)!;
    expect(dayOf(next.takenAt, 0)).toBe("2025-03-01");
  });

  it("leaves an undated item alone: there is nothing to shift", () => {
    expect(planDate(item(null), shift({ years: 1 }), opts)).toBeNull();
  });

  it("refuses a correction that lands outside the years a family photo can carry", () => {
    expect(planDate(item("2025-08-12T12:00:00Z"), shift({ years: 200 }), opts)).toBeNull();
    expect(planDate(item("2025-08-12T12:00:00Z"), shift({ days: -100_000 }), opts)).toBeNull();
  });
});

describe("moving a run of dates onto one day", () => {
  it("keeps each item's time of day, so the morning still comes before the evening", () => {
    const morning = planDate(item("2026-09-01T13:00:00Z"), { mode: "day", day: "1978-06-10", keepTime: true }, opts)!;
    const evening = planDate(item("2026-09-01T23:30:00Z"), { mode: "day", day: "1978-06-10", keepTime: true }, { ...opts, index: 1 })!;
    expect(dayOf(morning.takenAt, -240)).toBe("1978-06-10");
    expect(dayOf(evening.takenAt, -240)).toBe("1978-06-10");
    expect(morning.takenAt.getTime()).toBeLessThan(evening.takenAt.getTime());
  });

  it("drops the old time of day when asked to, and spreads scans a minute apart to keep their order", () => {
    const plan: DatePlan = { mode: "day", day: "1978-06-10", keepTime: false };
    const first = planDate(item("2026-09-01T23:30:00Z", 0), plan, { index: 0, fallbackOffsetMin: 0 })!;
    const second = planDate(item("2026-09-01T13:00:00Z", 0), plan, { index: 1, fallbackOffsetMin: 0 })!;
    expect(first.takenAt.toISOString()).toBe("1978-06-10T12:00:00.000Z");
    expect(second.takenAt.toISOString()).toBe("1978-06-10T12:01:00.000Z");
  });

  it("dates an item that had no date at all, reading the day in the trip's zone", () => {
    const next = planDate(item(null, null), { mode: "day", day: "1978-06-10", keepTime: true }, { index: 0, fallbackOffsetMin: -300 })!;
    expect(dayOf(next.takenAt, -300)).toBe("1978-06-10");
    expect(next.tzOffsetMin).toBe(-300);
  });
});

describe("saying what a correction does before it does it", () => {
  it("reads a shift back in plain words", () => {
    expect(describeDatePlan(shift({ years: -1, minutes: -90 }))).toBe("Move them back 1 year, 1 hour, 30 minutes");
    expect(describeDatePlan(shift({ days: 2 }))).toBe("Move them forward 2 days");
  });

  it("names the day a move lands on", () => {
    expect(describeDatePlan({ mode: "day", day: "1978-06-10", keepTime: true })).toBe("Move them to 1978-06-10, keeping each one's time of day");
    expect(describeDatePlan({ mode: "day", day: "1978-06-10", keepTime: false })).toBe("Move them to 1978-06-10");
  });

  it("knows a shift of nothing is not a correction", () => {
    expect(isEmptyPlan(shift({}))).toBe(true);
    expect(isEmptyPlan(shift({ minutes: 1 }))).toBe(false);
    expect(isEmptyPlan({ mode: "day", day: "1978-06-10", keepTime: true })).toBe(false);
  });
});

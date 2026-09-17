import { describe, expect, it } from "vitest";
import { monthsOf, type NavDay } from "@/components/timeline/TimelineNav";

const day = (key: string, count = 1): NavDay => ({ key, id: `day-${key}`, count });

describe("the panel beside the timeline", () => {
  it("gathers the days under their month, keeping the order the timeline is in", () => {
    const months = monthsOf([day("2025-08-10", 4), day("2025-08-11", 2), day("2025-09-01", 7)]);
    expect(months.map((m) => m.label)).toEqual(["August", "September"]);
    expect(months.map((m) => m.days.length)).toEqual([2, 1]);
    // The count beside a month is what is under it, so the panel says how much a fortnight holds without opening it.
    expect(months.map((m) => m.count)).toEqual([6, 7]);
  });

  it("names the year only where the album spans more than one", () => {
    expect(monthsOf([day("2025-08-10"), day("2025-09-01")]).map((m) => m.label)).toEqual(["August", "September"]);
    expect(monthsOf([day("2024-12-31"), day("2025-01-01")]).map((m) => m.label)).toEqual(["December 2024", "January 2025"]);
  });

  it("keeps the undated at the end, under their own heading", () => {
    const months = monthsOf([day("2025-08-10"), day("undated", 3)]);
    expect(months.map((m) => m.label)).toEqual(["August", "No date"]);
    expect(months[1].days[0].count).toBe(3);
  });

  it("starts a fresh month when the timeline comes back to one it has left", () => {
    // A collection gathers the same week across years, so the same month can appear more than once, apart.
    const months = monthsOf([day("2024-08-10"), day("2025-01-05"), day("2025-08-10")]);
    expect(months.map((m) => m.key)).toEqual(["2024-08", "2025-01", "2025-08"]);
  });
});

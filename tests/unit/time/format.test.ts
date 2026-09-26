import { describe, expect, it } from "vitest";
import { formatDay, formatTakenAt } from "@/lib/time/format";

describe("how a day is written", () => {
  it("carries the year on a timeline heading: an album spans decades, and August 12 alone places nothing", () => {
    expect(formatDay("1978-08-12", "weekday")).toBe("Saturday, August 12, 1978");
    expect(formatDay("2025-08-12", "long")).toBe("August 12, 2025");
  });

  it("keeps the rail short where every day shares a year, and adds the year where they do not", () => {
    expect(formatDay("2025-08-12", "short")).toBe("Aug 12");
    expect(formatDay("2025-08-12", "shortYear")).toBe("Aug 12, 2025");
  });

  it("names the weekday in a list of days to go to: a day is often remembered as the Saturday it was", () => {
    expect(formatDay("2025-08-12", "shortDay")).toBe("Tue, Aug 12");
    expect(formatDay("1978-08-12", "shortDay")).toBe("Sat, Aug 12");
  });
});

describe("when a photograph was taken (#75)", () => {
  const at = new Date("2026-07-05T03:00:00Z"); // 8 PM on July 4 in California

  it("reads its own clock, not UTC, when it has no trip", () => {
    expect(formatTakenAt(at, -420, null)).toBe("Sat, Jul 4, 2026 · 8:00 PM");
  });

  it("reads its own clock over the trip's zone when the two disagree", () => {
    expect(formatTakenAt(at, -420, "America/New_York")).toBe("Sat, Jul 4, 2026 · 8:00 PM");
  });

  it("falls back to the trip's zone, then UTC, when its offset is unknown", () => {
    expect(formatTakenAt(at, null, "America/New_York")).toBe("Sat, Jul 4, 2026 · 11:00 PM");
    expect(formatTakenAt(at, null, null)).toBe("Sun, Jul 5, 2026 · 3:00 AM");
  });
});

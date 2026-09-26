import { describe, expect, it } from "vitest";
import { formatDay, formatPace } from "@/lib/time/format";
import { formatClipDuration } from "@/components/photos/ClipTile";

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

describe("minutes and seconds", () => {
  it("carries a rounded-up minute instead of writing :60 (#138)", () => {
    expect(formatClipDuration(59.7)).toBe("1:00");
    expect(formatClipDuration(89.6)).toBe("1:30");
    expect(formatClipDuration(119.5)).toBe("2:00");
    expect(formatClipDuration(12.2)).toBe("0:12");
  });

  it("does the same for a pace", () => {
    expect(formatPace(1609.344 / 479.6)).toBe("8:00 /mi");
    expect(formatPace(1000 / 299.7, "km")).toBe("5:00 /km");
  });
});

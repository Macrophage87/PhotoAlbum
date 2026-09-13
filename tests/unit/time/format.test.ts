import { describe, expect, it } from "vitest";
import { formatDay } from "@/lib/time/format";

describe("how a day is written", () => {
  it("carries the year on a timeline heading: an album spans decades, and August 12 alone places nothing", () => {
    expect(formatDay("1978-08-12", "weekday")).toBe("Saturday, August 12, 1978");
    expect(formatDay("2025-08-12", "long")).toBe("August 12, 2025");
  });

  it("keeps the rail short where every day shares a year, and adds the year where they do not", () => {
    expect(formatDay("2025-08-12", "short")).toBe("Aug 12");
    expect(formatDay("2025-08-12", "shortYear")).toBe("Aug 12, 2025");
  });
});

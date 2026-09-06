import { describe, expect, it } from "vitest";
import { localDayFromOffset, localDayInZone, offsetMinutesInZone, parseOffsetString, wallTimeToInstant } from "@/lib/time/local-day";
import { formatDayRange } from "@/lib/time/format";

describe("local day helpers", () => {
  it("shifts by fixed offsets across midnight", () => {
    const t = new Date("2025-08-13T02:30:00Z");
    expect(localDayFromOffset(t, -240)).toBe("2025-08-12");
    expect(localDayFromOffset(t, 0)).toBe("2025-08-13");
    expect(localDayFromOffset(t, 600)).toBe("2025-08-13");
  });
  it("uses IANA zones", () => {
    const t = new Date("2025-08-13T02:30:00Z");
    expect(localDayInZone(t, "America/New_York")).toBe("2025-08-12");
    expect(localDayInZone(t, "Asia/Tokyo")).toBe("2025-08-13");
    expect(offsetMinutesInZone(t, "America/New_York")).toBe(-240);
    expect(offsetMinutesInZone(new Date("2025-01-13T02:30:00Z"), "America/New_York")).toBe(-300);
  });
  it("converts wall time in a zone to an instant", () => {
    expect(wallTimeToInstant({ year: 2025, month: 8, day: 12, hour: 15, minute: 4, second: 5 }, "America/New_York").toISOString()).toBe(
      "2025-08-12T19:04:05.000Z",
    );
  });
  it("parses offset strings", () => {
    expect(parseOffsetString("+02:00")).toBe(120);
    expect(parseOffsetString("-0430")).toBe(-270);
    expect(parseOffsetString("Z")).toBeNull();
  });
  it("formats day ranges", () => {
    expect(formatDayRange("2025-08-10", "2025-08-16")).toBe("Aug 10 – 16, 2025");
    expect(formatDayRange("2025-08-30", "2025-09-02")).toBe("Aug 30 – Sep 2, 2025");
    expect(formatDayRange("2025-12-28", "2026-01-03")).toBe("Dec 28, 2025 – Jan 3, 2026");
    expect(formatDayRange("2025-08-10", "2025-08-10")).toBe("Aug 10, 2025");
  });
});

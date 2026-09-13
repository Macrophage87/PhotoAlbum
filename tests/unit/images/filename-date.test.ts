import { describe, expect, it } from "vitest";
import { resolveFilenameTakenAt, wallTimeFromFilename } from "@/lib/images/filename-date";

describe("the date a phone writes into the file name", () => {
  const cases: [string, string][] = [
    ["IMG_20250812_143015.jpg", "2025-08-12 14:30:15"],
    ["PXL_20250812_143015123.MP.jpg", "2025-08-12 14:30:15"],
    ["VID_20250812_143015.mp4", "2025-08-12 14:30:15"],
    ["20250812_143015.jpg", "2025-08-12 14:30:15"],
    ["Screenshot_2025-08-12-14-30-15.png", "2025-08-12 14:30:15"],
    ["Screenshot 2025-08-12 at 14.30.15.png", "2025-08-12 14:30:15"],
    ["photo_2025-08-12_14-30-15.jpg", "2025-08-12 14:30:15"],
    ["2025-08-12 14.30.15.jpg", "2025-08-12 14:30:15"],
    ["signal-2025-08-12-143015.jpg", "2025-08-12 14:30:15"],
    // No time of day in it: the day is still worth having, and the timeline groups by day.
    ["IMG-20250812-WA0001.jpg", "2025-08-12 00:00:00"],
    ["2025-08-12.heic", "2025-08-12 00:00:00"],
  ];
  for (const [name, expected] of cases) {
    it(`reads ${name}`, () => {
      const w = wallTimeFromFilename(name)!;
      expect(w).not.toBeNull();
      const got = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}:${String(w.second).padStart(2, "0")}`;
      expect(got).toBe(expected);
    });
  }

  it("leaves a name that only looks like a date alone", () => {
    expect(wallTimeFromFilename("IMG_1234.jpg")).toBeNull();
    expect(wallTimeFromFilename("DSC_12345678.jpg")).toBeNull(); // 1234-56-78 is not a date
    expect(wallTimeFromFilename("20250230_120000.jpg")).toBeNull(); // no 30th of February
    expect(wallTimeFromFilename("scan_18500101.jpg")).toBeNull(); // before photography got to this family
    expect(wallTimeFromFilename("IMG_123456789012.jpg")).toBeNull(); // a longer run of digits is a serial number
  });

  it("reads the name in the trip's zone, and in UTC when there is no trip", () => {
    const maine = resolveFilenameTakenAt("IMG_20250812_143015.jpg", "America/New_York")!;
    expect(maine.source).toBe("FILE_NAME");
    expect(maine.wallDay).toBe("2025-08-12");
    expect(maine.tzOffsetMin).toBe(-240);
    expect(maine.takenAt.toISOString()).toBe("2025-08-12T18:30:15.000Z");
    const utc = resolveFilenameTakenAt("IMG_20250812_143015.jpg", null)!;
    expect(utc.takenAt.toISOString()).toBe("2025-08-12T14:30:15.000Z");
    expect(resolveFilenameTakenAt("holiday.jpg", null)).toBeNull();
  });
});

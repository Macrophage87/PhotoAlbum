import path from "node:path";
import { describe, expect, it } from "vitest";
import { cameraLabel, parseExifWallTime, readExif, resolveTakenAt } from "@/lib/images/exif";

const fx = (name: string) => path.join(__dirname, "../../fixtures", name);

describe("readExif", () => {
  it("reads date, offset, gps and camera from a geotagged photo", async () => {
    const e = await readExif(fx("photo-with-gps.jpg"));
    expect(e.dateTimeOriginal).toBe("2025:08:12 15:04:05");
    expect(e.offsetTimeOriginal).toBe("-04:00");
    expect(e.lat).toBeCloseTo(44.35, 4);
    expect(e.lng).toBeCloseTo(-68.2, 4);
    expect(e.altitude).toBe(120);
    expect(cameraLabel(e)).toBe("Apple iPhone 15 Pro");
    expect(e.fNumber).toBe(1.8);
    expect(e.iso).toBe(100);
  });

  it("returns nulls for a photo without EXIF", async () => {
    const e = await readExif(fx("photo-no-exif.jpg"));
    expect(e.dateTimeOriginal).toBeNull();
    expect(e.lat).toBeNull();
    expect(cameraLabel(e)).toBeNull();
  });
});

describe("resolveTakenAt", () => {
  const base = { subSec: null, lat: null, lng: null };

  it("uses the EXIF offset when present", () => {
    const r = resolveTakenAt({ ...base, dateTimeOriginal: "2025:08:12 15:04:05", offsetTimeOriginal: "-04:00" }, null);
    expect(r?.takenAt.toISOString()).toBe("2025-08-12T19:04:05.000Z");
    expect(r?.tzOffsetMin).toBe(-240);
    expect(r?.source).toBe("EXIF_OFFSET");
    expect(r?.wallDay).toBe("2025-08-12");
  });

  it("looks up the zone from GPS when there is no offset", () => {
    const r = resolveTakenAt({ ...base, dateTimeOriginal: "2025:08:12 15:04:05", offsetTimeOriginal: null, lat: 44.35, lng: -68.2 }, "Europe/London");
    expect(r?.takenAt.toISOString()).toBe("2025-08-12T19:04:05.000Z");
    expect(r?.source).toBe("EXIF_TZLOOKUP");
  });

  it("falls back to the trip zone, then UTC", () => {
    const trip = resolveTakenAt({ ...base, dateTimeOriginal: "2025:08:13 09:30:00", offsetTimeOriginal: null }, "America/New_York");
    expect(trip?.takenAt.toISOString()).toBe("2025-08-13T13:30:00.000Z");
    expect(trip?.source).toBe("TRIP_TZ");
    const utc = resolveTakenAt({ ...base, dateTimeOriginal: "2025:08:13 09:30:00", offsetTimeOriginal: null }, null);
    expect(utc?.takenAt.toISOString()).toBe("2025-08-13T09:30:00.000Z");
    expect(utc?.tzOffsetMin).toBe(0);
  });

  it("handles DST correctly for zone-based resolution", () => {
    const winter = resolveTakenAt({ ...base, dateTimeOriginal: "2025:01:15 09:00:00", offsetTimeOriginal: null }, "America/New_York");
    expect(winter?.tzOffsetMin).toBe(-300);
    const summer = resolveTakenAt({ ...base, dateTimeOriginal: "2025:07:15 09:00:00", offsetTimeOriginal: null }, "America/New_York");
    expect(summer?.tzOffsetMin).toBe(-240);
  });

  it("rejects garbage dates", () => {
    expect(parseExifWallTime("0000:00:00 00:00:00")).toBeNull();
    expect(parseExifWallTime("not a date")).toBeNull();
    expect(resolveTakenAt({ ...base, dateTimeOriginal: null, offsetTimeOriginal: null }, null)).toBeNull();
  });
});

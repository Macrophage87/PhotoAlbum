import { describe, expect, it } from "vitest";
import { frameNumber, guessDate, isWeakDate, surenessLabel, type Neighbour } from "@/lib/photos/date-from-neighbours";

const at = (iso: string) => new Date(iso);
const shot = (name: string, iso: string, tz = -240): Neighbour => ({ id: name, originalName: name, takenAt: at(iso), tzOffsetMin: tz });

describe("which dates are worth replacing", () => {
  it("counts a missing date, the file's clock and the created-date tag as weak", () => {
    expect(isWeakDate(null, null)).toBe(true);
    expect(isWeakDate("FILE_MTIME", at("2025-08-12T12:00:00Z"))).toBe(true);
    expect(isWeakDate("UPLOAD_TIME", at("2025-08-12T12:00:00Z"))).toBe(true);
    // The tag an editor rewrites on export: the reason a photo can show a date a year late.
    expect(isWeakDate("EXIF_CREATED", at("2026-09-01T12:00:00Z"))).toBe(true);
    expect(isWeakDate("EXIF_OFFSET", at("2025-08-12T12:00:00Z"))).toBe(false);
    expect(isWeakDate("FILE_NAME", at("2025-08-12T12:00:00Z"))).toBe(false);
    expect(isWeakDate("MANUAL", at("2025-08-12T12:00:00Z"))).toBe(false);
  });
});

describe("the camera's frame number", () => {
  it("reads the counter and what comes before it", () => {
    expect(frameNumber("IMG_2105.jpg")).toEqual({ prefix: "img_", n: 2105 });
    expect(frameNumber("DSC00042.JPG")).toEqual({ prefix: "dsc", n: 42 });
    expect(frameNumber("holiday.jpg")).toBeNull();
  });
});

describe("reading a date off the neighbours", () => {
  const roll = [shot("IMG_2104.jpg", "2025-08-12T18:31:00Z"), shot("IMG_2106.jpg", "2025-08-12T18:37:00Z"), shot("IMG_2200.jpg", "2025-08-14T15:00:00Z")];

  it("puts a frame between the two the camera numbered either side of it", () => {
    const g = guessDate({ id: "x", originalName: "IMG_2105.jpg" }, roll)!;
    expect(g.basis).toBe("sequence");
    expect(g.takenAt.toISOString()).toBe("2025-08-12T18:34:00.000Z"); // halfway between 2104 and 2106
    expect(g.confidence).toBeGreaterThan(0.8);
    expect(g.evidence).toContain("IMG_2104.jpg");
    expect(g.evidence).toContain("IMG_2106.jpg");
    // The evidence reads in the photo's own zone, not UTC: 18:31Z at -4 is 2:31 in the afternoon.
    expect(g.evidence).toContain("2:31 PM");
  });

  it("is less sure when the frames either side are hours apart", () => {
    const wide = [shot("IMG_2104.jpg", "2025-08-12T09:00:00Z"), shot("IMG_2106.jpg", "2025-08-12T21:00:00Z")];
    expect(guessDate({ id: "x", originalName: "IMG_2105.jpg" }, wide)!.confidence).toBeLessThan(0.7);
  });

  it("leans on a single close frame when there is only one side", () => {
    const g = guessDate({ id: "x", originalName: "IMG_2107.jpg" }, [shot("IMG_2106.jpg", "2025-08-12T18:37:00Z")])!;
    expect(g.basis).toBe("sequence");
    expect(g.evidence).toContain("just after IMG_2106.jpg");
    expect(g.confidence).toBeCloseTo(0.55, 2);
  });

  it("will not reach across a distant frame number", () => {
    // 2105 against 2400 is a different day's worth of shooting: say nothing from the numbering.
    const far = [shot("IMG_2400.jpg", "2025-08-14T15:00:00Z")];
    expect(guessDate({ id: "x", originalName: "IMG_2105.jpg" }, far)).toBeNull();
  });

  it("falls back to the photos it looks like, then to the trip's own span", () => {
    const looksLike = guessDate({ id: "x", originalName: "scan-of-a-print.jpg" }, roll, { similarIds: ["IMG_2104.jpg", "IMG_2106.jpg"] })!;
    expect(looksLike.basis).toBe("similar");
    expect(looksLike.evidence).toContain("looks most like");

    const onlyTrip = guessDate({ id: "x", originalName: "scan-of-a-print.jpg" }, [], {
      trip: { startDate: at("2025-08-10T00:00:00Z"), endDate: at("2025-08-16T00:00:00Z"), tzOffsetMin: -240 },
    })!;
    expect(onlyTrip.basis).toBe("trip");
    expect(onlyTrip.confidence).toBeLessThan(0.4); // a rough guess, and it says so
    expect(onlyTrip.evidence).toContain("7 days");
    expect(surenessLabel(onlyTrip.confidence)).toBe("a rough guess");
  });

  it("says nothing at all when the trip has nothing to say", () => {
    expect(guessDate({ id: "x", originalName: "scan.jpg" }, [])).toBeNull();
  });
});

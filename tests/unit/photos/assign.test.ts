import { describe, expect, it } from "vitest";
import { pickActivityByTime, pickTripByDay } from "@/lib/photos/assign";

const trip = (id: string, start: string, end: string) => ({ id, startDate: new Date(`${start}T00:00:00Z`), endDate: new Date(`${end}T00:00:00Z`) });

describe("pickTripByDay", () => {
  const trips = [trip("maine", "2025-08-10", "2025-08-16"), trip("scotland", "2025-09-01", "2025-09-14"), trip("overlap", "2025-08-15", "2025-08-20")];

  it("matches a day inside exactly one trip", () => {
    expect(pickTripByDay(trips, "2025-08-12")?.id).toBe("maine");
    expect(pickTripByDay(trips, "2025-09-14")?.id).toBe("scotland");
  });
  it("is inclusive of the start and end days", () => {
    expect(pickTripByDay(trips, "2025-08-10")?.id).toBe("maine");
    expect(pickTripByDay(trips, "2025-08-20")?.id).toBe("overlap");
  });
  it("returns null when no trip or when ambiguous", () => {
    expect(pickTripByDay(trips, "2025-07-01")).toBeNull();
    expect(pickTripByDay(trips, "2025-08-15")).toBeNull();
  });
});

describe("pickActivityByTime", () => {
  const a = (id: string, s: string, e: string) => ({ id, startTime: new Date(s), endTime: new Date(e) });
  const acts = [a("hike", "2025-08-12T13:00:00Z", "2025-08-12T17:00:00Z"), a("summit", "2025-08-12T15:00:00Z", "2025-08-12T15:30:00Z")];

  it("picks the containing activity", () => {
    expect(pickActivityByTime(acts, new Date("2025-08-12T14:00:00Z"))?.id).toBe("hike");
  });
  it("prefers the tighter window when nested", () => {
    expect(pickActivityByTime(acts, new Date("2025-08-12T15:10:00Z"))?.id).toBe("summit");
  });
  it("returns null outside every window", () => {
    expect(pickActivityByTime(acts, new Date("2025-08-12T18:00:00Z"))).toBeNull();
  });
});

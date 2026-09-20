import { describe, expect, it } from "vitest";
import { defaultActivityDay } from "@/lib/activities/validation";

const trip = { startDate: new Date("2025-08-10T00:00:00Z"), endDate: new Date("2025-08-16T00:00:00Z"), timezone: "America/New_York" };

describe("the day a new activity starts on", () => {
  it("is today while the trip is on, which is when outings are actually written up", () => {
    expect(defaultActivityDay(trip, new Date("2025-08-13T18:00:00Z"))).toBe("2025-08-13");
  });

  it("is today in the trip's zone, not the server's", () => {
    // Half past nine at night in Maine on the 12th is already the 13th in UTC. The form must say the 12th.
    expect(defaultActivityDay(trip, new Date("2025-08-13T01:30:00Z"))).toBe("2025-08-12");
    // And the other way: mid-morning UTC is still the same day there.
    expect(defaultActivityDay(trip, new Date("2025-08-13T13:00:00Z"))).toBe("2025-08-13");
  });

  it("falls back to the nearest day of the trip when today is outside it", () => {
    // An activity dated outside its own trip gathers no photographs and sits nowhere on the timeline, so a trip
    // written up months later starts on its last day rather than on a date that is not part of it.
    expect(defaultActivityDay(trip, new Date("2026-01-04T12:00:00Z"))).toBe("2025-08-16");
    expect(defaultActivityDay(trip, new Date("2025-02-01T12:00:00Z"))).toBe("2025-08-10");
  });

  it("holds at the edges rather than stepping over them", () => {
    expect(defaultActivityDay(trip, new Date("2025-08-10T16:00:00Z"))).toBe("2025-08-10");
    expect(defaultActivityDay(trip, new Date("2025-08-16T16:00:00Z"))).toBe("2025-08-16");
  });

  it("works for a one-day trip, where there is only ever one answer", () => {
    const day = { startDate: new Date("2025-08-10T00:00:00Z"), endDate: new Date("2025-08-10T00:00:00Z"), timezone: "UTC" };
    expect(defaultActivityDay(day, new Date("2025-09-01T12:00:00Z"))).toBe("2025-08-10");
  });
});

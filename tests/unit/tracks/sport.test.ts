import { describe, expect, it } from "vitest";
import { fallbackActivityType, sportToActivityType } from "@/lib/tracks/sport";

describe("sportToActivityType", () => {
  it("maps common FIT and GPX sport names", () => {
    expect(sportToActivityType("running")).toBe("RUN");
    expect(sportToActivityType("cycling")).toBe("BIKE");
    expect(sportToActivityType("Trail Running")).toBe("RUN");
    expect(sportToActivityType("hiking")).toBe("HIKE");
    expect(sportToActivityType("kayaking")).toBe("KAYAK");
    expect(sportToActivityType("driving")).toBe("DRIVE");
    expect(sportToActivityType("car")).toBe("DRIVE");
    expect(sportToActivityType("train")).toBe("DRIVE");
  });
  it("does not prefix-match unrelated sports as driving", () => {
    expect(sportToActivityType("training")).toBeNull();
    expect(sportToActivityType("transition")).toBeNull();
    expect(sportToActivityType("cardio")).toBeNull();
  });
});

describe("fallbackActivityType", () => {
  it("files a sport that is recognisably none of ours under OTHER instead of guessing from its speed", () => {
    expect(fallbackActivityType("alpine_skiing", 8)).toBe("OTHER");
    expect(fallbackActivityType("swimming", 1)).toBe("OTHER");
    expect(fallbackActivityType("Open Water Swimming", 1)).toBe("OTHER");
    expect(fallbackActivityType("Skifahren", 8)).toBe("OTHER");
    expect(fallbackActivityType("golf", 1)).toBe("OTHER");
  });
  it("guesses from speed when no sport, a catch-all, or an unrecognised name was given", () => {
    expect(fallbackActivityType(undefined, 8)).toBe("BIKE");
    expect(fallbackActivityType("", 3)).toBe("RUN");
    for (const catchAll of ["generic", "Generic", " ALL ", "none", "null", "undefined", "1", "multisport"]) expect(fallbackActivityType(catchAll, 8)).toBe("BIKE");
    expect(fallbackActivityType("Pyöräily", 8)).toBe("BIKE");
  });
  it("maps a few more outdoor FIT sports to their nearest type", () => {
    expect(sportToActivityType("mountaineering")).toBe("HIKE");
    expect(sportToActivityType("rafting")).toBe("KAYAK");
  });
  it("sees past where it was done to what was done", () => {
    expect(sportToActivityType("Outdoor Run")).toBe("RUN");
    expect(sportToActivityType("street_running")).toBe("RUN");
    expect(sportToActivityType("virtual_run")).toBe("RUN");
    expect(sportToActivityType("treadmill_running")).toBe("RUN");
    expect(sportToActivityType("e_mountain_biking")).toBe("BIKE");
    expect(sportToActivityType("Indoor Cycling")).toBe("BIKE");
  });
  it("understands a few common names in other languages", () => {
    expect(sportToActivityType("Laufen")).toBe("RUN");
    expect(sportToActivityType("Wandern")).toBe("HIKE");
    expect(sportToActivityType("Radfahren")).toBe("BIKE");
    expect(sportToActivityType("Vélo")).toBe("BIKE");
    expect(sportToActivityType("Randonnée")).toBe("HIKE");
  });
  it("splits Strava's CamelCase names", () => {
    expect(sportToActivityType("EMountainBikeRide")).toBe("BIKE");
    expect(sportToActivityType("EBikeRide")).toBe("BIKE");
    expect(sportToActivityType("VirtualRun")).toBe("RUN");
    expect(sportToActivityType("TrailRun")).toBe("RUN");
    for (const other of ["IceSkate", "RockClimbing", "WaterSki", "RollerSki", "WeightTraining", "Wakesurfing", "water_tubing", "wheelchair_push_run", "disc_golf", "hiit", "racket", "dance", "mixed_martial_arts", "team_sport"]) {
      expect(fallbackActivityType(other, 8)).toBe("OTHER");
    }
  });
  it("counts every FIT sport but its catch-alls as named", () => {
    expect(fallbackActivityType("pool_apnea", 1, true)).toBe("OTHER");
    expect(fallbackActivityType("grinding", 1, true)).toBe("OTHER");
    expect(fallbackActivityType("generic", 8, true)).toBe("BIKE");
    expect(fallbackActivityType("multisport", 8, true)).toBe("BIKE");
    // From a GPX <type>, an unknown word could be anything, so its speed decides.
    expect(fallbackActivityType("grinding", 8)).toBe("BIKE");
  });
  it("does not read a sport's word inside another sport", () => {
    expect(sportToActivityType("horseback_riding")).toBeNull();
    expect(sportToActivityType("motorcycling")).toBe("DRIVE");
    expect(fallbackActivityType("horseback_riding", 5)).toBe("OTHER");
  });
});

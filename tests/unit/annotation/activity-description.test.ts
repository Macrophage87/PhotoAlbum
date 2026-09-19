import { describe, expect, it } from "vitest";
import { ACTIVITY_INSTRUCTIONS, describeActivityItem, parseActivityDescription } from "@/lib/annotation/activity";

const walk = {
  id: "a1",
  title: "Ocean Path loop",
  type: "HIKE" as const,
  startTime: new Date("2025-08-12T13:00:00Z"),
  endTime: new Date("2025-08-12T14:49:00Z"),
  description: null as string | null,
  trip: { id: "t1", title: "Acadia", timezone: "America/New_York", annotationOptOut: false },
  track: { stats: { distanceM: 7930, movingTimeS: 2995, elevGainM: 118, avgHr: 136 } },
  photos: [
    { id: "p1", renditions: null, caption: "Otter Cliff from the path", title: null, context: null },
    { id: "p2", renditions: null, caption: null, title: null, context: null },
  ],
};

describe("what the helper is told about an outing", () => {
  it("gives it the title, the clock and what the track measured, in words a person would use", () => {
    const text = describeActivityItem(walk as never, []);
    expect(text).toContain('titled "Ocean Path loop"');
    expect(text).toContain("Trip: Acadia");
    // Read in the trip's own timezone, not UTC: the walk was an early afternoon one.
    expect(text).toMatch(/When: Tuesday, August 12, 2025, 9:00 AM to 10:49 AM/);
    expect(text).toContain("distance 4.93 mi");
    expect(text).toContain("moving for 49m 55s");
    expect(text).toContain("387 ft of climbing");
    expect(text).toContain("average heart rate 136");
  });

  it("passes on what the family already wrote, and asks for the names it is given", () => {
    const text = describeActivityItem(walk as never, ["Ada", "Ben"]);
    expect(text).toContain("- Otter Cliff from the path");
    expect(text).toContain("call them by these names rather than by age or role: Ada, Ben");
    expect(describeActivityItem(walk as never, [])).toContain("do not name anyone unless the captions do");
  });

  it("carries the note the family typed, marked as coming from somebody who was there", () => {
    const text = describeActivityItem(walk as never, [], "  It was Dad's birthday and we turned back at the fog.  ");
    expect(text).toContain("A note from the family, written by somebody who was there");
    expect(text).toContain("It was Dad's birthday and we turned back at the fog.");
    // The note is the last thing said, so it is read against everything before it.
    expect(text.trimEnd().endsWith("we turned back at the fog.")).toBe(true);
    // And the instructions tell it what to do with one, rather than leaving it as loose text in the prompt.
    expect(ACTIVITY_INSTRUCTIONS).toContain("note from the family");
  });

  it("says nothing about a note when there is none, including one that is only spaces", () => {
    expect(describeActivityItem(walk as never, [])).not.toContain("A note from the family");
    expect(describeActivityItem(walk as never, [], "   ")).not.toContain("A note from the family");
  });

  it("says outright that an existing description is being replaced, rather than leaving it to be guessed at", () => {
    expect(describeActivityItem({ ...walk, description: "An old one" } as never, [])).toContain("already a description");
  });

  it("never invents figures it was not given", () => {
    const bare = describeActivityItem({ ...walk, track: null } as never, []);
    expect(bare).not.toContain("The track recorded");
    expect(ACTIVITY_INSTRUCTIONS).toContain("Never invent a distance");
  });
});

describe("reading the answer back", () => {
  it("takes a description and refuses anything else", () => {
    expect(parseActivityDescription([{ type: "text", text: '{"description":"A steady walk along the shore."}' }])?.description).toBe("A steady walk along the shore.");
    // Empty, absent or unparseable all mean "nothing to save", not "save nothing".
    expect(parseActivityDescription([{ type: "text", text: '{"description":"   "}' }])).toBeNull();
    expect(parseActivityDescription([{ type: "text", text: "{}" }])).toBeNull();
    expect(parseActivityDescription([{ type: "text", text: "not json" }])).toBeNull();
    expect(parseActivityDescription([])).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { CONTAINER_INSTRUCTIONS, describeContainerItem } from "@/lib/annotation/container";

const photo = (id: string, caption: string | null) => ({ id, renditions: null, caption, title: null, context: null });

const trip = {
  kind: "trip" as const,
  id: "t1",
  title: "Acadia",
  description: null as string | null,
  annotationOptOut: false,
  dates: { start: new Date("2025-08-10T00:00:00Z"), end: new Date("2025-08-16T00:00:00Z") },
  activities: ["Ocean Path loop", "Cadillac at dawn"],
  count: 214,
  photos: [photo("p1", "Lobster rolls on the mail boat"), photo("p2", null)],
};

const gathering = { ...trip, kind: "collection" as const, id: "c1", title: "Best of 2025", dates: null, activities: [], count: 40 };

describe("what the helper is told about a trip or a gathering", () => {
  it("names which kind of thing it is, when it was, and what the outings in it were called", () => {
    const text = describeContainerItem(trip as never, []);
    expect(text).toContain('Trip: "Acadia"');
    expect(text).toMatch(/When: Aug 10 – 16, 2025/);
    expect(text).toContain("Ocean Path loop, Cadillac at dawn");
  });

  it("says outright that it is seeing a sample, so it does not describe a fortnight as eleven photographs", () => {
    // Without this the helper writes about the handful it was shown as though that were the whole trip.
    const text = describeContainerItem(trip as never, []);
    expect(text).toContain("It holds 214 photographs; you are being shown 2 of them, spread across the whole of it.");
    expect(CONTAINER_INSTRUCTIONS).toContain("never imply that what you were shown is all there is");
  });

  it("leaves out the dates and the outings for a gathering, which has neither", () => {
    const text = describeContainerItem(gathering as never, []);
    expect(text).toContain('Collection: "Best of 2025"');
    expect(text).not.toContain("When:");
    expect(text).not.toContain("The outings");
  });

  it("passes on what the family already wrote, and asks for the names it is given", () => {
    expect(describeContainerItem(trip as never, ["Ada"])).toContain("- Lobster rolls on the mail boat");
    expect(describeContainerItem(trip as never, ["Ada"])).toContain("call them by these names rather than by age or role: Ada");
    expect(describeContainerItem(trip as never, [])).toContain("do not name anyone unless the captions do");
  });

  it("carries the note the family typed last, and nothing when there is none", () => {
    const text = describeContainerItem(trip as never, [], "  It rained the whole first week.  ");
    expect(text).toContain("A note from the family, written by somebody who was there");
    expect(text.trimEnd().endsWith("It rained the whole first week.")).toBe(true);
    expect(describeContainerItem(trip as never, [], "   ")).not.toContain("A note from the family");
    expect(CONTAINER_INSTRUCTIONS).toContain("note from the family");
  });

  it("says when it is replacing a description rather than leaving that to be guessed at", () => {
    expect(describeContainerItem({ ...trip, description: "An old one" } as never, [])).toContain("already a description");
  });
});

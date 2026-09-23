import { describe, expect, it } from "vitest";
import { NONE_SLOT, OTHER_SLOT, RING_HUES, ringsFor } from "@/lib/map/colour-by";
import type { PhotoFeatureProps, TrackFeatureProps } from "@/lib/map/geojson";

const photo = (id: string, over: Partial<PhotoFeatureProps> = {}): PhotoFeatureProps => ({
  id, thumbUrl: "", mediumUrl: "", caption: null, takenAt: "2025-08-12T12:00:00Z", tripSlug: "", tripTitle: "", activityId: null, gpsSource: null,
  day: "2025-08-12", activityTitle: null, uploaderId: null, uploaderName: null, ...over,
});
const track = (over: Partial<TrackFeatureProps> = {}): TrackFeatureProps => ({
  trackId: "t", activityId: null, activityTitle: null, activityType: null, source: "GPX", name: "", tripSlug: "", tripTitle: "", color: "", startTime: "2025-08-12T09:00:00Z", distanceM: null,
  day: "2025-08-12", uploaderId: null, uploaderName: null, ...over,
});

describe("coloring the map's rings", () => {
  it("gives each day its own color, in order, and names the undated", () => {
    const photos = [photo("a", { day: "2025-08-13" }), photo("b", { day: "2025-08-12" }), photo("c", { day: "2025-08-12" }), photo("d", { day: null, takenAt: null })];
    const rings = ringsFor("day", photos, []);
    expect(rings.groups.map((g) => [g.slot, g.count])).toEqual([[0, 2], [1, 1], [NONE_SLOT, 1]]);
    expect(rings.groups.at(-1)!.label).toBe("No date");
    expect(photos.map(rings.photoSlot)).toEqual([1, 0, 0, NONE_SLOT]);
  });

  it("cuts a long trip into runs of neighboring days rather than folding most of it into one gray", () => {
    const days = Array.from({ length: 20 }, (_, i) => `2025-08-${String(i + 1).padStart(2, "0")}`);
    const rings = ringsFor("day", days.map((day, i) => photo(`p${i}`, { day })), []);
    expect(rings.groups).toHaveLength(RING_HUES.length);
    expect(rings.groups.some((g) => g.slot === OTHER_SLOT)).toBe(false);
    // Every photograph is somewhere, the runs are in order, and a run reads as a range.
    expect(rings.groups.reduce((n, g) => n + g.count, 0)).toBe(20);
    expect(rings.groups[0].label).toMatch(/–/);
    const slots = days.map((day, i) => rings.photoSlot(photo(`p${i}`, { day })));
    expect([...slots].sort((a, b) => a - b)).toEqual(slots);
  });

  it("colors a walk's track the same as the photographs taken on it, and keeps activities in the order they happened", () => {
    const photos = [photo("x", { activityId: "swim", activityTitle: "Swim", takenAt: "2025-08-12T16:00:00Z" }), photo("y", { activityId: "walk", activityTitle: "Walk", takenAt: "2025-08-12T10:00:00Z" }), photo("z")];
    const rings = ringsFor("activity", photos, [track({ activityId: "walk", activityTitle: "Walk" })]);
    expect(rings.groups.map((g) => g.label)).toEqual(["Walk", "Swim", "Not on an activity"]);
    expect(rings.trackSlot(track({ activityId: "walk" }))).toBe(rings.photoSlot(photos[1]));
    expect(rings.photoSlot(photos[2])).toBe(NONE_SLOT);
  });

  it("past eight people, keeps colors for the seven with the most photographs and folds the rest together", () => {
    const photos = Array.from({ length: 10 }, (_, u) => Array.from({ length: u + 1 }, (_, k) => photo(`${u}-${k}`, { uploaderId: `u${u}`, uploaderName: `Person ${String.fromCharCode(65 + u)}` }))).flat();
    const rings = ringsFor("uploader", photos, []);
    expect(rings.groups).toHaveLength(RING_HUES.length);
    const other = rings.groups.find((g) => g.slot === OTHER_SLOT)!;
    expect(other.label).toBe("Everyone else");
    // A, B and C have the fewest photographs (1 + 2 + 3).
    expect(other.count).toBe(6);
    expect(rings.photoSlot(photos[0])).toBe(OTHER_SLOT);
    // The ones kept are in alphabetical order, so a person's color does not depend on how busy they were.
    expect(rings.groups.slice(0, 7).map((g) => g.label)).toEqual(["D", "E", "F", "G", "H", "I", "J"].map((c) => `Person ${c}`));
  });
});

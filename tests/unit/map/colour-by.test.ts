import { describe, expect, it } from "vitest";
import { dayScale, MAX_DAY_SLOTS, NONE_SLOT, OTHER_SLOT, RING_HUES, ringsFor, SLOT_COLOURS, SLOT_COUNT, viridis } from "@/lib/map/colour-by";
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
    expect(rings.groups).toHaveLength(MAX_DAY_SLOTS);
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

describe("coloring days along viridis", () => {
  // Relative luminance, near enough to say which of two colors is the lighter.
  const light = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  it("runs from viridis's dark purple towards its yellow, getting steadily lighter", () => {
    expect(viridis(0)).toBe("#440154");
    expect(viridis(1)).toBe("#fde725");
    const scale = dayScale(10);
    for (let i = 1; i < scale.length; i++) expect(light(scale[i])).toBeGreaterThan(light(scale[i - 1]));
    // Short of the palest yellow, which a thin ring on a pale map would lose.
    expect(scale.at(-1)).not.toBe("#fde725");
  });

  it("spreads a short trip over the whole scale, so three days are dark, middle and bright", () => {
    const photos = ["2025-08-10", "2025-08-11", "2025-08-12"].map((day, i) => photo(`d${i}`, { day }));
    const rings = ringsFor("day", photos, []);
    expect(rings.colours.slice(0, 3)).toEqual(dayScale(3));
    expect(light(rings.colours[2]) - light(rings.colours[0])).toBeGreaterThan(0.4);
    expect(rings.colours).toHaveLength(SLOT_COUNT);
  });

  it("names the year only when the days are in more than one", () => {
    const one = ringsFor("day", [photo("a", { day: "2025-08-10" }), photo("b", { day: "2025-08-11" })], []);
    expect(one.groups[0].label).not.toMatch(/2025/);
    const two = ringsFor("day", [photo("a", { day: "2024-12-31" }), photo("b", { day: "2025-01-01" })], []);
    expect(two.groups.map((g) => g.label).join(" ")).toMatch(/2024.*2025/);
  });

  it("leaves activities and people on the set of separate hues", () => {
    const rings = ringsFor("activity", [photo("a", { activityId: "walk", activityTitle: "Walk" })], []);
    expect(rings.colours).toEqual([...SLOT_COLOURS]);
    expect(rings.colours.slice(0, RING_HUES.length)).toEqual([...RING_HUES]);
  });
});

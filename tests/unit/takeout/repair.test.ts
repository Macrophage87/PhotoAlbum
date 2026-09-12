import { describe, expect, it } from "vitest";
import { describeRepair, planSidecarRepair, type RepairTarget } from "@/lib/takeout/repair";
import type { SidecarData } from "@/lib/takeout/sidecar";

const sidecar: SidecarData = { title: "IMG_2001.jpg", description: "Otter Cliff from the Ocean Path", takenAt: new Date("2025-08-12T13:30:00Z"), lat: 44.3186, lng: -68.1917, googleId: "AF1QipAbc" };
const bare: RepairTarget = { lat: null, lng: null, gpsSource: null, takenAt: null, takenAtSource: null, context: null, caption: null, sourceId: null, originalName: "IMG_2001.jpg" };

describe("what a Takeout sidecar may fill in", () => {
  it("fills every gap on a photo that has none of it", () => {
    const plan = planSidecarRepair(bare, sidecar)!;
    expect(plan.filled.sort()).toEqual(["date", "googleId", "notes", "place"]);
    expect(plan.data).toMatchObject({ lat: 44.3186, lng: -68.1917, gpsSource: "SIDECAR", takenAtSource: "SIDECAR", context: "Otter Cliff from the Ocean Path", sourceId: "AF1QipAbc" });
    // The title is only the file name here, so it is not worth a caption.
    expect(plan.data.caption).toBeUndefined();
  });
  it("recovers a place the phone stripped, and a date the album only guessed from the file", () => {
    const stripped: RepairTarget = { ...bare, takenAt: new Date("2025-08-20T00:00:00Z"), takenAtSource: "FILE_MTIME", sourceId: "x" };
    const plan = planSidecarRepair(stripped, sidecar)!;
    expect(plan.filled.sort()).toEqual(["date", "notes", "place"]);
    expect(plan.data.takenAt).toEqual(sidecar.takenAt);
  });
  it("never overwrites the camera's own record or anything a member wrote", () => {
    const settled: RepairTarget = { lat: 10, lng: 20, gpsSource: "EXIF", takenAt: new Date("2025-08-12T13:00:00Z"), takenAtSource: "EXIF_OFFSET", context: "Nana's note", caption: "Ours", sourceId: "kept", originalName: "IMG_2001.jpg" };
    expect(planSidecarRepair(settled, sidecar)).toBeNull();
    const manual: RepairTarget = { ...settled, gpsSource: "MANUAL", takenAtSource: "MANUAL" };
    expect(planSidecarRepair(manual, sidecar)).toBeNull();
  });
  it("replaces a position only guessed from a track, and takes a title as a caption", () => {
    const fromTrack: RepairTarget = { ...bare, lat: 1, lng: 2, gpsSource: "TRACK", takenAt: new Date("2025-08-12T13:00:00Z"), takenAtSource: "EXIF_OFFSET", context: "kept", sourceId: "kept" };
    const plan = planSidecarRepair(fromTrack, { ...sidecar, title: "Otter Cliff" })!;
    expect(plan.filled.sort()).toEqual(["caption", "place"]);
    expect(plan.data).toMatchObject({ lat: 44.3186, gpsSource: "SIDECAR", caption: "Otter Cliff" });
    expect(plan.data.takenAt).toBeUndefined();
  });
  it("has nothing to say without a sidecar, or when the sidecar itself is empty", () => {
    expect(planSidecarRepair(bare, null)).toBeNull();
    expect(planSidecarRepair(bare, { title: null, description: null, takenAt: null, lat: null, lng: null, googleId: null })).toBeNull();
  });
  it("describes a repair in the words the admin page shows", () => {
    expect(describeRepair("IMG_2001.jpg", ["place", "date"])).toBe("IMG_2001.jpg: place, date");
  });
});

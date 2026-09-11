import { describe, expect, it } from "vitest";
import { albumFolderOf, candidateSidecarNames, pairSidecars, parseSidecar, splitCounter } from "@/lib/takeout/sidecar";

describe("sidecar pairing", () => {
  it("splits a counter suffix off the media name", () => {
    expect(splitCounter("IMG_001(1).jpg")).toEqual({ stem: "IMG_001.jpg", counter: "(1)" });
    expect(splitCounter("IMG_001.jpg")).toEqual({ stem: "IMG_001.jpg", counter: "" });
  });
  it("lists the current, truncated and legacy names, with the counter after the extension", () => {
    const names = candidateSidecarNames("IMG(1).jpg");
    expect(names[0]).toBe("IMG.jpg.supplemental-metadata(1).json");
    expect(names).toContain("IMG.jpg.supplemental-metadat(1).json");
    expect(names).toContain("IMG.jpg.s(1).json");
    expect(names).toContain("IMG.jpg(1).json");
  });
  it("pairs each form found in real exports and leaves unmatched media at null", () => {
    const paths = [
      "Takeout/Google Photos/Photos from 2025/a.jpg", "Takeout/Google Photos/Photos from 2025/a.jpg.supplemental-metadata.json",
      "Takeout/Google Photos/Photos from 2025/b.jpg", "Takeout/Google Photos/Photos from 2025/b.jpg.supplemental-metadat.json",
      "Takeout/Google Photos/Photos from 2025/c.mp4", "Takeout/Google Photos/Photos from 2025/c.mp4.supple.json",
      "Takeout/Google Photos/Photos from 2025/d.jpg", "Takeout/Google Photos/Photos from 2025/d.jpg.json",
      "Takeout/Google Photos/Photos from 2025/a(1).jpg", "Takeout/Google Photos/Photos from 2025/a.jpg(1).json",
      "Takeout/Google Photos/Photos from 2025/a-very-long-file-name-from-a-camera-20250812-123456.jpg", "Takeout/Google Photos/Photos from 2025/a-very-long-file-name-from-a-camera-20250812-1.json",
      "Takeout/Google Photos/Photos from 2025/e.jpg",
      "Takeout/Google Photos/Photos from 2025/metadata.json",
    ];
    const p = pairSidecars(paths);
    const dir = "Takeout/Google Photos/Photos from 2025/";
    expect(p.get(`${dir}a.jpg`)).toBe(`${dir}a.jpg.supplemental-metadata.json`);
    expect(p.get(`${dir}b.jpg`)).toBe(`${dir}b.jpg.supplemental-metadat.json`);
    expect(p.get(`${dir}c.mp4`)).toBe(`${dir}c.mp4.supple.json`);
    expect(p.get(`${dir}d.jpg`)).toBe(`${dir}d.jpg.json`);
    expect(p.get(`${dir}a(1).jpg`)).toBe(`${dir}a.jpg(1).json`);
    expect(p.get(`${dir}a-very-long-file-name-from-a-camera-20250812-123456.jpg`)).toBe(`${dir}a-very-long-file-name-from-a-camera-20250812-1.json`);
    expect(p.get(`${dir}e.jpg`)).toBeNull();
    expect(p.has(`${dir}metadata.json`)).toBe(false);
  });
  it("reads the date, a non-zero position, the description and the Google id", () => {
    const s = parseSidecar({ title: "x.jpg", description: "  Otter Cliff ", photoTakenTime: { timestamp: "1755005400" }, geoData: { latitude: 0, longitude: 0 }, geoDataExif: { latitude: 44.3, longitude: -68.2 }, url: "https://photos.google.com/photo/AF1QipAbc_-123" });
    expect(s.takenAt?.toISOString()).toBe("2025-08-12T13:30:00.000Z");
    expect(s).toMatchObject({ lat: 44.3, lng: -68.2, description: "Otter Cliff", googleId: "AF1QipAbc_-123", title: "x.jpg" });
    expect(parseSidecar({ geoData: { latitude: 0, longitude: 0 } })).toMatchObject({ lat: null, lng: null, takenAt: null, googleId: null });
    expect(parseSidecar(null).takenAt).toBeNull();
  });
  it("tells album folders from year bins", () => {
    expect(albumFolderOf("Takeout/Google Photos/Photos from 2019/a.jpg")).toBeNull();
    expect(albumFolderOf("Takeout/Google Photos/Lake House/a.jpg")).toBe("Lake House");
    expect(albumFolderOf("Takeout/Google Photos/Trash/a.jpg")).toBeNull();
    expect(albumFolderOf("Takeout/Google Photos/a.jpg")).toBeNull();
  });
});

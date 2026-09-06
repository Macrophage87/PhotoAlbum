import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGpx } from "@/lib/tracks/gpx";

const fx = (n: string) => readFileSync(path.join(__dirname, "../../fixtures", n), "utf8");

describe("parseGpx", () => {
  it("reads points, elevation, time and Garmin extensions", () => {
    const [t] = parseGpx(fx("sample-hr.gpx"));
    expect(t.name).toBe("Ocean Path loop");
    expect(t.sport).toBe("HIKE");
    expect(t.points).toHaveLength(600);
    const p = t.points[0];
    expect(p.lat).toBeCloseTo(44.35, 5);
    expect(p.lng).toBeCloseTo(-68.2, 5);
    expect(p.t).toBe(Date.parse("2025-08-12T13:00:00Z"));
    expect(p.ele).toBeCloseTo(50, 0);
    expect(p.hr).toBe(110);
    expect(p.cad).toBe(80);
  });
  it("handles other namespace prefixes and a missing type", () => {
    const [t] = parseGpx(fx("sample-ns3.gpx"));
    expect(t.sport).toBeNull();
    expect(t.points[10].hr).toBeGreaterThan(100);
    expect(t.points[10].cad).toBeGreaterThan(0);
  });
  it("parses a minimal GPX without elevation or extensions", () => {
    const [t] = parseGpx(fx("sample.gpx"));
    expect(t.points).toHaveLength(100);
    expect(t.points[0].ele).toBeUndefined();
    expect(t.points[0].hr).toBeUndefined();
  });
  it("skips points without time or coordinates", () => {
    const tracks = parseGpx(`<gpx><trk><trkseg><trkpt lat="1" lon="2"></trkpt><trkpt lat="1" lon="2"><time>2025-01-01T00:00:00Z</time></trkpt></trkseg></trk></gpx>`);
    expect(tracks[0].points).toHaveLength(1);
  });
});

describe("parseGpx edge cases", () => {
  const wrap = (pts: string) => `<?xml version="1.0"?><gpx version="1.1"><trk><name>t</name><trkseg>${pts}</trkseg></trk></gpx>`;

  it("treats empty <ele> and empty attributes as missing, not zero", () => {
    const xml = wrap(
      `<trkpt lat="44.0" lon="-68.0"><ele></ele><time>2025-01-01T10:00:00Z</time></trkpt>` +
        `<trkpt lat="44.001" lon="-68.0"><ele>1500</ele><time>2025-01-01T10:00:10Z</time></trkpt>` +
        `<trkpt lat="" lon="-68.1"><time>2025-01-01T10:00:20Z</time></trkpt>`,
    );
    const [track] = parseGpx(xml);
    expect(track.points).toHaveLength(2);
    expect(track.points[0].ele).toBeUndefined();
    expect(track.points[1].ele).toBe(1500);
  });

  it("reads times without a zone designator as UTC", () => {
    const [track] = parseGpx(wrap(`<trkpt lat="44" lon="-68"><time>2025-01-01T10:00:00</time></trkpt><trkpt lat="44.001" lon="-68"><time>2025-01-01T10:00:05.5Z</time></trkpt>`));
    expect(track.points[0].t).toBe(Date.parse("2025-01-01T10:00:00Z"));
    expect(track.points[1].t).toBe(Date.parse("2025-01-01T10:00:05.5Z"));
  });
});

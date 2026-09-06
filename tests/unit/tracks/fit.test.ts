import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFit } from "@/lib/tracks/fit";

describe("parseFit", () => {
  it("reads records and the session summary", async () => {
    const [t] = await parseFit(readFileSync(path.join(__dirname, "../../fixtures/sample.fit")));
    expect(t.points).toHaveLength(600);
    expect(t.sport).toBe("HIKE");
    const p = t.points[0];
    expect(p.lat).toBeCloseTo(44.35, 4);
    expect(p.lng).toBeCloseTo(-68.2, 4);
    expect(p.t).toBe(Date.parse("2025-08-12T13:00:00Z"));
    expect(p.ele).toBeCloseTo(50, 0);
    expect(p.hr).toBe(110);
    expect(p.cad).toBe(80);
    expect(p.spd).toBeCloseTo(1.2, 2);
    expect(p.pwr).toBe(150);
    expect(t.points[599].dist).toBeGreaterThan(3000);
    expect(t.session?.avgHr).toBe(135);
    expect(t.session?.maxHr).toBe(150);
    expect(t.session?.elevGainM).toBe(125);
    expect(t.session?.calories).toBe(420);
    expect(t.session?.elapsedTimeS).toBe(2995);
    expect(t.session?.movingTimeS).toBe(2875);
    expect(t.session?.startTime?.toISOString()).toBe("2025-08-12T13:00:00.000Z");
  });
});

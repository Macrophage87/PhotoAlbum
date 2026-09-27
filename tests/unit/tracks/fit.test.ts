import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FitBaseType, FitEncoder } from "fit-file-parser";
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

const semi = (d: number) => Math.round(d * (2 ** 31 / 180));
const ts = (ms: number) => FitEncoder.toFitTimestamp(new Date(ms));
const T0 = Date.parse("2025-08-12T14:00:00Z");
const MIN = 60_000;

/**
 * A multisport file: a 30-minute paddle, a 5-minute transition, then an hour's hike, one record a minute. `shuffle`
 * writes the sessions out of order and leaves the hike's start time out, as some writers do.
 */
function multisportFit(shuffle = false): Buffer {
  const enc = new FitEncoder();
  enc.writeMessage(0, [
    { number: 0, size: 1, baseType: FitBaseType.Enum, value: 4 },
    { number: 4, size: 4, baseType: FitBaseType.Uint32, value: ts(T0) },
  ]);
  for (let m = 0; m <= 95; m++) {
    enc.writeMessage(20, [
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: ts(T0 + m * MIN) },
      { number: 0, size: 4, baseType: FitBaseType.Sint32, value: semi(44 + m * 0.001) },
      { number: 1, size: 4, baseType: FitBaseType.Sint32, value: semi(-68) },
    ], 1);
  }
  const session = (from: number, to: number, sport: number, distanceM: number, withStart = true) =>
    enc.writeMessage(18, [
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: ts(T0 + to * MIN) },
      ...(withStart ? [{ number: 2, size: 4, baseType: FitBaseType.Uint32, value: ts(T0 + from * MIN) }] : []),
      { number: 5, size: 1, baseType: FitBaseType.Enum, value: sport },
      { number: 7, size: 4, baseType: FitBaseType.Uint32, value: (to - from) * 60 * 1000 },
      { number: 9, size: 4, baseType: FitBaseType.Uint32, value: distanceM * 100 },
    ], withStart ? 2 : 3);
  const legs = [
    () => session(0, 30, 41, 3000), // kayaking
    () => session(30, 35, 3, 100), // transition
    () => session(35, 95, 17, 5000, !shuffle), // hiking
  ];
  for (const write of shuffle ? [legs[2], legs[0], legs[1]] : legs) write();
  return Buffer.from(enc.close());
}

describe("a FIT file that is cut off", () => {
  it("fails with an Error that says so, not the parser's bare string", async () => {
    const whole = readFileSync(path.join(process.cwd(), "tests/fixtures/sample.fit"));
    for (const cut of [whole.subarray(0, 5), whole.subarray(0, whole.length / 2)]) {
      const err = await parseFit(cut).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/^This FIT file is incomplete or damaged/);
    }
  });
});

describe("parseFit with several sessions", () => {
  it("makes one track per leg, each with its own sport, totals and times", async () => {
    const tracks = await parseFit(multisportFit());
    expect(tracks.map((t) => t.sport)).toEqual(["KAYAK", "HIKE"]);
    const [paddle, hike] = tracks;
    expect(paddle.points[0].t).toBe(T0);
    expect(paddle.points.at(-1)!.t).toBe(T0 + 29 * MIN);
    expect(paddle.session?.distanceM).toBe(3000);
    expect(paddle.session?.endTime?.getTime()).toBe(T0 + 30 * MIN);
    // The transition's minutes belong to neither leg.
    expect(hike.points[0].t).toBe(T0 + 35 * MIN);
    expect(hike.points).toHaveLength(61);
    expect(hike.session?.distanceM).toBe(5000);
    expect(hike.session?.elapsedTimeS).toBe(3600);
    expect(hike.session?.startTime?.getTime()).toBe(T0 + 35 * MIN);
    expect(hike.session?.endTime?.getTime()).toBe(T0 + 95 * MIN);
  });
  it("orders legs by time, and works out a missing start from the end and elapsed time", async () => {
    const tracks = await parseFit(multisportFit(true));
    expect(tracks.map((t) => t.sport)).toEqual(["KAYAK", "HIKE"]);
    expect(tracks.map((t) => t.points.length)).toEqual([30, 61]);
    expect(tracks[1].session?.startTime?.getTime()).toBe(T0 + 35 * MIN);
  });
});

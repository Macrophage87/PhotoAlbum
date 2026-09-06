import FitParser from "fit-file-parser";
import type { DeviceSession, ParsedTrack, TrackPoint } from "./types";
import { sportToActivityType } from "./sport";
import { semicirclesToDegrees } from "@/lib/geo/semicircles";

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Coordinates come back in degrees in list mode, but be tolerant of raw semicircles. */
function coord(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  if (Math.abs(n) > 180) return semicirclesToDegrees(n) ?? undefined;
  return n;
}

export async function parseFit(buffer: Buffer): Promise<ParsedTrack[]> {
  const fit = new FitParser({ force: true, speedUnit: "m/s", lengthUnit: "m", temperatureUnit: "celsius", elapsedRecordField: false, mode: "list" });
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const data = await fit.parseAsync(ab);
  const records = data.records ?? [];
  const points: TrackPoint[] = [];
  for (const r of records) {
    const rec = r as Record<string, unknown>;
    const ts = rec.timestamp instanceof Date ? rec.timestamp.getTime() : typeof rec.timestamp === "number" ? rec.timestamp : NaN;
    const lat = coord(rec.position_lat);
    const lng = coord(rec.position_long);
    if (!Number.isFinite(ts) || lat === undefined || lng === undefined) continue;
    const p: TrackPoint = { t: ts, lat, lng };
    const ele = num(rec.enhanced_altitude) ?? num(rec.altitude);
    const spd = num(rec.enhanced_speed) ?? num(rec.speed);
    if (ele !== undefined) p.ele = ele;
    if (spd !== undefined) p.spd = spd;
    const hr = num(rec.heart_rate), cad = num(rec.cadence), pwr = num(rec.power), dist = num(rec.distance), temp = num(rec.temperature);
    if (hr !== undefined) p.hr = hr;
    if (cad !== undefined) p.cad = cad;
    if (pwr !== undefined) p.pwr = pwr;
    if (dist !== undefined) p.dist = dist;
    if (temp !== undefined) p.temp = temp;
    points.push(p);
  }
  if (!points.length) return [];

  const s = (data.sessions?.[0] ?? {}) as Record<string, unknown>;
  const sportRaw = typeof s.sport === "string" ? s.sport : undefined;
  const subSport = typeof s.sub_sport === "string" ? s.sub_sport : undefined;
  const session: DeviceSession = {
    startTime: s.start_time instanceof Date ? s.start_time : undefined,
    endTime: s.timestamp instanceof Date ? s.timestamp : undefined,
    distanceM: num(s.total_distance),
    elapsedTimeS: num(s.total_elapsed_time),
    movingTimeS: num(s.total_moving_time) ?? num(s.total_timer_time),
    elevGainM: num(s.total_ascent),
    elevLossM: num(s.total_descent),
    avgSpeedMs: num(s.enhanced_avg_speed) ?? num(s.avg_speed),
    maxSpeedMs: num(s.enhanced_max_speed) ?? num(s.max_speed),
    avgHr: num(s.avg_heart_rate),
    maxHr: num(s.max_heart_rate),
    avgCadence: num(s.avg_cadence),
    maxCadence: num(s.max_cadence),
    avgPower: num(s.avg_power),
    maxPower: num(s.max_power),
    normalizedPower: num(s.normalized_power),
    calories: num(s.total_calories),
  };
  const sport = sportToActivityType(subSport && /trail|hik|walk|mountain|gravel/i.test(subSport) ? subSport : sportRaw) ?? sportToActivityType(sportRaw);
  return [{ name: sportRaw ? `${sportRaw[0].toUpperCase()}${sportRaw.slice(1)}` : "Activity", points, sport, sportRaw, session }];
}

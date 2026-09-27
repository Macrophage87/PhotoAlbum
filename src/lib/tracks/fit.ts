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

  const sessions = (data.sessions ?? []) as Record<string, unknown>[];
  // A multisport file (a triathlon, a paddle then a hike) holds one session per leg. Each leg becomes its own track
  // with its own sport, totals and times; lumping them together would describe the whole day by its first leg.
  const starts = sessions.map(sessionStart);
  if (sessions.length > 1 && starts.every((t) => t !== null)) {
    const order = sessions.map((_, i) => i).sort((a, b) => starts[a]! - starts[b]!);
    const legs: (Record<string, unknown> & { start_time: Date })[] = [];
    for (const i of order) {
      const leg: Record<string, unknown> & { start_time: Date } = { ...sessions[i], start_time: new Date(starts[i]!) };
      const prev = legs.at(-1);
      // A ride saved in several sessions of the same sport back to back (a head unit that started a new one after a
      // long stop, or two files joined) is one outing, not a leg per session.
      if (prev && prev.sport === leg.sport && prev.sub_sport === leg.sub_sport) legs[legs.length - 1] = joinSessions(prev, leg);
      else legs.push(leg);
    }
    if (legs.length === 1) return [toTrack(legs[0], points)];
    const legPoints = legs.map((): TrackPoint[] => []);
    for (const p of points) {
      let i = 0;
      while (i + 1 < legs.length && legs[i + 1].start_time.getTime() <= p.t) i++;
      legPoints[i].push(p);
    }
    // Transitions are the minutes spent changing kit between legs, not an outing of their own.
    return legs.flatMap((leg, i) => (legPoints[i].length && leg.sport !== "transition" ? [toTrack(leg, legPoints[i])] : []));
  }
  if (sessions.length > 1) {
    // Sessions that cannot all be placed in time cannot be split, and the first one's totals would describe the
    // whole file by its first part: the numbers come from the points instead, and the sport only where all agree.
    const same = sessions.every((x) => x.sport === sessions[0].sport && x.sub_sport === sessions[0].sub_sport);
    return [toTrack(same ? { sport: sessions[0].sport, sub_sport: sessions[0].sub_sport } : {}, points)];
  }
  return [toTrack(sessions[0] ?? {}, points)];
}

/**
 * Two sessions of one sport as one: totals add up, peaks are the higher, and it runs from the first's start to the
 * second's end. Averages (and normalized power) cannot be put together from two averages alone, so they are left to
 * be worked out from the points, like anything either session left out.
 */
function joinSessions<T extends Record<string, unknown>>(a: T, b: Record<string, unknown>): T {
  const out: Record<string, unknown> = { sport: a.sport, sub_sport: a.sub_sport, start_time: a.start_time, timestamp: b.timestamp };
  const both = (k: string) => (num(a[k]) !== undefined && num(b[k]) !== undefined ? [num(a[k])!, num(b[k])!] : null);
  for (const k of ["total_distance", "total_moving_time", "total_timer_time", "total_ascent", "total_descent", "total_calories"]) {
    const v = both(k);
    if (v) out[k] = v[0] + v[1];
  }
  for (const k of ["enhanced_max_speed", "max_speed", "max_heart_rate", "max_cadence", "max_power"]) {
    const v = both(k);
    if (v) out[k] = Math.max(v[0], v[1]);
  }
  return out as T;
}

/** A session's start, worked out from its end and elapsed time when a writer left start_time out. */
function sessionStart(s: Record<string, unknown>): number | null {
  if (s.start_time instanceof Date) return s.start_time.getTime();
  const elapsed = num(s.total_elapsed_time);
  return s.timestamp instanceof Date && elapsed !== undefined ? s.timestamp.getTime() - elapsed * 1000 : null;
}

function toTrack(s: Record<string, unknown>, points: TrackPoint[]): ParsedTrack {
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
  return { name: sportRaw ? `${sportRaw[0].toUpperCase()}${sportRaw.slice(1)}` : "Activity", points, sport, sportRaw, session };
}

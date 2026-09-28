import type { ActivityType } from "@/generated/prisma/enums";

/** One sample. `t` is a UTC epoch in milliseconds. Optional sensors are undefined when absent. */
export type TrackPoint = {
  t: number;
  lat: number;
  lng: number;
  ele?: number;
  hr?: number;
  cad?: number;
  pwr?: number;
  spd?: number; // m/s from the device
  dist?: number; // cumulative metres from the device
  temp?: number;
  /**
   * Not a recorded fix but filled in by the importer: "visit" anywhere inside a Google visit (see fillStays), at the
   * visit's place or copied from a fix recorded inside it; "interpolated" where it was worked out between points
   * outside any visit (a local midnight between two recorded fixes).
   */
  filled?: "visit" | "interpolated";
};

/** Summary numbers a device computed itself (FIT session). These win over our own estimates. */
export type DeviceSession = {
  startTime?: Date;
  endTime?: Date;
  distanceM?: number;
  elapsedTimeS?: number;
  movingTimeS?: number;
  elevGainM?: number;
  elevLossM?: number;
  avgSpeedMs?: number;
  maxSpeedMs?: number;
  avgHr?: number;
  maxHr?: number;
  avgCadence?: number;
  maxCadence?: number;
  avgPower?: number;
  maxPower?: number;
  normalizedPower?: number;
  calories?: number;
};

export type ParsedTrack = {
  name: string;
  points: TrackPoint[];
  sport: ActivityType | null;
  sportRaw?: string;
  session?: DeviceSession;
};

export type TrackStatsResult = {
  distanceM: number;
  movingTimeS: number;
  elapsedTimeS: number;
  elevGainM: number | null;
  elevLossM: number | null;
  minEleM: number | null;
  maxEleM: number | null;
  avgSpeedMs: number | null;
  maxSpeedMs: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  maxCadence: number | null;
  avgPower: number | null;
  maxPower: number | null;
  normalizedPower: number | null;
  calories: number | null;
};

/** Column-oriented points as stored (gzipped JSON). `t` is seconds since `startTime`. */
export type ColumnarPoints = {
  t: number[];
  lat: number[];
  lng: number[];
  ele?: number[];
  hr?: number[];
  cad?: number[];
  pwr?: number[];
  spd?: number[];
  dist?: number[];
  /** 0 recorded, 1 filled at a visit, 2 interpolated (see TrackPoint.filled); absent in older blobs. */
  filled?: (0 | 1 | 2)[];
};

import { db } from "@/lib/db";
import type { ActivityType, TrackSource } from "@/generated/prisma/enums";
import { boundsOf } from "@/lib/geo/bounds";
import { cleanPoints } from "./clean";
import { encodePoints } from "./encode";
import { simplifyLine } from "./simplify";
import { computeStats, mergeStats } from "./stats";
import type { ParsedTrack } from "./types";
import { guessTypeFromSpeed } from "./sport";
import { reassignPhotosForActivity } from "@/lib/activities/reassign";

export type PersistOptions = {
  tripId: string;
  userId: string;
  source: TrackSource;
  originalFile?: string;
  /** Create a linked Activity (GPX/FIT). Google traces stay bare tracks. */
  createActivity: boolean;
  activityType?: ActivityType | null;
};

export type PersistedTrack = { trackId: string; activityId: string | null; name: string; pointCount: number; distanceM: number; type: ActivityType | null };

export async function persistTrack(parsed: ParsedTrack, opts: PersistOptions): Promise<PersistedTrack | null> {
  const points = cleanPoints(parsed.points);
  if (points.length < 2) return null;

  const isGoogle = opts.source === "GOOGLE";
  const computed = computeStats(points, { skipElevation: isGoogle, cyclingCadence: (opts.activityType ?? parsed.sport) === "BIKE" });
  const stats = mergeStats(computed, parsed.session);
  const { line } = simplifyLine(points, isGoogle ? 15 : 5);
  const { blob, startTime, endTime, flags } = encodePoints(points);
  const b = boundsOf(points)!;

  const track = await db.track.create({
    data: {
      tripId: opts.tripId,
      uploaderId: opts.userId,
      source: opts.source,
      name: parsed.name,
      originalFile: opts.originalFile,
      startTime,
      endTime,
      pointCount: points.length,
      minLat: b.minLat,
      maxLat: b.maxLat,
      minLng: b.minLng,
      maxLng: b.maxLng,
      simplified: line,
      pointsBlob: new Uint8Array(blob),
      hasElevation: flags.ele && !isGoogle,
      hasHeartRate: flags.hr,
      hasCadence: flags.cad,
      hasPower: flags.pwr,
      stats: { create: stats },
    },
  });

  let activityId: string | null = null;
  let type: ActivityType | null = opts.activityType ?? parsed.sport ?? null;
  if (opts.createActivity) {
    type = type ?? guessTypeFromSpeed(stats.avgSpeedMs);
    const activity = await db.activity.create({
      data: { tripId: opts.tripId, title: parsed.name, type, startTime: parsed.session?.startTime ?? startTime, endTime: parsed.session?.endTime ?? endTime, trackId: track.id },
    });
    activityId = activity.id;
    await reassignPhotosForActivity(activity.id);
  }
  return { trackId: track.id, activityId, name: parsed.name, pointCount: points.length, distanceM: stats.distanceM, type };
}

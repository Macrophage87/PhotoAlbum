import type { ActivityType } from "@/generated/prisma/enums";

const MAP: [RegExp, ActivityType][] = [
  [/^(running|run|trail_?run(ning)?|jog)/i, "RUN"],
  [/^(cycling|biking|bike|ride|mountain_?bik|gravel|e_?bik|road_?bik|virtual_?rid)/i, "BIKE"],
  [/^(hiking|hike|walking|walk|trekking|backpack|snowshoe|mountaineering)/i, "HIKE"],
  [/^(paddling|kayak|canoe|rowing|row|sup|stand_?up|paddle|rafting)/i, "KAYAK"],
  [/^(boating|sail|boat|motorboat|fishing)/i, "BOAT"],
  [/^(driving|drive|motorcycl|car$|car_|flying|flight|train$|train_|transit$|transport|bus$)/i, "DRIVE"],
];

/** FIT sport / GPX <type> string -> our activity type; null when unknown. */
export function sportToActivityType(raw: string | null | undefined): ActivityType | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  for (const [re, t] of MAP) if (re.test(s)) return t;
  return null;
}

/** Sport names that say nothing about what was done: FIT's catch-alls, and the numeric codes some GPX writers use. */
const UNNAMED = /^(generic|all|multisport|unknown|activity|\d+)$/;

/**
 * The type for a track whose sport did not map to one of ours. A sport that was named but has no type of its own
 * (swimming, skiing, golf) is OTHER: guessing from its speed would make a ski run a bike ride. Only a file that
 * names no sport at all is typed from its speed.
 */
export function fallbackActivityType(sportRaw: string | null | undefined, avgSpeedMs: number | null): ActivityType {
  const s = sportRaw?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return s && !UNNAMED.test(s) ? "OTHER" : guessTypeFromSpeed(avgSpeedMs);
}

/** Last resort: guess from average moving speed. */
export function guessTypeFromSpeed(avgSpeedMs: number | null): ActivityType {
  if (avgSpeedMs === null) return "HIKE";
  if (avgSpeedMs < 2.2) return "HIKE";
  if (avgSpeedMs < 4.2) return "RUN";
  if (avgSpeedMs < 12) return "BIKE";
  return "DRIVE";
}

import type { ActivityType } from "@/generated/prisma/enums";

const MAP: [RegExp, ActivityType][] = [
  [/^(running|run|trail_?run(ning)?|jog)/i, "RUN"],
  [/^(cycling|biking|bike|ride|mountain_?bik|gravel|e_?bik|road_?bik|virtual_?rid)/i, "BIKE"],
  [/^(hiking|hike|walking|walk|trekking|backpack|snowshoe)/i, "HIKE"],
  [/^(paddling|kayak|canoe|rowing|row|sup|stand_?up|paddle)/i, "KAYAK"],
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

/** Last resort: guess from average moving speed. */
export function guessTypeFromSpeed(avgSpeedMs: number | null): ActivityType {
  if (avgSpeedMs === null) return "HIKE";
  if (avgSpeedMs < 2.2) return "HIKE";
  if (avgSpeedMs < 4.2) return "RUN";
  if (avgSpeedMs < 12) return "BIKE";
  return "DRIVE";
}

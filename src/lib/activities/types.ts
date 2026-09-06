import type { ActivityType } from "@/generated/prisma/enums";

export const ACTIVITY_TYPES: ActivityType[] = ["HIKE", "BIKE", "RUN", "KAYAK", "BOAT", "DRIVE", "SIGHTSEEING", "FOOD", "OTHER"];

export const ACTIVITY_LABEL: Record<ActivityType, string> = {
  HIKE: "Hike",
  BIKE: "Bike ride",
  RUN: "Run",
  KAYAK: "Paddle",
  BOAT: "Boat",
  DRIVE: "Drive",
  SIGHTSEEING: "Sightseeing",
  FOOD: "Food & drink",
  OTHER: "Activity",
};

/** Map/legend colours stay constant across themes so activity types are always recognisable. */
export const ACTIVITY_COLOR: Record<ActivityType, string> = {
  HIKE: "#2e7d32",
  BIKE: "#1565c0",
  RUN: "#ef6c00",
  KAYAK: "#00838f",
  BOAT: "#283593",
  DRIVE: "#6d4c41",
  SIGHTSEEING: "#7b1fa2",
  FOOD: "#c62828",
  OTHER: "#546e7a",
};

/** Activities where fitness stats (distance, pace, HR…) are meaningful. */
export const FITNESS_TYPES = new Set<ActivityType>(["HIKE", "BIKE", "RUN", "KAYAK"]);

export function isFitnessType(t: ActivityType): boolean {
  return FITNESS_TYPES.has(t);
}

import type { ActivityType } from "@/generated/prisma/enums";
import { ACTIVITY_COLOR } from "@/lib/activities/types";

const paths: Record<ActivityType, string> = {
  HIKE: "M13 4a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm-3 3.5 2.5-1 1.8 2.6 3.2 1.2-.6 1.8-3.6-1.3-1.2 2.7 2.4 2.4V24h-2v-7l-2.3-2.2L9 20l-1.9-.6L9.3 12l.8-3.4L8 9.6 7 13H5.1l1.3-5.3L10 7.5zM4 20h3l1 4H4z",
  BIKE: "M5 19a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm14 0a4 4 0 1 1 0-8 4 4 0 0 1 0 8zM5 9l3 6h6l3-6h-2.5l-1.7 3.3H9.4L7.5 9zm7-6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  RUN: "M14 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM9.5 7 6 9.5 7 11l2.5-1.5L8 14l-3 2 1 2 3.5-2.2L11 18v6h2v-7l-1.8-3 .8-3 2.5 2.5L18 13l-1.2-1.5L13.5 8l-3-1z",
  KAYAK: "M2 12c6-4 14-4 20 0-6 4-14 4-20 0zm10-9 1 5h-2zm0 18 1-5h-2z",
  BOAT: "M3 16c2 0 2 1.5 4 1.5S9 16 11 16s2 1.5 4 1.5S17 16 19 16s2 1.5 4 1.5v2c-2 0-2-1.5-4-1.5s-2 1.5-4 1.5-2-1.5-4-1.5-2 1.5-4 1.5-2-1.5-4-1.5zM5 14l1-6h12l1 6zM11 3h2v5h-2z",
  DRIVE: "M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11h1a1 1 0 0 1 1 1v6h-2v1.5a1.5 1.5 0 0 1-3 0V18H8v1.5a1.5 1.5 0 0 1-3 0V18H3v-6a1 1 0 0 1 1-1zm2.4 0h9.2l-1-3H8.4zM6.5 15.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm11 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  SIGHTSEEING: "M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z",
  FOOD: "M7 2v8a3 3 0 0 0 2 2.8V22h2V12.8A3 3 0 0 0 13 10V2h-2v6h-1V2H8v6H7zm10 0c-2 0-3 3-3 6v5h1.5v9H17V2z",
  OTHER: "M12 2l2.4 7.2H22l-6.2 4.5 2.4 7.3L12 16.5 5.8 21l2.4-7.3L2 9.2h7.6z",
};

export function ActivityTypeIcon({ type, className = "w-5 h-5", colored = true }: { type: ActivityType; className?: string; colored?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill={colored ? ACTIVITY_COLOR[type] : "currentColor"} aria-hidden="true">
      <path d={paths[type]} />
    </svg>
  );
}

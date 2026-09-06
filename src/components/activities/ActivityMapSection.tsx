import type { ActivityType } from "@/generated/prisma/enums";
import type { PhotoCard } from "@/lib/photos/queries";
import { MiniMapSvg } from "@/components/map/MiniMapSvg";

/** Placeholder until Phase 3 wires MapLibre + charts. Shows the simplified route as SVG. */
export function ActivityMapSection({ track, activity }: { track: { id: string; simplified: unknown }; activity: { id: string; type: ActivityType; title: string }; photos: PhotoCard[]; tripSlug: string }) {
  const line = track.simplified as [number, number][];
  if (!line || line.length < 2) return null;
  return (
    <section className="rounded-theme border border-border bg-surface p-4">
      <MiniMapSvg line={line} type={activity.type} className="w-full max-h-72" />
    </section>
  );
}

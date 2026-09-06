import type { ActivityType } from "@/generated/prisma/enums";
import { formatDistance, formatDuration, formatElevation, formatPace, formatSpeed } from "@/lib/time/format";

export type StatsLike = {
  distanceM: number;
  movingTimeS: number;
  elapsedTimeS: number;
  elevGainM: number | null;
  elevLossM: number | null;
  avgSpeedMs: number | null;
  maxSpeedMs: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  avgPower: number | null;
  maxPower: number | null;
  normalizedPower: number | null;
  calories: number | null;
};

export function statRows(stats: StatsLike, type: ActivityType, compact = false): [string, string][] {
  const paceBased = type === "RUN" || type === "HIKE";
  const rows: [string, string | null][] = [
    ["Distance", formatDistance(stats.distanceM)],
    ["Moving time", formatDuration(stats.movingTimeS)],
    ["Elevation gain", stats.elevGainM !== null ? formatElevation(stats.elevGainM) : null],
    [paceBased ? "Avg pace" : "Avg speed", stats.avgSpeedMs ? (paceBased ? formatPace(stats.avgSpeedMs) : formatSpeed(stats.avgSpeedMs)) : null],
    ["Avg heart rate", stats.avgHr ? `${stats.avgHr} bpm` : null],
  ];
  if (!compact) {
    rows.push(
      ["Elapsed time", formatDuration(stats.elapsedTimeS)],
      ["Elevation loss", stats.elevLossM !== null ? formatElevation(stats.elevLossM) : null],
      ["Max speed", stats.maxSpeedMs ? formatSpeed(stats.maxSpeedMs) : null],
      ["Max heart rate", stats.maxHr ? `${stats.maxHr} bpm` : null],
      ["Avg cadence", stats.avgCadence ? `${stats.avgCadence} rpm` : null],
      ["Avg power", stats.avgPower ? `${stats.avgPower} W` : null],
      ["Normalized power", stats.normalizedPower ? `${stats.normalizedPower} W` : null],
      ["Max power", stats.maxPower ? `${stats.maxPower} W` : null],
      ["Calories", stats.calories ? `${stats.calories} kcal` : null],
    );
  }
  return rows.filter((r): r is [string, string] => r[1] !== null);
}

export function StatsGrid({ stats, type, compact = false }: { stats: StatsLike; type: ActivityType; compact?: boolean }) {
  const rows = statRows(stats, type, compact);
  return (
    <dl className={`grid gap-x-4 gap-y-2 ${compact ? "grid-cols-2 sm:grid-cols-5 text-sm" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"}`}>
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs text-muted">{k}</dt>
          <dd className={`font-medium ${compact ? "" : "text-lg"}`}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import type { LocalDay } from "./local-day";

export function formatDay(day: LocalDay, style: "long" | "short" | "weekday" = "long"): string {
  const d = new Date(`${day}T12:00:00Z`);
  const opts: Intl.DateTimeFormatOptions =
    style === "long"
      ? { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }
      : style === "weekday"
        ? { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }
        : { month: "short", day: "numeric", timeZone: "UTC" };
  return d.toLocaleDateString("en-US", opts);
}

/** "Aug 10 – 16, 2025" / "Dec 28, 2025 – Jan 3, 2026" */
export function formatDayRange(start: LocalDay, end: LocalDay): string {
  const s = new Date(`${start}T12:00:00Z`);
  const e = new Date(`${end}T12:00:00Z`);
  const sameYear = s.getUTCFullYear() === e.getUTCFullYear();
  const sameMonth = sameYear && s.getUTCMonth() === e.getUTCMonth();
  const md = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  if (start === end) return `${md(s)}, ${s.getUTCFullYear()}`;
  if (sameMonth) return `${md(s)} – ${e.getUTCDate()}, ${e.getUTCFullYear()}`;
  if (sameYear) return `${md(s)} – ${md(e)}, ${e.getUTCFullYear()}`;
  return `${md(s)}, ${s.getUTCFullYear()} – ${md(e)}, ${e.getUTCFullYear()}`;
}

/** Wall-clock time of an instant, using a fixed offset when known, else an IANA zone. */
export function formatLocalTime(instant: Date, tz: { offsetMin?: number | null; timezone?: string }, fmt = "h:mm a"): string {
  if (tz.offsetMin !== undefined && tz.offsetMin !== null) {
    const shifted = new Date(instant.getTime() + tz.offsetMin * 60_000);
    return format(new TZDate(shifted, "UTC"), fmt);
  }
  return format(new TZDate(instant, tz.timezone ?? "UTC"), fmt);
}

export function formatDateTime(instant: Date, timezone: string, fmt = "EEE, MMM d, yyyy · h:mm a"): string {
  return format(new TZDate(instant, timezone), fmt);
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function formatDistance(meters: number, unit: "km" | "mi" = "mi"): string {
  if (unit === "km") return `${(meters / 1000).toFixed(meters >= 10_000 ? 1 : 2)} km`;
  return `${(meters / 1609.344).toFixed(meters >= 16_093 ? 1 : 2)} mi`;
}

export function formatElevation(meters: number, unit: "m" | "ft" = "ft"): string {
  return unit === "m" ? `${Math.round(meters)} m` : `${Math.round(meters * 3.28084).toLocaleString()} ft`;
}

export function formatSpeed(ms: number, unit: "kmh" | "mph" = "mph"): string {
  return unit === "kmh" ? `${(ms * 3.6).toFixed(1)} km/h` : `${(ms * 2.23694).toFixed(1)} mph`;
}

/** min/mi pace from m/s */
export function formatPace(ms: number, unit: "km" | "mi" = "mi"): string {
  if (ms <= 0) return "–";
  const secPer = (unit === "km" ? 1000 : 1609.344) / ms;
  const m = Math.floor(secPer / 60);
  const s = Math.round(secPer % 60);
  return `${m}:${String(s).padStart(2, "0")} /${unit}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

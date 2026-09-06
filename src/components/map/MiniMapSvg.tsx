import type { ActivityType } from "@/generated/prisma/enums";
import { ACTIVITY_COLOR } from "@/lib/activities/types";

/** Tiny static route preview. SVG instead of a WebGL map so dozens can sit on one page. */
export function MiniMapSvg({ line, type, className = "" }: { line: [number, number][]; type?: ActivityType; className?: string }) {
  if (line.length < 2) return null;
  const lats = line.map((p) => p[0]);
  const lngs = line.map((p) => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
  const kx = Math.cos(midLat);
  const w = Math.max((maxLng - minLng) * kx, 1e-6), h = Math.max(maxLat - minLat, 1e-6);
  const W = 160, H = 120, pad = 8;
  const scale = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
  const ox = (W - w * scale) / 2, oy = (H - h * scale) / 2;
  const pts = line.map(([lat, lng]) => `${(ox + (lng - minLng) * kx * scale).toFixed(1)},${(oy + (maxLat - lat) * scale).toFixed(1)}`).join(" ");
  const color = type ? ACTIVITY_COLOR[type] : "var(--th-primary)";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts.split(" ")[0].split(",")[0]} cy={pts.split(" ")[0].split(",")[1]} r="3" fill="#fff" stroke={color} strokeWidth="2" />
    </svg>
  );
}

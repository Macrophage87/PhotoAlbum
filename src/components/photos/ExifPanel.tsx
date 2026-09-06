import { formatBytes, formatDateTime } from "@/lib/time/format";

type ExifJson = { exposureTime?: number | null; fNumber?: number | null; iso?: number | null; focalLength?: number | null; offsetTimeOriginal?: string | null };

function exposure(t: number | null | undefined) {
  if (!t) return null;
  return t >= 1 ? `${t}s` : `1/${Math.round(1 / t)}s`;
}

const takenAtLabel: Record<string, string> = {
  EXIF_OFFSET: "camera time with time zone",
  EXIF_TZLOOKUP: "camera time, zone from GPS",
  TRIP_TZ: "camera time in the trip's zone",
  FILE_MTIME: "file modified time",
  UPLOAD_TIME: "upload time",
  MANUAL: "set by hand",
};

export function ExifPanel({ photo, tripTimezone }: { photo: { takenAt: Date | null; takenAtSource: string | null; tzOffsetMin: number | null; lat: number | null; lng: number | null; altitude: number | null; gpsSource: string | null; camera: string | null; lens: string | null; exif: unknown; width: number | null; height: number | null; sizeBytes: number; originalName: string; mimeType: string }; tripTimezone?: string }) {
  const ex = (photo.exif ?? {}) as ExifJson;
  const rows: [string, string | null][] = [
    ["Taken", photo.takenAt ? formatDateTime(photo.takenAt, tripTimezone ?? "UTC") + (photo.takenAtSource ? ` · ${takenAtLabel[photo.takenAtSource] ?? ""}` : "") : "Unknown"],
    ["Location", photo.lat !== null && photo.lng !== null ? `${photo.lat.toFixed(5)}, ${photo.lng.toFixed(5)}${photo.altitude !== null ? ` · ${Math.round(photo.altitude)} m` : ""}${photo.gpsSource === "TRACK" ? " · from track" : photo.gpsSource === "MANUAL" ? " · set by hand" : ""}` : "None"],
    ["Camera", photo.camera],
    ["Lens", photo.lens],
    ["Exposure", [exposure(ex.exposureTime), ex.fNumber ? `f/${ex.fNumber}` : null, ex.iso ? `ISO ${ex.iso}` : null, ex.focalLength ? `${ex.focalLength}mm` : null].filter(Boolean).join(" · ") || null],
    ["Size", `${photo.width ?? "?"} × ${photo.height ?? "?"} · ${formatBytes(photo.sizeBytes)} · ${photo.mimeType}`],
    ["File", photo.originalName],
  ];
  return (
    <dl className="text-sm divide-y divide-border">
      {rows.filter(([, v]) => v).map(([k, v]) => (
        <div key={k} className="py-2 grid grid-cols-[6rem_1fr] gap-2">
          <dt className="text-muted">{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

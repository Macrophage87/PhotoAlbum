/**
 * Pairing Google Takeout media files with their JSON sidecars, as pure functions.
 *
 * Current exports name a sidecar `<file>.supplemental-metadata.json`, older ones `<file>.json`. Google truncates the
 * whole sidecar name to about 51 characters, so the suffix appears in every cut-down form (`.supplemental-metadat.json`,
 * `.supplemental-me.json`, `.supple.json`, `.s.json`). A counter suffix on the media name goes after the extension in the
 * sidecar name: `IMG(1).jpg` pairs with `IMG.jpg(1).json` (or `IMG.jpg.supplemental-metadata(1).json`).
 */
const MEDIA_EXT = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif", "gif", "mp4", "mov", "m4v", "webm"]);
const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm"]);
const SUFFIX = "supplemental-metadata";

export function isMediaName(name: string): boolean {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MEDIA_EXT.has(ext);
}

export function isVideoName(name: string): boolean {
  return VIDEO_EXT.has(name.toLowerCase().split(".").pop() ?? "");
}

/** Split `IMG_001(1).jpg` into its base name and counter: { stem: "IMG_001.jpg", counter: "(1)" }. */
export function splitCounter(fileName: string): { stem: string; counter: string } {
  const m = /^(.*)(\(\d+\))(\.[^.]+)$/.exec(fileName);
  if (!m) return { stem: fileName, counter: "" };
  return { stem: `${m[1]}${m[3]}`, counter: m[2] };
}

/**
 * Every sidecar name a media file could have, most specific first: the full suffix, each truncation of it, and the
 * bare `.json`, each with the counter placed after the extension (Google's way) or at the end.
 */
export function candidateSidecarNames(fileName: string): string[] {
  const { stem, counter } = splitCounter(fileName);
  const out: string[] = [];
  for (let n = SUFFIX.length; n >= 1; n--) {
    const part = SUFFIX.slice(0, n);
    out.push(`${stem}.${part}${counter}.json`);
    if (counter) out.push(`${stem}${counter}.${part}.json`);
  }
  out.push(`${stem}${counter}.json`);
  if (counter) out.push(`${stem}.json${counter}`, `${stem}${counter}.json`);
  return [...new Set(out)];
}

/** Match the sidecar for each media entry among the names in the same folder. Returns media path → sidecar path. */
export function pairSidecars(entryPaths: string[]): Map<string, string | null> {
  const byDir = new Map<string, Set<string>>();
  for (const p of entryPaths) {
    const i = p.lastIndexOf("/");
    const dir = i >= 0 ? p.slice(0, i) : "";
    const name = i >= 0 ? p.slice(i + 1) : p;
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir)!.add(name);
  }
  const out = new Map<string, string | null>();
  for (const p of entryPaths) {
    const i = p.lastIndexOf("/");
    const dir = i >= 0 ? p.slice(0, i) : "";
    const name = i >= 0 ? p.slice(i + 1) : p;
    if (!isMediaName(name)) continue;
    const names = byDir.get(dir)!;
    // Google may truncate the media stem itself inside the sidecar name; try exact candidates first, then a prefix scan.
    let found = candidateSidecarNames(name).find((c) => names.has(c)) ?? null;
    if (!found) {
      const { stem, counter } = splitCounter(name);
      const prefix = stem.slice(0, 40);
      found = [...names].find((n) => n.endsWith(".json") && n.startsWith(prefix) && n !== name && (counter ? n.includes(counter) : !/\(\d+\)\.json$/.test(n))) ?? null;
    }
    out.set(p, found ? (dir ? `${dir}/${found}` : found) : null);
  }
  return out;
}

export type SidecarData = { title: string | null; description: string | null; takenAt: Date | null; lat: number | null; lng: number | null; googleId: string | null };

/** The fields the album uses from a sidecar; `geoData` and `geoDataExif` carry 0.0 when Google has no position. */
export function parseSidecar(json: unknown): SidecarData {
  const j = (json ?? {}) as Record<string, unknown>;
  const ts = (j.photoTakenTime as { timestamp?: string } | undefined)?.timestamp;
  const takenAt = ts && /^\d+$/.test(ts) ? new Date(Number(ts) * 1000) : null;
  const pick = (g: unknown) => {
    const geo = g as { latitude?: number; longitude?: number } | undefined;
    if (!geo || typeof geo.latitude !== "number" || typeof geo.longitude !== "number") return null;
    if (geo.latitude === 0 && geo.longitude === 0) return null;
    return { lat: geo.latitude, lng: geo.longitude };
  };
  const pos = pick(j.geoData) ?? pick(j.geoDataExif);
  const url = typeof j.url === "string" ? j.url : null;
  const googleId = url ? (/photos\.google\.com\/photo\/([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null) : null;
  return {
    title: typeof j.title === "string" && j.title.trim() ? j.title.trim() : null,
    description: typeof j.description === "string" && j.description.trim() ? j.description.trim() : null,
    takenAt: takenAt && !Number.isNaN(takenAt.getTime()) ? takenAt : null,
    lat: pos?.lat ?? null,
    lng: pos?.lng ?? null,
    googleId,
  };
}

/** Takeout folders: `Photos from 2019` and the like are the year bins, everything else under Google Photos is an album. */
export function albumFolderOf(entryPath: string): string | null {
  const parts = entryPath.split("/");
  const gp = parts.findIndex((p) => p === "Google Photos" || p === "Google Fotos");
  const folder = gp >= 0 ? parts[gp + 1] : parts.length >= 2 ? parts[parts.length - 2] : null;
  if (!folder || parts.indexOf(folder) === parts.length - 1) return null;
  if (/^Photos from \d{4}$/i.test(folder) || /^Untitled(\(\d+\))?$/.test(folder) || /^Trash$/i.test(folder) || /^Archive$/i.test(folder) || /^Failed Videos$/i.test(folder)) return null;
  return folder;
}

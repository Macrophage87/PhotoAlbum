import { readFile } from "node:fs/promises";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { dateColumnToDay, wallTimeToInstant } from "@/lib/time/local-day";
import { detectTrackKind, type TrackFileKind } from "./detect";
import { parseGpx } from "./gpx";
import { parseFit } from "./fit";
import { parseGoogleExport, readHead } from "./google";
import { splitByLocalDay } from "./split";
import { persistTrack, type PersistedTrack } from "./persist";
import type { ParsedTrack } from "./types";

export type ImportSummary = {
  kind: TrackFileKind;
  format?: string;
  tracks: PersistedTrack[];
  skipped: string[];
  pointsRead: number;
};

export type ImportArgs = { importKey: string; tripId: string; userId: string; sourceHint: "auto" | TrackFileKind; originalName: string };

/** Parse an uploaded track file and store whatever tracks/activities it yields. */
export async function importTrackFile(args: ImportArgs): Promise<ImportSummary> {
  const store = storage();
  const filePath = store.localPath?.(args.importKey);
  if (!filePath) throw new Error("import requires a storage driver with local paths");
  const trip = await db.trip.findUnique({ where: { id: args.tripId } });
  if (!trip) throw new Error("Trip not found");

  const head = await readHead(filePath, 4096);
  const kind = detectTrackKind(args.originalName, head, args.sourceHint);
  if (!kind) throw new Error(`Could not tell what kind of file "${args.originalName}" is. Use a .gpx, .fit, or Google Timeline .json export.`);

  const summary: ImportSummary = { kind, tracks: [], skipped: [], pointsRead: 0 };

  if (kind === "google") {
    const startDay = dateColumnToDay(trip.startDate), endDay = dateColumnToDay(trip.endDate);
    const [sy, sm, sd] = startDay.split("-").map(Number);
    const [ey, em, ed] = endDay.split("-").map(Number);
    const window = {
      startMs: wallTimeToInstant({ year: sy, month: sm, day: sd, hour: 0, minute: 0, second: 0 }, trip.timezone).getTime(),
      endMs: wallTimeToInstant({ year: ey, month: em, day: ed, hour: 23, minute: 59, second: 59, ms: 999 }, trip.timezone).getTime(),
    };
    const { format, points } = await parseGoogleExport(filePath, window);
    summary.format = format;
    summary.pointsRead = points.length;
    if (!points.length) {
      summary.skipped.push(`No location points between ${startDay} and ${endDay} in this export.`);
      return summary;
    }
    for (const [day, dayPoints] of splitByLocalDay(points, trip.timezone)) {
      const parsed: ParsedTrack = { name: `Google Timeline — ${day}`, points: dayPoints, sport: null };
      const saved = await persistTrack(parsed, { tripId: trip.id, userId: args.userId, source: "GOOGLE", originalFile: args.importKey, createActivity: false });
      if (saved) summary.tracks.push(saved);
      else summary.skipped.push(`${day}: fewer than two usable points`);
    }
    return summary;
  }

  let parsedTracks: ParsedTrack[];
  if (kind === "gpx") {
    parsedTracks = parseGpx(await readFile(filePath, "utf8"));
  } else {
    parsedTracks = await parseFit(await readFile(filePath));
  }
  summary.pointsRead = parsedTracks.reduce((n, t) => n + t.points.length, 0);
  if (!parsedTracks.length) {
    summary.skipped.push("No track points with coordinates and timestamps were found.");
    return summary;
  }
  for (const parsed of parsedTracks) {
    const saved = await persistTrack(parsed, { tripId: trip.id, userId: args.userId, source: kind === "gpx" ? "GPX" : "FIT", originalFile: args.importKey, createActivity: true });
    if (saved) summary.tracks.push(saved);
    else summary.skipped.push(`${parsed.name}: fewer than two usable points`);
  }
  return summary;
}

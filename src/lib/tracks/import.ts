import { readFile, stat } from "node:fs/promises";
import { db } from "@/lib/db";
import { canEditContainer, NOT_YOUR_CONTAINER } from "@/lib/auth/ownership";
import { storage } from "@/lib/storage";
import { dateColumnToDay, wallTimeToInstant } from "@/lib/time/local-day";
import { detectTrackKind, type TrackFileKind } from "./detect";
import { parseGpx } from "./gpx";
import { parseFit } from "./fit";
import { parseGoogleExport, readHead } from "./google";
import { splitByLocalDay } from "./split";
import { persistTrack, type PersistedTrack } from "./persist";
import { cleanPoints } from "./clean";
import { placeAgain, takeBackTrack } from "./remove";
import type { Prisma } from "@/generated/prisma/client";
import type { ParsedTrack } from "./types";

export type ImportSummary = {
  kind: TrackFileKind;
  format?: string;
  tracks: PersistedTrack[];
  skipped: string[];
  pointsRead: number;
};

/** GPX and FIT files are parsed from memory; anything bigger than this is not a real activity file. */
export const MAX_PARSED_TRACK_BYTES = 256 * 1024 * 1024;

export type ImportArgs = { importKey: string; tripId: string; userId: string; sourceHint: "auto" | TrackFileKind; originalName: string; replaceGoogle?: boolean };

/** Parse an uploaded track file and store whatever tracks/activities it yields. */
export async function importTrackFile(args: ImportArgs): Promise<ImportSummary> {
  const store = storage();
  const filePath = store.localPath?.(args.importKey);
  if (!filePath) throw new Error("import requires a storage driver with local paths");
  const trip = await db.trip.findUnique({ where: { id: args.tripId } });
  if (!trip) throw new Error("Trip not found");
  // The job trusts its payload, so the rule the route applied is asked again here: an import arranges the trip.
  const user = await db.user.findUnique({ where: { id: args.userId }, select: { id: true, role: true } });
  if (!canEditContainer(user, trip)) {
    // Refused, the file has no use: nothing of it is kept.
    await store.delete(args.importKey).catch(() => {});
    throw new Error(NOT_YOUR_CONTAINER);
  }

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
    // Local midnights inside the trip, where the trace is split into days: a stay across one gets a point there.
    const midnights: number[] = [];
    for (let k = 1; ; k++) {
      const d = new Date(Date.UTC(sy, sm - 1, sd + k));
      const t = wallTimeToInstant({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 0, minute: 0, second: 0 }, trip.timezone).getTime();
      if (t > window.endMs) break;
      // Midnight itself starts the next day's trace; the instant before it ends this one, so the day reaches 23:59:59.
      midnights.push(t - 1, t);
    }
    const { format, points, recorded } = await parseGoogleExport(filePath, window, midnights);
    summary.format = format;
    summary.pointsRead = recorded;
    if (!points.length) {
      summary.skipped.push(`No location points between ${startDay} and ${endDay} in this export.`);
      return summary;
    }
    // One account often imports the whole family's exports, so an earlier trace for the same day is only replaced
    // when the member asks for that; otherwise both are kept. Replacing saves the new days and drops the old ones in
    // one transaction, so a failure part-way leaves the earlier traces as they were.
    const days = [...splitByLocalDay(points, trip.timezone)].map(([day, dayPoints]) => ({ day, parsed: { name: `Google Timeline — ${day}`, points: dayPoints, sport: null } as ParsedTrack }));
    const save = async (client?: Prisma.TransactionClient) => {
      const saved: PersistedTrack[] = [];
      let replaced = 0;
      for (const { day, parsed } of days) {
        const earlier = args.replaceGoogle
          ? await (client ?? db).track.findMany({ where: { tripId: trip.id, uploaderId: args.userId, source: "GOOGLE", name: parsed.name }, select: { id: true, tripId: true, startTime: true, endTime: true } })
          : [];
        // No originalFile: the export is deleted once read (the import-track job), so there is nothing to point at.
        const track = await persistTrack(parsed, { tripId: trip.id, userId: args.userId, source: "GOOGLE", createActivity: false, client });
        if (!track) {
          summary.skipped.push(`${day}: fewer than two usable points`);
          continue;
        }
        saved.push(track);
        for (const old of earlier) if (await takeBackTrack(client!, old)) replaced++;
      }
      return { saved, replaced };
    };
    const { saved, replaced } = args.replaceGoogle ? await db.$transaction((tx) => save(tx), { timeout: 120_000 }) : await save();
    summary.tracks.push(...saved);
    if (replaced) await placeAgain(trip.id);
    return summary;
  }

  const { size } = await stat(filePath);
  if (size > MAX_PARSED_TRACK_BYTES) {
    throw new Error(`${kind.toUpperCase()} file is ${Math.round(size / 1048576)} MB; files over ${MAX_PARSED_TRACK_BYTES / 1048576} MB are not supported.`);
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
    // The same file imported twice (or the same ride exported again) would put a second copy of the ride and its
    // activity on the trip. What is saved is the cleaned points, so a copy has the same start, end and count.
    const points = cleanPoints(parsed.points);
    if (points.length >= 2) {
      const copy = await db.track.findFirst({
        where: { tripId: trip.id, source: { in: ["GPX", "FIT"] }, startTime: new Date(points[0].t), endTime: new Date(points.at(-1)!.t), pointCount: points.length },
        select: { id: true },
      });
      if (copy) {
        summary.skipped.push(`${parsed.name}: already on this trip (the same track was imported before), so it was not added again`);
        continue;
      }
    }
    const saved = await persistTrack(parsed, { tripId: trip.id, userId: args.userId, source: kind === "gpx" ? "GPX" : "FIT", originalFile: args.importKey, createActivity: true });
    if (saved) summary.tracks.push(saved);
    else summary.skipped.push(`${parsed.name}: fewer than two usable points`);
  }
  return summary;
}

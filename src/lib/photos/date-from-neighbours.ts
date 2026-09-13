import type { TakenAtSource } from "@/generated/prisma/enums";

/**
 * Working out when an undated photo was taken from the photos around it on the same trip.
 *
 * This exists because a photo can reach the album with its capture time gone: an editor that strips EXIF on export,
 * a chat app that re-encodes, a scan. The trip itself is a strong witness — the family was in one place over a few
 * days, and the camera numbered the frames as it went — so the neighbours usually know within minutes.
 */

/** A date the album is willing to reason from: something recorded rather than guessed. */
export const TRUSTED_DATE_SOURCES: TakenAtSource[] = ["EXIF_OFFSET", "EXIF_TZLOOKUP", "TRIP_TZ", "MANUAL", "SIDECAR", "FILE_NAME"];

/** A date worth replacing with a better guess: nothing at all, the file's clock, or a tag an editor may have rewritten. */
export const WEAK_DATE_SOURCES: TakenAtSource[] = ["FILE_MTIME", "UPLOAD_TIME", "EXIF_CREATED"];

export function isWeakDate(source: TakenAtSource | null, takenAt: Date | null): boolean {
  return !takenAt || source === null || WEAK_DATE_SOURCES.includes(source);
}

export type Neighbour = { id: string; originalName: string; takenAt: Date; tzOffsetMin: number | null };
export type Target = { id: string; originalName: string };

export type DateGuess = {
  takenAt: Date;
  tzOffsetMin: number;
  /** 0 to 1, in the same terms as the album's other guesses: below 0.4 is a rough guess. */
  confidence: number;
  /** One line naming what it was worked out from, for a member to check before accepting it. */
  evidence: string;
  basis: "sequence" | "similar" | "trip";
};

/** The camera's frame number: the last run of digits in the name, with whatever comes before it. */
export function frameNumber(name: string): { prefix: string; n: number } | null {
  const base = name.replace(/\.[^.]+$/, "");
  const m = /^(.*?)(\d{2,8})$/.exec(base);
  if (!m) return null;
  return { prefix: m[1].toLowerCase(), n: Number(m[2]) };
}

/** How far apart two frame numbers may be and still say anything useful about each other. */
const NEAR_FRAMES = 40;
/** Beyond this a "just after the one before" guess is not worth making. */
const ONE_SIDED_FRAMES = 8;

const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });

/** The neighbour's own wall-clock reading, so the evidence line says the time the family would recognise. */
function wallLabel(at: Date, tzOffsetMin: number | null): string {
  return SHORT.format(new Date(at.getTime() + (tzOffsetMin ?? 0) * 60_000));
}

/**
 * Guess when a photo was taken. In order of how much it can be trusted: between two frames the same camera numbered
 * either side of it, next to a single nearby frame, from the photos that look most like it, and finally somewhere
 * in the trip's own span. Returns null when there is nothing to go on at all.
 */
export function guessDate(
  target: Target,
  dated: Neighbour[],
  opts: { similarIds?: string[]; trip?: { startDate: Date; endDate: Date; tzOffsetMin: number } } = {},
): DateGuess | null {
  const frame = frameNumber(target.originalName);
  if (frame) {
    const sameRoll = dated
      .map((n) => ({ n, f: frameNumber(n.originalName) }))
      .filter((x): x is { n: Neighbour; f: { prefix: string; n: number } } => Boolean(x.f) && x.f!.prefix === frame.prefix && Math.abs(x.f!.n - frame.n) <= NEAR_FRAMES)
      .sort((a, b) => a.f.n - b.f.n);
    const before = [...sameRoll].reverse().find((x) => x.f.n < frame.n);
    const after = sameRoll.find((x) => x.f.n > frame.n);

    if (before && after) {
      const span = after.f.n - before.f.n;
      const at = new Date(before.n.takenAt.getTime() + ((frame.n - before.f.n) / span) * (after.n.takenAt.getTime() - before.n.takenAt.getTime()));
      const gapMinutes = (after.n.takenAt.getTime() - before.n.takenAt.getTime()) / 60_000;
      return {
        takenAt: at,
        tzOffsetMin: before.n.tzOffsetMin ?? after.n.tzOffsetMin ?? 0,
        // Frames minutes apart pin it down; frames hours apart only say which part of the day.
        confidence: gapMinutes <= 60 ? 0.85 : gapMinutes <= 12 * 60 ? 0.6 : 0.45,
        evidence: `between ${before.n.originalName} (${wallLabel(before.n.takenAt, before.n.tzOffsetMin)}) and ${after.n.originalName} (${wallLabel(after.n.takenAt, after.n.tzOffsetMin)})`,
        basis: "sequence",
      };
    }
    const one = before && frame.n - before.f.n <= ONE_SIDED_FRAMES ? before : after && after.f.n - frame.n <= ONE_SIDED_FRAMES ? after : null;
    if (one) {
      const isBefore = one === before;
      return {
        takenAt: one.n.takenAt,
        tzOffsetMin: one.n.tzOffsetMin ?? 0,
        confidence: 0.55,
        evidence: `${isBefore ? "just after" : "just before"} ${one.n.originalName} (${wallLabel(one.n.takenAt, one.n.tzOffsetMin)})`,
        basis: "sequence",
      };
    }
  }

  // Nothing in the numbering: the photos that look most like this one are the next best witnesses.
  const similar = (opts.similarIds ?? []).map((id) => dated.find((n) => n.id === id)).filter((n): n is Neighbour => Boolean(n));
  if (similar.length) {
    const times = similar.map((n) => n.takenAt.getTime()).sort((a, b) => a - b);
    const middle = times[Math.floor(times.length / 2)];
    const spreadHours = (times[times.length - 1] - times[0]) / 3_600_000;
    return {
      takenAt: new Date(middle),
      tzOffsetMin: similar[0].tzOffsetMin ?? 0,
      confidence: spreadHours <= 2 ? 0.5 : 0.35,
      evidence: `about when ${similar.length === 1 ? "the photo it looks most like was taken" : `the ${similar.length} photos it looks most like were taken`} (${wallLabel(new Date(middle), similar[0].tzOffsetMin)})`,
      basis: "similar",
    };
  }

  // Failing everything, the trip itself: the right days, the wrong hour, and it says so.
  if (opts.trip) {
    const start = opts.trip.startDate.getTime();
    const end = opts.trip.endDate.getTime();
    const middle = new Date(start + (end - start) / 2);
    const days = Math.round((end - start) / 86_400_000) + 1;
    return {
      takenAt: new Date(Date.UTC(middle.getUTCFullYear(), middle.getUTCMonth(), middle.getUTCDate(), 12) - opts.trip.tzOffsetMin * 60_000),
      tzOffsetMin: opts.trip.tzOffsetMin,
      confidence: days <= 2 ? 0.4 : 0.2,
      evidence: days <= 1 ? "the day of the trip it is filed under" : `the middle of the ${days} days this trip covers`,
      basis: "trip",
    };
  }
  return null;
}

/** The guess in the same words the rest of the album uses for how sure it is. */
export function surenessLabel(confidence: number): string {
  return confidence >= 0.7 ? "fairly sure" : confidence >= 0.4 ? "a guess" : "a rough guess";
}

/**
 * Judging whether the still a browser sent back for a 3D scan is a picture of anything.
 *
 * The album cannot draw a scan — that needs a graphics card — so the first member to open one sends back a still of
 * what their own browser drew. Browsers hand back an empty frame more readily than one would like: ask a moment too
 * early and what comes back is a rectangle of nothing, which then has to be laid on some colour to be saved, and
 * that colour is white on an iPhone and black on a desktop. A tile like that is worse than no tile, because the
 * album would keep it for good and never ask again — so both ends check, and a blank one is thrown away.
 */

/** How much of the frame the scan must cover before a still is worth keeping. A scan seen edge-on is still small. */
export const MIN_DRAWN = 0.01;
/** Below this much variation, every pixel is the same colour and the picture is of nothing. */
const FLAT_STDEV = 2;

export type ChannelStats = { mean: number; stdev: number };

/**
 * @param channels sharp's per-channel statistics, red, green, blue and — for a still that kept its transparency —
 *   alpha. Alpha's mean over 255 is how much of the frame was drawn into.
 */
export function stillIsBlank(channels: ChannelStats[]): boolean {
  if (channels.length === 0) return true;
  const colour = channels.slice(0, 3);
  // One flat colour everywhere: white, black, or any other rectangle of nothing.
  if (colour.every((c) => c.stdev < FLAT_STDEV)) return true;
  const alpha = channels[3];
  return alpha !== undefined && alpha.mean / 255 < MIN_DRAWN;
}

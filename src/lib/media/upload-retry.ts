/**
 * What to do when an upload does not arrive.
 *
 * A hundred photographs from a phone is not one upload, it is a hundred of them over several minutes, and in those
 * minutes the phone will lock its screen, the album will go to the background, and wifi will hand over to the
 * mobile network. Each of those quietly abandons whatever was in flight. A batch that gives up at the first of them
 * looks, from the other end, like nothing happening at all — so anything that is the connection's fault is waited
 * out and tried again, and only what the server actually refused is final.
 */

export type FailureKind =
  /** The connection went away: no reply, or the browser abandoned the request when the phone locked. */
  | "network"
  /** Bytes stopped moving for long enough that nothing is going to come of it. */
  | "stalled"
  /** The server is busy or broken: worth another go in a moment. */
  | "server"
  /** The server looked at it and said no. Sending it again would get the same answer. */
  | "rejected"
  /** The member is no longer signed in. Everything after this one will fail the same way. */
  | "signedout";

export type UploadFailure = { kind: FailureKind; message: string };

/** How many goes each file gets in all, the first one included. */
export const MAX_ATTEMPTS = 4;

/**
 * How long to wait before trying again. Long enough that a phone coming back from a locked screen or a network
 * handover has settled, short enough that nobody watching thinks it has stopped.
 */
export function backoffMs(attempt: number): number {
  return [2_000, 6_000, 15_000][attempt - 1] ?? 15_000;
}

/**
 * How long bytes may stop moving before the attempt is abandoned. A large clip on a slow connection still reports
 * progress every few seconds, so silence for this long means the connection is gone rather than slow.
 */
export const STALL_MS = 90_000;

export function isRetryable(failure: UploadFailure): boolean {
  return failure.kind === "network" || failure.kind === "stalled" || failure.kind === "server";
}

/** What a reply that was not a success means, given the status the server sent. */
export function failureForStatus(status: number, serverMessage?: string): UploadFailure {
  if (status === 401) return { kind: "signedout", message: "You were signed out. Sign in again and the rest will go up." };
  // 0 is what a browser reports when it abandoned the request rather than getting an answer.
  if (status === 0) return { kind: "network", message: "The connection dropped." };
  if (status === 408 || status === 429 || status >= 500) return { kind: "server", message: serverMessage ?? "The album could not take it just then." };
  return { kind: "rejected", message: serverMessage ?? `The album would not take it (${status}).` };
}

/**
 * The one line at the top that says how a batch is going, in words rather than a hundred small squares.
 *
 * Arriving and being ready are two different moments. A hundred photographs from a phone arrive in a minute or two
 * and then take the server several more to turn into pictures, two at a time; a line that said "All 100 uploaded"
 * and nothing else for those minutes read as a page that had stopped. So once everything is up, it counts the
 * ones that are ready too.
 */
export function progressLine(counts: { done: number; failed: number; waiting: number; inFlight: number; total: number; ready?: number; processing?: number }): string {
  if (counts.done + counts.failed === counts.total) {
    const processing = counts.processing ?? 0;
    if (processing > 0) {
      const head = counts.failed ? `${counts.done} of ${counts.total} uploaded; ${counts.failed} did not` : `All ${counts.total} uploaded`;
      return `${head}. ${counts.ready ?? counts.done - processing} ready, ${processing} still being processed…`;
    }
    if (!counts.failed) return `All ${counts.total} uploaded.`;
    return `${counts.done} of ${counts.total} uploaded; ${counts.failed} did not.`;
  }
  const parts = [`${counts.done} of ${counts.total} uploaded`];
  if (counts.waiting) parts.push(`${counts.waiting} waiting to try again`);
  if (counts.failed) parts.push(`${counts.failed} gave up`);
  return `${parts.join(", ")}…`;
}

/** How often the album is asked what became of the ones it is still processing, while every answer comes back. */
export const STATUS_POLL_MS = 1500;

/**
 * How long to wait before asking again after asking failed.
 *
 * A failed answer is not a failed photograph. The photographs are already on the server, being processed whether
 * or not this page is watching, and a phone that locks its screen or changes network for a moment will miss an
 * answer or two in a batch that takes minutes. So a missed answer is waited out — longer each time, never so long
 * that the page looks abandoned — and never turned into a verdict on the photographs themselves.
 */
export function statusRetryMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return STATUS_POLL_MS;
  return [3_000, 6_000, 12_000][consecutiveFailures - 1] ?? 20_000;
}

/** How many answers in a row may go missing before the page says so. One or two is ordinary; four is worth a line. */
export const STATUS_NOTICE_AFTER = 4;

/**
 * The most one batch takes. Not because the album cannot manage more — it takes them two at a time whatever
 * arrives — but because "select all" on a phone with four thousand photographs is one tap, and a page holding
 * four thousand uploads for an hour is not what anybody meant. Enough for any afternoon's worth; the rest can
 * follow once these are done.
 */
export const MAX_BATCH = 200;

/** Why the ones past the cap were not taken, in a sentence rather than a count. */
export function overCapMessage(left: number): string {
  return `${left} more ${left === 1 ? "was" : "were"} not added: the album takes up to ${MAX_BATCH} at a time. Add ${left === 1 ? "it" : "them"} once these have finished.`;
}

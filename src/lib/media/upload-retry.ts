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

/** The one line at the top that says how a batch is going, in words rather than a hundred small squares. */
export function progressLine(counts: { done: number; failed: number; waiting: number; inFlight: number; total: number }): string {
  if (counts.done + counts.failed === counts.total) {
    if (!counts.failed) return `All ${counts.total} uploaded.`;
    return `${counts.done} of ${counts.total} uploaded; ${counts.failed} did not.`;
  }
  const parts = [`${counts.done} of ${counts.total} uploaded`];
  if (counts.waiting) parts.push(`${counts.waiting} waiting to try again`);
  if (counts.failed) parts.push(`${counts.failed} gave up`);
  return `${parts.join(", ")}…`;
}

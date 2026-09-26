/** How recently a row must have been made by the same member, from a file of the same name, to be this upload's first go. */
export const RESEND_WINDOW_MS = 30 * 60_000;

/**
 * A retry (not a first attempt) that found the row an earlier attempt at the same file made: the answer to that
 * attempt was lost on the way back, so this is the member's upload arriving rather than one the album already had.
 */
export function isResend(already: { uploaderId: string; originalName: string; createdAt: Date }, attempt: number, userId: string, fileName: string, now = Date.now()): boolean {
  return attempt > 1 && already.uploaderId === userId && already.originalName === fileName && now - already.createdAt.getTime() < RESEND_WINDOW_MS;
}

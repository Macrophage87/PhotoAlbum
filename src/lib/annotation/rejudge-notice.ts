import { cookies } from "next/headers";
import { rejudgeLater, type RejudgeJob } from "./rejudge";

/** Set for an hour when a change could not be queued for judging; the nav then says so. */
export const REJUDGE_COOKIE = "rejudge_pending";

/**
 * Queue a judging from a server action. When the queue cannot take it, nothing the member asked for fails: the
 * nightly sweep judges it within a day, and until then the member is told, once, that text naming somebody may
 * still be readable outside the family for a while.
 */
export async function rejudgeFromAction(job: RejudgeJob): Promise<void> {
  if (await rejudgeLater(job)) return;
  try {
    (await cookies()).set(REJUDGE_COOKIE, "1", { maxAge: 3600, path: "/", httpOnly: true, sameSite: "lax" });
  } catch {
    // Outside a request there is nobody to tell.
  }
}

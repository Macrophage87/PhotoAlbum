import { cookies } from "next/headers";
import { REJUDGE_COOKIE } from "@/lib/annotation/rejudge-notice";

/** A line under the bar when a change could not be queued for judging (see `rejudgeFromAction`). Never blocks anything. */
export async function RejudgeNotice() {
  const pending = (await cookies()).get(REJUDGE_COOKIE)?.value === "1";
  if (!pending) return null;
  return (
    <div role="status" className="border-b border-amber-300 bg-amber-50 text-amber-900 text-sm" data-testid="rejudge-notice">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-2">
        Your change is saved. The album could not start checking older descriptions for it just now, so anything naming somebody may stay readable outside the family until tonight&apos;s check.
      </div>
    </div>
  );
}

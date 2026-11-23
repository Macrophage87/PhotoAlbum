import { cookies } from "next/headers";
import type { Viewer } from "@/lib/auth/viewer";

/** The cookie a visitor's choice is kept in. A member's is kept on their account (`User.largeText`). */
export const LARGE_TEXT_COOKIE = "large-text";

/**
 * Whether this page is drawn with the larger text and stronger contrast: a member's own choice, the same on every
 * device they are signed in on, else what this browser chose.
 */
export async function wantsLargeText(viewer: Viewer): Promise<boolean> {
  if (viewer.kind === "user") return Boolean(viewer.user.largeText);
  return (await cookies()).get(LARGE_TEXT_COOKIE)?.value === "1";
}

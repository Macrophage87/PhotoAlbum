import { z } from "zod";
import { cookies } from "next/headers";
import { getSharedActivity, getSharedCollection, getSharedTrip } from "@/lib/share/queries";
import { SHARE_COOKIE_PREFIX } from "@/lib/auth/viewer";
import { shareKey } from "@/lib/auth/access";
import { SHARE_OPENED_COOKIE } from "@/lib/share/opened-cookie";

const body = z.object({ kind: z.enum(["trip", "collection", "activity"]), id: z.string().min(1).max(64), token: z.string().min(1).max(256) });

/**
 * Remember a share token for one trip, collection or activity so its media requests are authorised; the token is
 * verified first. A route rather than a server action: an action that sets a cookie sends the page re-rendered with
 * its answer, and the client swaps the "Opening…" placeholder for the album in place, leaving the placeholder's
 * streamed title and link-preview tags behind beside the new ones. The page loads itself again instead.
 */
export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response(null, { status: 400 });
  const { kind, id, token } = parsed.data;
  const container = kind === "trip" ? await getSharedTrip(token) : kind === "collection" ? await getSharedCollection(token) : await getSharedActivity(token);
  if (!container || container.id !== id) return new Response(null, { status: 404 });
  const jar = await cookies();
  const attributes = { sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" } as const;
  jar.set(`${SHARE_COOKIE_PREFIX}${shareKey(kind, id)}`, token, { ...attributes, httpOnly: true, maxAge: 30 * 24 * 60 * 60 });
  jar.set(SHARE_OPENED_COOKIE, id, { ...attributes, httpOnly: false, maxAge: 60 });
  return new Response(null, { status: 204 });
}

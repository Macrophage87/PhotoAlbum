import { z } from "zod";
import { getViewer } from "@/lib/auth/viewer";
import { recordVisit } from "@/lib/visits/record";

const body = z.object({
  path: z.string().min(1).max(512).startsWith("/"),
  ref: z.string().max(2048).nullish(),
});

/**
 * Where a page reports that somebody opened it. This is the browser's word rather than the web server's log on
 * purpose: a log counts every crawler, every prefetch and every image, and cannot tell a secret link apart from the
 * trip's own address. What arrives here is a path and a referrer; what is written down is neither (see
 * `lib/visits/record`).
 *
 * It always answers cheerfully. A visitor whose count did not land should not see an error in their console, and
 * nothing about the album should ever wait on this.
 */
export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response(null, { status: 204 });
  const viewer = await getViewer();
  await recordVisit({
    path: parsed.data.path,
    ref: parsed.data.ref ?? null,
    headers: request.headers,
    userId: viewer.user?.id ?? null,
    shareKeys: new Set(viewer.shareTokens.keys()),
  }).catch(() => undefined);
  return new Response(null, { status: 204 });
}

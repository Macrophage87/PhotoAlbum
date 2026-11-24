import { receiverPage } from "@/lib/cast/receiver-page";

/**
 * The page a television opens for a slideshow cast from the phone app (see `lib/cast/receiver-page`). Public, as it
 * must be for a television, and it holds nothing: pictures and songs come by signed addresses from the phone. It is
 * left out of the proxy's page policy (see `src/proxy.ts`), because Google's casting script talks to the television
 * it runs on, which that policy would forbid.
 */
export function GET() {
  return new Response(receiverPage(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}

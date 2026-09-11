import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth/viewer";
import { graphPayload, parseScope } from "@/lib/graph/query";
import { MIN_SCORE } from "@/lib/graph/neighbours";

/** Members only. Nodes are resolved through the visibility rules first; edges never leave the viewable set. */
export async function GET(request: NextRequest) {
  const viewer = await getViewer();
  if (viewer.kind !== "user") return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const sp = request.nextUrl.searchParams;
  const min = Math.min(1, Math.max(MIN_SCORE, Number(sp.get("min") ?? MIN_SCORE) || MIN_SCORE));
  const payload = await graphPayload(viewer, parseScope(sp), min);
  if (!payload) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
}

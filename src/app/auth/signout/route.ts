import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { destroySession } from "@/lib/auth/session";
import { isSameOriginRequest } from "@/lib/auth/same-origin";

export async function POST(request: Request) {
  // Another site's auto-submitting form must not sign a member out: its request is turned away with the cookie kept.
  if (!isSameOriginRequest(request.headers, env().APP_URL)) return new Response("Forbidden", { status: 403 });
  await destroySession();
  return NextResponse.redirect(new URL("/", env().APP_URL), { status: 303 });
}

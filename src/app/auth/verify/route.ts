import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { verifyMagicLink } from "@/lib/auth/magic-link";
import { createSession } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/auth/tokens";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));

  const result = await verifyMagicLink(token, { db, adminEmail: env().ADMIN_EMAIL });
  if (!result.ok) {
    return NextResponse.redirect(new URL(`/auth/signin?error=${result.reason}`, env().APP_URL));
  }
  await createSession(result.userId);
  return NextResponse.redirect(new URL(next, env().APP_URL));
}

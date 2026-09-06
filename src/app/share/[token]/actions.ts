"use server";

import { cookies } from "next/headers";
import { getSharedTrip } from "@/lib/share/queries";
import { SHARE_COOKIE_PREFIX } from "@/lib/auth/viewer";

export async function setShareCookie(tripId: string, token: string): Promise<void> {
  const trip = await getSharedTrip(token);
  if (!trip || trip.id !== tripId) return;
  (await cookies()).set(`${SHARE_COOKIE_PREFIX}${trip.id}`, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
}

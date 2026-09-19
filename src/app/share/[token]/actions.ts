"use server";

import { cookies } from "next/headers";
import { getSharedActivity, getSharedCollection, getSharedTrip } from "@/lib/share/queries";
import { SHARE_COOKIE_PREFIX } from "@/lib/auth/viewer";
import { shareKey, type ShareKind } from "@/lib/auth/access";

/** Remember a share token for one container so its media requests are authorised. The token is verified first. */
export async function setShareCookie(kind: ShareKind, id: string, token: string): Promise<void> {
  const container = kind === "trip" ? await getSharedTrip(token) : kind === "collection" ? await getSharedCollection(token) : await getSharedActivity(token);
  if (!container || container.id !== id) return;
  (await cookies()).set(`${SHARE_COOKIE_PREFIX}${shareKey(kind, id)}`, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
}

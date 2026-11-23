"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";
import { LARGE_TEXT_COOKIE } from "@/lib/reading/large-text";

/**
 * Turn the larger text on or off. Kept in this browser for anybody, and on a member's account as well so it follows
 * them to the next device they sign in on. Every page is drawn again with it.
 */
export async function setLargeText(on: boolean): Promise<void> {
  const viewer = await getViewer();
  const store = await cookies();
  if (on) store.set(LARGE_TEXT_COOKIE, "1", { path: "/", maxAge: 60 * 60 * 24 * 400, sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production" });
  else store.delete(LARGE_TEXT_COOKIE);
  if (viewer.kind === "user") await db.user.update({ where: { id: viewer.user.id }, data: { largeText: on } });
  revalidatePath("/", "layout");
}

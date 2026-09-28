"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { verifyMagicLink } from "@/lib/auth/magic-link";
import { createSession } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/auth/tokens";
import { getViewer } from "@/lib/auth/viewer";

/** The "Sign in" button on the emailed link's page: only this uses the token up and starts a session. */
export async function confirmSignIn(formData: FormData): Promise<void> {
  const token = formData.get("token");
  const next = safeNextPath(formData.get("next"));
  const result = await verifyMagicLink(typeof token === "string" ? token : "", { db, adminEmail: env().ADMIN_EMAIL });
  if (!result.ok) {
    // A second tap, or the link opened again in the browser it already signed in: carry on rather than scold.
    if (result.reason === "used" && (await getViewer()).kind === "user") redirect(next);
    redirect(`/auth/signin?error=${result.reason}`);
  }
  await createSession(result.userId);
  redirect(next);
}

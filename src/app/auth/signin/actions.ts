"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { requestMagicLink } from "@/lib/auth/magic-link";
import { magicLinkEmail, sendMail } from "@/lib/auth/email";
import { safeNextPath } from "@/lib/auth/tokens";
import { signInPerClient, signInPerEmail } from "@/lib/auth/rate-limit";
import { headers } from "next/headers";

export type SignInState = { status: "idle" } | { status: "sent"; email: string } | { status: "error"; message: string };

const schema = z.object({ email: z.string().email(), next: z.string().optional() });

export async function requestSignIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const parsed = schema.safeParse({ email: formData.get("email"), next: formData.get("next") || undefined });
  if (!parsed.success) return { status: "error", message: "Enter a valid email address." };

  // Throttle link requests so the form cannot be used to flood a member's inbox. The response stays
  // identical to the normal path so nothing about membership is revealed.
  const email = parsed.data.email.trim().toLowerCase();
  const client = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!signInPerEmail.allow(email) || !signInPerClient.allow(client)) return { status: "sent", email };

  const result = await requestMagicLink(parsed.data.email, { db, adminEmail: env().ADMIN_EMAIL });
  // Always report success to avoid leaking which addresses are members.
  if (!result.ok) return { status: "sent", email: parsed.data.email.toLowerCase() };

  const url = new URL("/auth/verify", env().APP_URL);
  url.searchParams.set("token", result.token);
  const next = safeNextPath(parsed.data.next);
  if (next !== "/") url.searchParams.set("next", next);
  await sendMail(magicLinkEmail(result.email, url.toString()));
  return { status: "sent", email: result.email };
}

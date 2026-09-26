"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { requestMagicLink } from "@/lib/auth/magic-link";
import { magicLinkEmail, sendMail } from "@/lib/auth/email";
import { safeNextPath } from "@/lib/auth/tokens";
import { allowSignInRequest } from "@/lib/auth/rate-limit";
import { forwardedClient } from "@/lib/auth/client-address";
import { headers } from "next/headers";

export type SignInState = { status: "idle" } | { status: "sent"; email: string } | { status: "error"; message: string };

const TOO_MANY: SignInState = { status: "error", message: "Too many sign-in links were asked for just now. Please wait 10 minutes and try again." };

const schema = z.object({ email: z.string().email(), next: z.string().optional() });

export async function requestSignIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const parsed = schema.safeParse({ email: formData.get("email"), next: formData.get("next") || undefined });
  if (!parsed.success) return { status: "error", message: "Enter a valid email address." };

  // Throttle link requests so the form cannot be used to flood a member's inbox. The limits are charged the same
  // whether or not the address belongs to anybody, so saying "wait" reveals nothing about membership, and it is said
  // out loud: a quietly swallowed request looks exactly like an email that never came.
  const email = parsed.data.email.trim().toLowerCase();
  if (!allowSignInRequest(email, forwardedClient(await headers()))) return TOO_MANY;

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

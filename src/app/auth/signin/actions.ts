"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { requestMagicLink } from "@/lib/auth/magic-link";
import { magicLinkEmail, sendMail } from "@/lib/auth/email";
import { safeNextPath } from "@/lib/auth/tokens";
import { allowSignInRequest, signInMailPerHour } from "@/lib/auth/rate-limit";
import { forwardedClient } from "@/lib/auth/client-address";
import { headers } from "next/headers";

export type SignInState = { status: "idle" } | { status: "sent"; email: string } | { status: "error"; message: string };

const TOO_MANY: SignInState = { status: "error", message: "Too many sign-in links were asked for just now. Please wait 10 minutes and try again." };
const RECENTLY_SENT: SignInState = { status: "error", message: "A sign-in link was sent to this address in the last few minutes. Please use the newest one in your email." };
const BUSY: SignInState = { status: "error", message: "The album has sent a lot of sign-in email in the last hour. Please try again a little later." };

const schema = z.object({ email: z.string().email(), next: z.string().optional() });

export async function requestSignIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const parsed = schema.safeParse({ email: formData.get("email"), next: formData.get("next") || undefined });
  if (!parsed.success) return { status: "error", message: "Enter a valid email address." };

  // Throttle link requests so the form cannot be used to flood anybody's inbox or the mail provider's quota, and
  // say so out loud when it bites: a quietly swallowed request looks exactly like an email that never came.
  // - Per client (and per wider network): best-effort, since only a proxy says who the client is.
  // - Per address: an address holds at most a few live links; asking again sends nothing more but leaves those
  //   working, so however many people ask on somebody's behalf, they can neither flood nor lock that person out.
  // - All together: SIGN_IN_MAIL_PER_HOUR. It is checked before membership and charged only for mail really sent.
  // Every answer is the same whether or not the address belongs to anybody, so none of them reveals membership.
  const email = parsed.data.email.trim().toLowerCase();
  if (!allowSignInRequest(forwardedClient(await headers()))) return TOO_MANY;
  const ceiling = signInMailPerHour(env().SIGN_IN_MAIL_PER_HOUR);
  if (!ceiling.hasRoom("all")) return BUSY;

  const result = await requestMagicLink(email, { db, adminEmail: env().ADMIN_EMAIL });
  if (!result.ok && result.reason === "recently_sent") return RECENTLY_SENT;
  if (!result.ok) return { status: "sent", email };
  ceiling.allow("all");

  const url = new URL("/auth/verify", env().APP_URL);
  url.searchParams.set("token", result.token);
  const next = safeNextPath(parsed.data.next);
  if (next !== "/") url.searchParams.set("next", next);
  await sendMail(magicLinkEmail(result.email, url.toString()));
  return { status: "sent", email: result.email };
}

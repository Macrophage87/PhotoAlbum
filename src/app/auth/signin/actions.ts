"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { requestMagicLink, withdrawMagicLink } from "@/lib/auth/magic-link";
import { magicLinkEmail, sendMail } from "@/lib/auth/email";
import { safeNextPath } from "@/lib/auth/tokens";
import { allowSignInRequest, signInMailPerHour } from "@/lib/auth/rate-limit";
import { forwardedClient, warnOnceIfNoClient } from "@/lib/auth/client-address";
import { headers } from "next/headers";
import { after } from "next/server";

export type SignInState = { status: "idle" } | { status: "sent"; email: string } | { status: "error"; message: string };

const TOO_MANY: SignInState = { status: "error", message: "Too many sign-in links were asked for just now. Please wait 10 minutes and try again." };
// Conditional, like the first answer: a stranger's address is told the same, so it says nothing about membership.
const RECENTLY_SENT: SignInState = { status: "error", message: "If this address belongs to a family member, sign-in links have already gone to it in the last few minutes. Please use the newest one in that inbox." };
const BUSY: SignInState = { status: "error", message: "The album has sent a lot of sign-in email in the last hour. Please try again a little later." };

const schema = z.object({ email: z.string().email(), next: z.string().optional() });

export async function requestSignIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const parsed = schema.safeParse({ email: formData.get("email"), next: formData.get("next") || undefined });
  if (!parsed.success) return { status: "error", message: "Enter a valid email address." };

  // Throttle link requests so the form cannot be used to flood anybody's inbox or the mail provider's quota, and
  // say so out loud when it bites: a quietly swallowed request looks exactly like an email that never came.
  // - Per client (and per wider network), as the proxy reports it; requests without one share a single bucket.
  // - Per address: an address holds at most a few live links; asking again sends nothing more but leaves those
  //   working, so however many people ask on somebody's behalf, they can neither flood nor lock that person out.
  // - All together: SIGN_IN_MAIL_PER_HOUR, for an address's second and third live link only, so the first always
  //   goes out and a full allowance can delay a repeat link but never stop anybody signing in.
  // Every answer is the same whether or not the address belongs to anybody, so none of them reveals membership.
  const email = parsed.data.email.trim().toLowerCase();
  const client = forwardedClient(await headers());
  warnOnceIfNoClient(client);
  if (!allowSignInRequest(client)) return TOO_MANY;

  const mail = signInMailPerHour(env().SIGN_IN_MAIL_PER_HOUR);
  const result = await requestMagicLink(email, { db, adminEmail: env().ADMIN_EMAIL, mail });
  if (!result.ok && result.reason === "recently_sent") return RECENTLY_SENT;
  if (!result.ok && result.reason === "busy") return BUSY;
  if (!result.ok) return { status: "sent", email };

  const url = new URL("/auth/verify", env().APP_URL);
  url.searchParams.set("token", result.token);
  const next = safeNextPath(parsed.data.next);
  if (next !== "/") url.searchParams.set("next", next);
  // The email goes out after the answer does: a member's request then takes no longer than a stranger's (whose
  // placeholder sends nothing), so response time says nothing about membership either. Mail that fails is
  // withdrawn, so the address is not later told a link is on its way when none ever came.
  const { token, charged } = result;
  after(async () => {
    try {
      await sendMail(magicLinkEmail(result.email, url.toString()));
    } catch (err) {
      console.error("[sign-in] could not send the sign-in email", err instanceof Error ? err.message : err);
      await withdrawMagicLink(token, charged, { db, mail }).catch(() => {});
    }
  });
  return { status: "sent", email: result.email };
}

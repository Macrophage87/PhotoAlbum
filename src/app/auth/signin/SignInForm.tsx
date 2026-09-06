"use client";

import { useActionState } from "react";
import { Button, Input, Label, FieldError } from "@/components/ui";
import { requestSignIn, type SignInState } from "./actions";

export function SignInForm({ next, prefillEmail }: { next?: string; prefillEmail?: string }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(requestSignIn, { status: "idle" });

  if (state.status === "sent") {
    return (
      <div className="space-y-2">
        <h2 className="font-display text-xl font-semibold">Check your email</h2>
        <p className="text-muted">
          If <span className="font-medium text-text">{state.email}</span> belongs to a family member, a sign-in link is on its way.
          It works once and expires in 15 minutes.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      {next && <input type="hidden" name="next" value={next} />}
      <div>
        <Label htmlFor="email">Email address</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={prefillEmail} placeholder="you@example.com" />
        <FieldError>{state.status === "error" ? state.message : null}</FieldError>
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Sending…" : "Email me a sign-in link"}
      </Button>
    </form>
  );
}

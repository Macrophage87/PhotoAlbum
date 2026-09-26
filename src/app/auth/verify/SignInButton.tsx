"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui";

/** Greyed out while the sign-in is on its way, so a second tap does not send the used-up link again. */
export function SignInButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full h-16 text-xl">
      {pending ? "Signing in…" : "Sign in"}
    </Button>
  );
}

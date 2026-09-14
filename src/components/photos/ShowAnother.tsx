"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

/**
 * Another handful from the trip. The overview picks its photographs afresh on every render, so asking the page for
 * itself again is all it takes — and it is worth a button, because a member who does not know the choice is random
 * has no reason to reload a page they have already read.
 */
export function ShowAnother() {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button type="button" variant="secondary" size="sm" disabled={pending} data-testid="show-another" onClick={() => start(() => router.refresh())}>
      {pending ? "Finding some…" : "Show another ten"}
    </Button>
  );
}

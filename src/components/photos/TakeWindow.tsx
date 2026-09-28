"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

/**
 * "Everything taken while it was happening", in one press.
 *
 * Says how many before doing anything, asks once, and says afterwards what it did — including the photographs from
 * that time it left alone because somebody already put them somewhere, so nobody wonders where the rest went.
 */
/** What to say about the photographs left alone, in words for anyone in the family. Exported for its test. */
export function leftAlone(kind: "trip" | "activity", n: number): string {
  if (n <= 0) return "";
  const one = n === 1;
  const them = one ? "it" : "them";
  const where = kind === "trip" ? "already on another trip" : "already put somewhere by a family member (on another trip, on another activity, or kept off activities)";
  return `${n} more from that time ${one ? "was" : "were"} ${where}, so ${one ? "it was" : "they were"} left alone. Search by date below to add ${one ? them : `any of ${them}`}.`;
}

export function TakeWindow({ kind, count, elsewhere, label, confirmText, doneHref, action, testId = "take-window" }: {
  /** A trip's days or an activity's hours: what "left alone" means differs. */
  kind: "trip" | "activity";
  /** How many would be added: worked out on the server when the page was built. */
  count: number;
  /** How many more were taken then but were put somewhere already, and so are not included. */
  elsewhere: number;
  /** The button: "Add all 12 photos taken during this activity". */
  label: string;
  /** The question asked before anything moves. */
  confirmText: string;
  /** Where to go afterwards; told how many were added with `?added=`. */
  doneHref: string;
  action: () => Promise<{ added: number; elsewhere: number }>;
  testId?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const others = leftAlone(kind, elsewhere);
  if (count === 0) {
    return <p className="text-sm text-muted" data-testid={`${testId}-none`}>None of your other photos were taken then.{others && ` ${others}`}</p>;
  }
  return (
    <div className="space-y-1" data-testid={testId}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(confirmText)) return;
          setError(null);
          start(async () => {
            try {
              const r = await action();
              router.push(`${doneHref}?added=${r.added}`);
            } catch (e) {
              setError(e instanceof Error ? e.message : "That did not work; try again.");
            }
          });
        }}
      >
        {pending ? "Adding…" : label}
      </Button>
      {others && <p className="text-xs text-muted">{others}</p>}
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    </div>
  );
}

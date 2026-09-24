"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

/**
 * "Everything taken while it was happening", in one press.
 *
 * Says how many before doing anything, asks once, and says afterwards what it did — including the photographs from
 * that time it left alone because they are on another trip, so nobody wonders where the rest went.
 */
export function TakeWindow({ count, elsewhere, label, confirmText, doneHref, action, testId = "take-window" }: {
  /** How many would be added: worked out on the server when the page was built. */
  count: number;
  /** How many more were taken then but are on some other trip, and so are not included. */
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
  const others = elsewhere > 0 ? ` ${elsewhere} more from that time ${elsewhere === 1 ? "is" : "are"} on another trip and ${elsewhere === 1 ? "is" : "are"} left there; search by date below to pick ${elsewhere === 1 ? "it" : "any of them"}.` : "";
  if (count === 0) {
    return <p className="text-sm text-muted" data-testid={`${testId}-none`}>None of your other photos were taken then.{others}</p>;
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
      {others && <p className="text-xs text-muted">{others.trim()}</p>}
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    </div>
  );
}

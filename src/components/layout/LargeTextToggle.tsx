"use client";

import { useTransition } from "react";
import { setLargeText } from "@/app/reading/actions";

/**
 * The switch for larger text and stronger contrast, at the foot of every page so it can be found from anywhere. It
 * says what it will do, in words, rather than being an icon somebody has to guess at.
 */
export function LargeTextToggle({ on }: { on: boolean }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      onClick={() => start(() => setLargeText(!on))}
      disabled={pending}
      aria-pressed={on}
      className="inline-flex min-h-11 items-center gap-2 rounded-theme border border-border bg-surface px-4 py-2 font-medium text-text hover:bg-surface-alt focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
      data-testid="large-text-toggle"
    >
      <span aria-hidden="true" className="font-display font-bold">
        {on ? "A" : "A+"}
      </span>
      {pending ? "Changing…" : on ? "Use the usual text size" : "Make the text bigger and clearer"}
    </button>
  );
}

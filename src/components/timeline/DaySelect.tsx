"use client";

import { useSelectionContext } from "@/components/photos/selection";

/**
 * Take a whole day off the timeline into the selection. A run of wrong dates is spotted a day at a time — a box of
 * scans that all landed on the day they were scanned sits together under one heading — so the fix starts there
 * rather than with a member ticking twenty tiles.
 */
export function DaySelect({ ids, label }: { ids: string[]; label: string }) {
  const ctx = useSelectionContext();
  if (!ctx || ids.length === 0) return null;
  const all = ids.every((id) => ctx.selected.has(id));
  return (
    <button
      type="button"
      onClick={() => (all ? ids.forEach((id) => ctx.toggle(id)) : ctx.add(ids))}
      className="text-xs font-normal text-muted hover:text-primary underline underline-offset-2 shrink-0"
      data-testid="day-select"
    >
      {all ? "Clear" : `Select ${label}`}
    </button>
  );
}

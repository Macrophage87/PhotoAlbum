"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { setTripDatesFromNeighbours } from "@/app/photos/[id]/actions";

/**
 * The whole-trip version: for a box of scans, or a folder an editor stripped on the way out, read every undated
 * item's date off its neighbours at once. The count is shown first, because this writes a date onto real photos.
 */
export function DateUndated({ tripId, undated, examples }: { tripId: string; undated: number; examples: { originalName: string; reading: string; evidence: string }[] }) {
  const [done, setDone] = useState<number | null>(null);
  const [pending, start] = useTransition();

  if (!undated) return <p className="text-sm text-muted">Every photo on this trip has a date worth keeping.</p>;

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">
        {undated} photo{undated === 1 ? "" : "s"} here {undated === 1 ? "has" : "have"} no date worth keeping — nothing in the file, the file&apos;s own clock, or a tag a photo editor may have rewritten. Their neighbours on this trip can say when they were taken.
      </p>
      <ul className="space-y-1 text-xs text-muted">
        {examples.map((e) => (
          <li key={e.originalName}><b className="text-foreground">{e.originalName}</b> → {e.reading} <span className="opacity-80">({e.evidence})</span></li>
        ))}
        {undated > examples.length && <li>…and {undated - examples.length} more.</li>}
      </ul>
      {done === null ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            if (!window.confirm(`Set the date on ${undated} photo${undated === 1 ? "" : "s"} from their neighbours on this trip? Each one can still be changed by hand afterwards.`)) return;
            start(async () => setDone(await setTripDatesFromNeighbours(tripId)));
          }}
        >
          {pending ? "Reading the neighbours…" : `Date ${undated} photo${undated === 1 ? "" : "s"} from their neighbours`}
        </Button>
      ) : (
        <p role="status" className="text-emerald-800">{done} photo{done === 1 ? "" : "s"} dated. Each one says it was set by hand, and can be changed.</p>
      )}
    </div>
  );
}

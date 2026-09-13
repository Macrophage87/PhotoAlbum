"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { surenessLabel } from "@/lib/photos/date-from-neighbours";
import { setDateFromNeighbours } from "@/app/photos/[id]/actions";

/**
 * What the rest of the trip says about an item whose own date was lost. Shown with the evidence rather than applied
 * quietly: the album is reading the neighbours, and a member should be able to check the reading before taking it.
 */
export function NeighbourDate({ photoId, guess }: { photoId: string; guess: { takenAt: string; tzOffsetMin: number; confidence: number; evidence: string; basis: string } }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [taken, setTaken] = useState(false);
  const [pending, start] = useTransition();
  const local = new Date(new Date(guess.takenAt).getTime() + guess.tzOffsetMin * 60_000);
  const reading = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(local);

  if (taken) return <p className="text-sm text-emerald-800" role="status">Date taken from the other photos on this trip.</p>;

  return (
    <div className="rounded-theme border border-border bg-surface-alt p-3 space-y-2 text-sm" data-testid="neighbour-date">
      <p>
        The other photos on this trip put this one at <b>{reading}</b> <span className="text-muted">({surenessLabel(guess.confidence)})</span>.
      </p>
      <p className="text-muted text-xs">Worked out from {guess.evidence}.</p>
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setMessage(null);
            const r = await setDateFromNeighbours(photoId);
            if (!r.ok) { setMessage(r.message); return; }
            setTaken(true);
            router.refresh();
          })
        }
      >
        {pending ? "Setting…" : "Use this date"}
      </Button>
      {message && <p role="alert" className="text-xs text-red-800">{message}</p>}
    </div>
  );
}

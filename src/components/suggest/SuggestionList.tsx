"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Suggestion } from "@/lib/suggest/score";
import { bulkMoveToTrip } from "@/app/photos/bulk-actions";
import { addToCollection } from "@/app/collections/actions";
import { previewAddToCollection, previewMoveToTrip } from "@/app/photos/exposure-actions";

/** "Add to Acadia: taken during the trip, 2 km from the Ocean Path hike" with a one-click attach. */
export function SuggestionList({ photoId, label, suggestions }: { photoId: string; label: string; suggestions: Suggestion[] }) {
  const [done, setDone] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const router = useRouter();
  if (!suggestions.length) return null;
  const attach = (s: Suggestion) =>
    start(async () => {
      const warnings = s.kind === "trip" ? await previewMoveToTrip([photoId], s.id) : await previewAddToCollection([photoId], s.id);
      if (warnings.length && !window.confirm(`${warnings.join("\n")}\n\nContinue?`)) return;
      if (s.kind === "trip") await bulkMoveToTrip([photoId], s.id);
      else await addToCollection(s.id, [photoId]);
      setDone((prev) => new Set(prev).add(`${s.kind}_${s.id}`));
      router.refresh();
    });
  return (
    <div className="text-sm">
      <p className="text-muted mb-1">Suggested for {label}:</p>
      <ul className="flex flex-wrap gap-2">
        {suggestions.map((s) => {
          const key = `${s.kind}_${s.id}`;
          return (
            <li key={key}>
              <button
                type="button"
                disabled={pending || done.has(key)}
                onClick={() => attach(s)}
                className="rounded-theme border border-border bg-surface px-3 py-1.5 text-left hover:bg-surface-alt disabled:opacity-60"
                title={s.reasons.join("; ")}
              >
                <span className="font-medium">{done.has(key) ? "Added to" : `Add to ${s.kind === "trip" ? "trip" : "collection"}`} {s.title}</span>
                <span className="block text-xs text-muted">{s.reasons.join(", ")}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

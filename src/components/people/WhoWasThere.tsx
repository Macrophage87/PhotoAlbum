"use client";

import { useState } from "react";
import { Label } from "@/components/ui";

export type Member = { id: string; label: string };

/**
 * Who was on this trip, or on this outing.
 *
 * The album files a photograph by its date, and a date cannot tell two families apart: where both are uploading
 * from the same fortnight, each collects the other's photographs. Naming who was there narrows the album's guess
 * to their uploads.
 *
 * Nobody ticked means everybody, and that is the default — it is what every trip made before this said, and for a
 * family where one person holds the camera it is the right answer forever. So the control starts closed, saying
 * "everyone", and only opens for whoever needs it.
 */
export function WhoWasThere({ members, selected, what }: { members: Member[]; selected: string[]; what: "trip" | "activity" }) {
  const [open, setOpen] = useState(selected.length > 0);
  const [picked, setPicked] = useState<Set<string>>(new Set(selected));
  if (members.length < 2) return null;
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const named = [...picked];
  return (
    <div>
      <Label>Who was on this {what === "trip" ? "trip" : "outing"}?</Label>
      {/* Present whether or not the list is open, and empty when nobody is named: the server reconciles to exactly
          what is sent, so a closed control must still say "everyone" rather than say nothing. */}
      <input type="hidden" name="participantsPresent" value="1" />
      {named.map((id) => (
        <input key={id} type="hidden" name="participants" value={id} />
      ))}
      {!open ? (
        <p className="text-sm text-muted">
          {named.length ? `${named.length} of the family` : "Everyone"} —{" "}
          <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setOpen(true)} data-testid={`${what}-who-open`}>
            choose who
          </button>
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-x-4 gap-y-2" data-testid={`${what}-who`}>
            {members.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} aria-label={m.label} />
                {m.label}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted">
            {named.length
              ? `Only what these ${named.length === 1 ? "member uploads" : "members upload"} will be filed here by its date. Anything anybody adds by hand stays put.`
              : "Nobody ticked means everyone — photographs are filed here by their date, whoever uploaded them."}
          </p>
        </div>
      )}
    </div>
  );
}

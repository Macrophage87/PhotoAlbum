"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

export type VisibilityOption = { value: "PRIVATE" | "LINK" | "PUBLIC"; label: string; help: string; warnings: string[] };

/**
 * Visibility radios for a trip or collection. Each option carries the exposure sentences computed on the server;
 * choosing one that widens exposure asks for an explicit confirmation before the form submits.
 */
export function VisibilityForm({ action, options, current }: { action: (fd: FormData) => Promise<void>; options: VisibilityOption[]; current: VisibilityOption["value"] }) {
  const [chosen, setChosen] = useState(current);
  const active = options.find((o) => o.value === chosen);
  return (
    <form
      action={action}
      className="space-y-3"
      onSubmit={(e) => {
        if (active && active.warnings.length && !window.confirm(`${active.warnings.join("\n")}\n\nContinue?`)) e.preventDefault();
      }}
    >
      {options.map((v) => (
        <label key={v.value} className="flex gap-3 items-start rounded-theme border border-border p-3 cursor-pointer has-[:checked]:border-primary has-[:checked]:ring-2 has-[:checked]:ring-ring">
          <input type="radio" name="visibility" value={v.value} checked={chosen === v.value} onChange={() => setChosen(v.value)} className="mt-1" />
          <span>
            <span className="font-medium">{v.label}</span>
            <span className="block text-sm text-muted">{v.help}</span>
            {v.warnings.length > 0 && (
              <span className="block mt-1 text-sm text-amber-800" role="note">
                {v.warnings.join(" ")}
              </span>
            )}
          </span>
        </label>
      ))}
      <Button type="submit" variant="secondary" disabled={chosen === current}>
        Update visibility
      </Button>
    </form>
  );
}

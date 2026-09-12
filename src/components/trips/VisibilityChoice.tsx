"use client";

import { useState } from "react";

export type VisibilityValue = "PRIVATE" | "LINK" | "PUBLIC";
export type VisibilityOption = { value: VisibilityValue; label: string; help: string; warnings: string[] };

/**
 * Visibility radios for a trip or collection, rendered inside the container's own settings form so the choice is
 * saved by the same button as the title and theme. Each option carries the exposure sentences computed on the
 * server; the surrounding form confirms before submitting a choice that widens exposure (see `confirmExposure`).
 */
export function VisibilityChoice({ options, current, legend }: { options: VisibilityOption[]; current: VisibilityValue; legend: string }) {
  const [chosen, setChosen] = useState(current);
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium mb-1">{legend}</legend>
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
    </fieldset>
  );
}

export type VisibilitySection = { current: VisibilityValue; options: VisibilityOption[]; legend: string };

/**
 * Ask before saving a change that makes things more visible. Reads the radio straight off the submitted form, so it
 * stays right whatever the user clicked last, and stays quiet when the choice has not moved.
 */
export function confirmExposure(form: HTMLFormElement, section: VisibilitySection | undefined): boolean {
  if (!section) return true;
  const chosen = String(new FormData(form).get("visibility") ?? "");
  if (!chosen || chosen === section.current) return true;
  const warnings = section.options.find((o) => o.value === chosen)?.warnings ?? [];
  return warnings.length === 0 || window.confirm(`${warnings.join("\n")}\n\nContinue?`);
}

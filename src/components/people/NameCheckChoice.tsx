import { Button } from "@/components/ui";
import type { NameCheck } from "@/lib/people/name-check";

/** What each level means, said plainly, with sentences a child called May, Grace or Brooklyn might appear in. */
export const NAME_CHECK_COPY: Record<NameCheck, { label: string; help: string; examples: string }> = {
  STRICT: {
    label: "Strict (recommended)",
    help: "Any mention of a child's name keeps the words for the family, even when the name is also an everyday word, a month or a place. Recommended when the album has young children whose names are also words or places, like May, Summer, Grace, Hope or Brooklyn.",
    examples: "With a child named May or Brooklyn, “A swim in May” and “Walking the Brooklyn Bridge” stay with the family.",
  },
  RELAXED: {
    label: "Relaxed",
    help: "A child's name that is plainly used as an everyday word in lowercase, as a month or season, or as a place does not keep the words back. This means an occasional sentence could name a child to strangers.",
    examples: "“We hope you enjoy it,” “Summer vacation at the lake” and “The Duomo in Florence” can be shown to everyone. “A hug from May” and “Grace, 5, blows out the candles” still stay with the family.",
  },
};

/**
 * The name check for the album (an admin's) or a trip (whoever arranges it): how names are checked before captions,
 * titles, descriptions, tags and the AI helper's words are shown to people outside the family (lib/people/name-check).
 * `inherit`: the album's level, when this is a trip's and may follow it.
 */
export function NameCheckChoice({ action, current, inherit, changed, testId }: { action: (fd: FormData) => Promise<void>; current: NameCheck | "INHERIT"; inherit?: NameCheck; changed: { by: string; at: Date } | null; testId: string }) {
  const options: { value: NameCheck | "INHERIT"; label: string; help: string; examples?: string }[] = [
    ...(inherit ? [{ value: "INHERIT" as const, label: `Same as the album (${NAME_CHECK_COPY[inherit].label.replace(" (recommended)", "")})`, help: "Follows the setting on the Admin page, and changes when it does." }] : []),
    ...(["STRICT", "RELAXED"] as const).map((v) => ({ value: v, ...NAME_CHECK_COPY[v] })),
  ];
  return (
    <form action={action} className="space-y-3" data-testid={testId}>
      <fieldset className="space-y-3">
        <legend className="text-sm text-muted mb-1">
          Before captions, titles, descriptions, tags and the AI helper&apos;s words are shown to anyone outside the family, the album checks them for the names of children and of anyone who opted out or said no.
        </legend>
        {options.map((o) => (
          <label key={o.value} className="flex gap-3 items-start rounded-theme border border-border p-3 cursor-pointer has-[:checked]:border-primary has-[:checked]:ring-2 has-[:checked]:ring-ring">
            <input type="radio" name="nameCheck" value={o.value} defaultChecked={current === o.value} className="mt-1" />
            <span>
              <span className="font-medium">{o.label}</span>
              <span className="block text-sm text-muted">{o.help}</span>
              {o.examples && <span className="block text-sm text-muted mt-1">{o.examples}</span>}
            </span>
          </label>
        ))}
      </fieldset>
      <p className="text-sm text-muted">
        People who opted out, said no, or asked to have their name taken out are always checked strictly. Switching to Strict checks again everything already shown to everyone and takes back anything Strict would keep. Switching to Relaxed doesn&apos;t release anything already kept for the family; it applies to what is described or shown from then on.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" size="sm">Save name check</Button>
        {changed && <span className="text-sm text-muted">Last changed by {changed.by} on {changed.at.toLocaleDateString("en-US")}.</span>}
      </div>
    </form>
  );
}

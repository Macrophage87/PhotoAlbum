"use client";

import { useState, useTransition } from "react";
import { Button, Textarea } from "@/components/ui";

/**
 * The activity's description, and — for whoever arranges the trip — the box it is written in.
 *
 * Two ways to end up with a paragraph under the title, and they are the same box. Type it yourself and save it, or
 * type what only you know and let the helper build the description around it: that it was somebody's birthday,
 * that the wind was the whole story, that the point of the walk was the ice cream at the end. None of that is in
 * the photographs, and a description written without it reads like a stranger's.
 *
 * What comes back lands in the same box rather than on the page, because the helper's paragraph is a draft: the
 * name it did not know and the hill it called a mountain are a sentence away from fixed, and the fixing happens
 * here rather than three pages away in the activity's edit form.
 */
export function ActivityDescription({
  description,
  save,
  describe,
}: {
  description: string | null;
  /** Store what is in the box. Absent for anyone who may not arrange this trip — they only read. */
  save?: (text: string) => Promise<void>;
  /** Ask the helper, with whatever is in the box as the note. Absent when the helper is off or there is nothing to look at. */
  describe?: (note: string) => Promise<string>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!save) return description ? <p className="max-w-3xl whitespace-pre-line" data-testid="activity-description">{description}</p> : null;

  const run = (work: () => Promise<void>) =>
    start(async () => {
      setError(null);
      try {
        await work();
      } catch (e) {
        setError(e instanceof Error ? e.message : "That did not work; try again");
      }
    });

  if (!editing) {
    return (
      <div className="space-y-2">
        {description && <p className="max-w-3xl whitespace-pre-line" data-testid="activity-description">{description}</p>}
        <Button
          size="sm"
          variant="secondary"
          data-testid="activity-description-edit"
          onClick={() => {
            setText(description ?? "");
            setError(null);
            setEditing(true);
          }}
        >
          {description ? "Edit description" : "Add a description"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 max-w-3xl">
      <Textarea
        rows={5}
        value={text}
        aria-label="Description"
        data-testid="activity-description-text"
        placeholder={
          describe
            ? "Write the description here — or note what only you know (whose birthday it was, why you turned back), and the AI helper will use it as context when it writes one."
            : "Write the description here."
        }
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={pending} data-testid="activity-description-save" onClick={() => run(async () => { await save(text); setEditing(false); })}>
          {pending ? "Working…" : "Save"}
        </Button>
        {/* The helper costs something and is being handed the family's photographs, so it is asked for by name and
            confirmed, never a side effect of saving. */}
        {describe && (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            data-testid="activity-describe"
            onClick={() =>
              run(async () => {
                const note = text.trim();
                const warning = note
                  ? "Ask the helper to write this description? The photographs on this activity, and what you have typed, go to the AI helper, and what is in the box is replaced by what it writes."
                  : "Ask the helper to write this description? The photographs on this activity go to the AI helper.";
                if (!window.confirm(warning)) return;
                setText(await describe(note));
              })
            }
          >
            {text.trim() ? "Write it around this" : "Let the helper write it"}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setEditing(false); setText(description ?? ""); setError(null); }}>
          Cancel
        </Button>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <p className="text-sm text-muted">
        {describe
          ? "Whatever is in the box is the description if you save it, and context for the AI helper if you ask it to write instead. What it writes comes back here, so you can change it before you save."
          : "The AI helper is switched off, so this one is yours to write."}
      </p>
    </div>
  );
}

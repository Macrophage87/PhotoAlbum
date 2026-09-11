"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Label, Textarea } from "@/components/ui";
import { useSelectionContext } from "@/components/photos/selection";
import { markReviewed, setContext } from "@/app/review/actions";
import { setAnnotationOptOut } from "@/app/annotation/actions";

/**
 * Context and mark-reviewed controls for a batch. Inside a SelectionProvider the selected photos are the target;
 * with nothing selected the whole batch is.
 */
export function ReviewPanel({ allIds, annotation }: { allIds: string[]; /** Present when the AI helper is on: how many of these items are still waiting to be sent. */ annotation: { quietMinutes: number; pending: number } | null }) {
  const ctx = useSelectionContext();
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const selected = ctx?.active && ctx.selected.size ? [...ctx.selected] : [];
  const target = selected.length ? selected : allIds;
  const label = selected.length ? `${selected.length} selected` : `all ${allIds.length}`;

  const apply = (mode: "replace" | "append") =>
    start(async () => {
      const n = await setContext(target, note, mode);
      setStatus(`${mode === "replace" ? "Set" : "Added"} the note on ${n} item${n === 1 ? "" : "s"}.`);
      router.refresh();
    });
  const optOut = () =>
    start(async () => {
      const n = await setAnnotationOptOut(target, true);
      setStatus(`${n} item${n === 1 ? "" : "s"} will not be sent to the AI helper.`);
      router.refresh();
    });
  const done = () =>
    start(async () => {
      const n = await markReviewed(target);
      setStatus(`${n} item${n === 1 ? "" : "s"} marked reviewed.`);
      router.refresh();
    });

  return (
    <div className="rounded-theme border border-border bg-surface p-4 space-y-3">
      <div>
        <Label htmlFor="context">Notes for {label}</Label>
        <Textarea id="context" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Who, where, what was happening: “Grandma Jo's 80th at the lake house, everyone came”" />
        <p className="text-xs text-muted mt-1">One note can cover a whole batch. Notes feed search{annotation ? " and the AI description" : ""}.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={pending || !note.trim()} onClick={() => apply("replace")}>Set note</Button>
        <Button size="sm" variant="secondary" disabled={pending || !note.trim()} onClick={() => apply("append")}>Add to existing notes</Button>
        <span className="mx-1 text-border">|</span>
        <Button size="sm" variant="secondary" disabled={pending || !allIds.length} onClick={done}>Mark {label} reviewed</Button>
        {status && <span className="text-sm text-muted" role="status">{status}</span>}
      </div>
      {annotation && annotation.pending > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm rounded-theme bg-surface-alt p-3">
          <span>
            {annotation.pending} item{annotation.pending === 1 ? "" : "s"} will be sent to the AI helper when you mark them reviewed, or after {annotation.quietMinutes} minutes without changes.
          </span>
          <Button size="sm" variant="secondary" disabled={pending} onClick={optOut}>Don&apos;t send {label} to the AI helper</Button>
        </div>
      )}
    </div>
  );
}

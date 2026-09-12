"use client";

import { useState, useTransition } from "react";
import { Button, Input, Label, Select } from "@/components/ui";
import { TRASH_REASONS } from "@/lib/photos/trash";

/** The picker itself: a reason from the list, and a note (required only for "Something else"). */
function ReasonFields({ reason, setReason, note, setNote, idPrefix }: { reason: string; setReason: (v: string) => void; note: string; setNote: (v: string) => void; idPrefix: string }) {
  const hint = TRASH_REASONS.find((r) => r.value === reason)?.hint;
  return (
    <div className="space-y-2">
      <div>
        <Label htmlFor={`${idPrefix}-reason`}>Why is it going to the trash?</Label>
        <Select id={`${idPrefix}-reason`} name="reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          {TRASH_REASONS.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </Select>
        {hint && <p className="text-xs text-muted mt-1">{hint}</p>}
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-note`}>Anything to add? {reason === "OTHER" ? "" : "(optional)"}</Label>
        <Input id={`${idPrefix}-note`} name="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={reason === "OTHER" ? "A few words for whoever looks at the trash" : ""} required={reason === "OTHER"} />
      </div>
    </div>
  );
}

/**
 * One item's way into the trash. Nothing is deleted: the item leaves the album at once and an admin decides later
 * whether it comes back or goes for good, so a member never has to be sure before pressing it.
 */
export function TrashButton({ action }: { action: (fd: FormData) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(TRASH_REASONS[0].value as string);
  const [note, setNote] = useState("");
  if (!open) {
    return <Button variant="danger" size="sm" onClick={() => setOpen(true)}>Move to trash</Button>;
  }
  return (
    <form action={action} className="w-full max-w-sm space-y-3 rounded-theme border border-border bg-surface-alt p-3">
      <ReasonFields reason={reason} setReason={setReason} note={note} setNote={setNote} idPrefix="trash" />
      <p className="text-xs text-muted">It leaves every gallery, the timeline, the map and any share link straight away. An admin can restore it or delete it for good.</p>
      <div className="flex gap-2">
        <Button type="submit" variant="danger" size="sm">Move to trash</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

/** The same picker for a selection in a gallery, answering through a callback rather than a form action. */
export function BulkTrashControl({ count, disabled, onTrash }: { count: number; disabled: boolean; onTrash: (reason: string, note: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(TRASH_REASONS[0].value as string);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  if (!open) {
    return <Button size="sm" variant="danger" disabled={disabled} onClick={() => setOpen(true)}>Move to trash</Button>;
  }
  return (
    <div className="w-full max-w-sm space-y-3 rounded-theme border border-border bg-surface p-3 text-left">
      <p className="text-sm font-medium">Move {count} item{count === 1 ? "" : "s"} to the trash</p>
      <ReasonFields reason={reason} setReason={setReason} note={note} setNote={setNote} idPrefix="bulk-trash" />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="danger"
          disabled={pending || (reason === "OTHER" && !note.trim())}
          onClick={() => start(async () => { await onTrash(reason, note); setOpen(false); setNote(""); })}
        >
          {pending ? "Moving…" : "Move to trash"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}

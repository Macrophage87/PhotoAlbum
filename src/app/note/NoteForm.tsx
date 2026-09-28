"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button, FieldError, Input, Label, Textarea } from "@/components/ui";
import { HONEYPOT_FIELD, MESSAGE_MAX, NAME_MAX, type NoteState } from "@/lib/notes/validate";
import { sendNote } from "./actions";

/**
 * The note form. It works before (or without) JavaScript: the action posts like any form and the page comes back
 * with its answer. What was typed comes back with an answer that is not a thank-you, so nothing has to be written
 * again.
 */
export function NoteForm({ token, photo, page, back }: { token: string; photo: string; page: string; back: string }) {
  const [state, action, pending] = useActionState<NoteState, FormData>(sendNote, { status: "idle", token });

  if (state.status === "sent") {
    return (
      <div className="space-y-3" role="status" data-testid="note-sent">
        <h2 className="font-display text-2xl font-semibold">Sent — thank you!</h2>
        <p className="text-muted">Your note is on its way to the family.</p>
        <Link href={back} className="text-primary underline underline-offset-2">Back to the album</Link>
      </div>
    );
  }

  const values = state.status === "error" ? state.values : { name: "", email: "", message: "", photo, page };
  const errors = state.status === "error" ? state.errors : {};
  return (
    <form action={action} className="space-y-4" data-testid="note-form">
      <input type="hidden" name="token" value={state.token} />
      <input type="hidden" name="photo" value={values.photo} />
      <input type="hidden" name="page" value={values.page} />
      {/* For form-filling scripts only: out of sight, out of the tab order, and hidden from screen readers. */}
      <div aria-hidden="true" className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="note-website">Leave this empty</label>
        <input id="note-website" name={HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>
      {state.status === "error" && state.message && <p role="alert" className="rounded-theme border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{state.message}</p>}
      <div>
        <Label htmlFor="note-name">Your name</Label>
        <Input id="note-name" name="name" required maxLength={NAME_MAX} autoComplete="name" defaultValue={values.name} aria-invalid={Boolean(errors.name)} />
        <FieldError>{errors.name}</FieldError>
      </div>
      <div>
        <Label htmlFor="note-email">Your email <span className="font-normal text-muted">(optional, so we can reply)</span></Label>
        <Input id="note-email" name="email" type="email" autoComplete="email" defaultValue={values.email} aria-invalid={Boolean(errors.email)} />
        <FieldError>{errors.email}</FieldError>
      </div>
      <div>
        <Label htmlFor="note-message">Your message</Label>
        <Textarea id="note-message" name="message" required rows={6} maxLength={MESSAGE_MAX} defaultValue={values.message} aria-invalid={Boolean(errors.message)} />
        <FieldError>{errors.message}</FieldError>
      </div>
      <Button type="submit" disabled={pending}>{pending ? "Sending…" : "Send note"}</Button>
    </form>
  );
}

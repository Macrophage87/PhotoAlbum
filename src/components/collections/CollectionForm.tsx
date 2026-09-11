"use client";

import { useActionState } from "react";
import { Button, FieldError, Input, Label, Textarea } from "@/components/ui";
import { ThemePicker } from "@/components/trips/ThemePicker";
import type { CollectionFormState } from "@/app/collections/actions";

export type CollectionFormValues = { title: string; description: string; themeKey: string };

export function CollectionForm({ action, initial, submitLabel }: { action: (prev: CollectionFormState, fd: FormData) => Promise<CollectionFormState>; initial: CollectionFormValues; submitLabel: string }) {
  const [state, formAction, pending] = useActionState<CollectionFormState, FormData>(action, { status: "idle" });
  const err = (k: keyof CollectionFormValues) => (state.status === "error" ? state.fieldErrors?.[k] : undefined);
  return (
    <form action={formAction} className="space-y-6">
      <div>
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" required defaultValue={initial.title} placeholder="Summer favourites" />
        <FieldError>{err("title")}</FieldError>
      </div>
      <div>
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" name="description" rows={3} defaultValue={initial.description} placeholder="What ties these photos together" />
      </div>
      <div>
        <Label>Theme</Label>
        <ThemePicker value={initial.themeKey} />
      </div>
      {state.status === "error" && state.message && <FieldError>{state.message}</FieldError>}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}

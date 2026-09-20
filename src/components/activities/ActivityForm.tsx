"use client";

import { useActionState } from "react";
import type { ActivityType } from "@/generated/prisma/enums";
import { ACTIVITY_LABEL, ACTIVITY_TYPES } from "@/lib/activities/types";
import { Button, FieldError, Input, Label, Select, Textarea } from "@/components/ui";
import { WhoWasThere, type Member } from "@/components/people/WhoWasThere";

export type ActivityFormState = { status: "idle" } | { status: "error"; message?: string; fieldErrors?: Record<string, string> };
export type ActivityFormValues = { title: string; type: ActivityType; start: string; end: string; description: string; participants: string[] };

export function ActivityForm({ action, initial, submitLabel, timezone, members }: { action: (prev: ActivityFormState, fd: FormData) => Promise<ActivityFormState>; initial: ActivityFormValues; submitLabel: string; timezone: string; /** The family, so the outing can say who was on it. */ members: Member[] }) {
  const [state, formAction, pending] = useActionState<ActivityFormState, FormData>(action, { status: "idle" });
  const err = (k: keyof ActivityFormValues) => (state.status === "error" ? state.fieldErrors?.[k] : undefined);
  return (
    <form action={formAction} className="space-y-5">
      <div>
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" required defaultValue={initial.title} placeholder="Cadillac Mountain sunrise hike" />
        <FieldError>{err("title")}</FieldError>
      </div>
      <div>
        <Label htmlFor="type">Type</Label>
        <Select id="type" name="type" defaultValue={initial.type}>
          {ACTIVITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {ACTIVITY_LABEL[t]}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <Label htmlFor="start">Start</Label>
          <Input id="start" name="start" type="datetime-local" required defaultValue={initial.start} step={60} />
          <FieldError>{err("start")}</FieldError>
        </div>
        <div>
          <Label htmlFor="end">End</Label>
          <Input id="end" name="end" type="datetime-local" required defaultValue={initial.end} step={60} />
          <FieldError>{err("end")}</FieldError>
        </div>
      </div>
      <p className="text-xs text-muted -mt-2">Times are in the trip&apos;s zone ({timezone}). Photos taken in this window are attached automatically.</p>
      <WhoWasThere members={members} selected={initial.participants} what="activity" />
      <div>
        <Label htmlFor="description">Notes</Label>
        <Textarea id="description" name="description" rows={4} defaultValue={initial.description} />
      </div>
      {state.status === "error" && state.message && <FieldError>{state.message}</FieldError>}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}

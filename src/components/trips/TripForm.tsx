"use client";

import { useActionState } from "react";
import { Button, FieldError, Input, Label, Select, Textarea } from "@/components/ui";
import { ThemePicker } from "./ThemePicker";
import { confirmExposure, VisibilityChoice, type VisibilitySection } from "./VisibilityChoice";
import type { TripFormState } from "@/app/trips/new/actions";
import { WhoWasThere, type Member } from "@/components/people/WhoWasThere";

export type TripFormValues = { title: string; description: string; startDate: string; endDate: string; timezone: string; themeKey: string; participants: string[] };

const COMMON_ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Zurich",
  "Europe/Stockholm",
  "Europe/Athens",
  "Europe/Lisbon",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Singapore",
  "Asia/Bangkok",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
  "Africa/Johannesburg",
  "America/Sao_Paulo",
  "America/Buenos_Aires",
  "America/Lima",
  "America/Santiago",
];

export function TripForm({ action, initial, submitLabel, visibility, members }: { action: (prev: TripFormState, fd: FormData) => Promise<TripFormState>; initial: TripFormValues; submitLabel: string; visibility?: VisibilitySection; /** The family, so the trip can say who was on it. */ members: Member[] }) {
  const [state, formAction, pending] = useActionState<TripFormState, FormData>(action, { status: "idle" });
  const err = (k: keyof TripFormValues) => (state.status === "error" ? state.fieldErrors?.[k] : undefined);
  const zones = COMMON_ZONES.includes(initial.timezone) ? COMMON_ZONES : [initial.timezone, ...COMMON_ZONES];
  return (
    <form action={formAction} className="space-y-6" onSubmit={(e) => { if (!confirmExposure(e.currentTarget, visibility)) e.preventDefault(); }}>
      <div>
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" required defaultValue={initial.title} placeholder="Acadia, Maine" />
        <FieldError>{err("title")}</FieldError>
      </div>
      <div>
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" name="description" rows={3} defaultValue={initial.description} placeholder="A few words about the trip" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="startDate">Start date</Label>
          <Input id="startDate" name="startDate" type="date" required defaultValue={initial.startDate} />
          <FieldError>{err("startDate")}</FieldError>
        </div>
        <div>
          <Label htmlFor="endDate">End date</Label>
          <Input id="endDate" name="endDate" type="date" required defaultValue={initial.endDate} />
          <FieldError>{err("endDate")}</FieldError>
        </div>
      </div>
      <div>
        <Label htmlFor="timezone">Time zone of the destination</Label>
        <Select id="timezone" name="timezone" defaultValue={initial.timezone}>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted mt-1">Used to group photos by day and to interpret camera times that lack a time zone.</p>
        <FieldError>{err("timezone")}</FieldError>
      </div>
      <WhoWasThere members={members} selected={initial.participants} what="trip" />
      <div>
        <Label>Theme</Label>
        <ThemePicker value={initial.themeKey} />
      </div>
      {visibility && <VisibilityChoice current={visibility.current} options={visibility.options} legend={visibility.legend} />}
      {state.status === "error" && state.message && <FieldError>{state.message}</FieldError>}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}

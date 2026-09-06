"use client";

import { useActionState } from "react";
import { Button, FieldError, Input, Label, Select } from "@/components/ui";
import { inviteMember, type InviteState } from "@/app/admin/actions";

export function InviteForm() {
  const [state, action, pending] = useActionState<InviteState, FormData>(inviteMember, { status: "idle" });
  return (
    <form action={action} className="grid sm:grid-cols-[1fr_9rem_auto] gap-3 items-end">
      <div>
        <Label htmlFor="email">Email address</Label>
        <Input id="email" name="email" type="email" required placeholder="cousin@example.com" />
      </div>
      <div>
        <Label htmlFor="role">Role</Label>
        <Select id="role" name="role" defaultValue="MEMBER">
          <option value="MEMBER">Member</option>
          <option value="ADMIN">Admin</option>
        </Select>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send invite"}
      </Button>
      <div className="sm:col-span-3">
        {state.status === "sent" && <p className="text-sm text-emerald-700">Invitation sent to {state.email}.</p>}
        <FieldError>{state.status === "error" ? state.message : null}</FieldError>
      </div>
    </form>
  );
}

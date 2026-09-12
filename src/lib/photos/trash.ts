import { z } from "zod";
import type { TrashReason } from "@/generated/prisma/enums";

/**
 * An item in the trash is hidden everywhere and skipped by every background job, but its file is still on disk and
 * its record is intact, so restoring it puts it back exactly as it was. This filter is what "hidden everywhere"
 * means in practice; every surface that lists media spreads it.
 */
export const NOT_TRASHED = { trashedAt: null } as const;

/** The reasons offered in the picker, in the order they are shown. "Something else" always asks for a note. */
export const TRASH_REASONS: { value: TrashReason; label: string; hint?: string }[] = [
  { value: "BLURRY", label: "Blurry, dark or out of focus" },
  { value: "DUPLICATE", label: "A duplicate of another item" },
  { value: "ACCIDENT", label: "Taken by accident" },
  { value: "NOT_WORTH_KEEPING", label: "Nothing worth keeping in it" },
  { value: "PRIVATE", label: "Too private for the album", hint: "Kept in the trash until an admin deletes it, so it is out of the album straight away." },
  { value: "SOMEONE_ASKED", label: "Someone in it asked me to remove it", hint: "An admin is told this was a request, so it is not restored by mistake." },
  { value: "OTHER", label: "Something else" },
];

export const trashReasonValues = TRASH_REASONS.map((r) => r.value) as [TrashReason, ...TrashReason[]];

export const trashSchema = z.object({
  reason: z.enum(trashReasonValues),
  note: z.string().trim().max(200).optional().default(""),
});

const LABELS = new Map(TRASH_REASONS.map((r) => [r.value, r.label]));

/** The reason in words, with the member's own note after it. */
export function trashReasonLabel(reason: TrashReason | null, note: string | null): string {
  const label = reason ? LABELS.get(reason) ?? reason : "No reason given";
  return note ? `${label} — ${note}` : label;
}

/** A request someone made about their own picture is never quietly restored; the admin page says so out loud. */
export function isRemovalRequest(reason: TrashReason | null): boolean {
  return reason === "SOMEONE_ASKED";
}

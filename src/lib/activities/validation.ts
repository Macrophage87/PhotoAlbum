import { z } from "zod";
import { ACTIVITY_TYPES } from "./types";
import { wallTimeToInstant } from "@/lib/time/local-day";

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "Pick a date and time");

export const activityInputSchema = z
  .object({
    title: z.string().trim().min(1, "Give the activity a title").max(120),
    type: z.enum(ACTIVITY_TYPES as [string, ...string[]]),
    start: localDateTime,
    end: localDateTime,
    description: z.string().trim().max(4000).optional().transform((v) => v || null),
  })
  .refine((v) => v.end >= v.start, { message: "End must be after the start", path: ["end"] });

export type ActivityInput = z.infer<typeof activityInputSchema>;

export function activityInputFromForm(fd: FormData) {
  return activityInputSchema.safeParse({
    title: fd.get("title"),
    type: fd.get("type"),
    start: fd.get("start"),
    end: fd.get("end"),
    description: fd.get("description") ?? undefined,
  });
}

/** "2025-08-12T15:04" typed in the trip's zone -> UTC instant */
export function localInputToInstant(value: string, timezone: string): Date {
  const [d, t] = value.split("T");
  const [year, month, day] = d.split("-").map(Number);
  const [hour, minute, second = 0] = t.split(":").map(Number);
  return wallTimeToInstant({ year, month, day, hour, minute, second }, timezone);
}

import { z } from "zod";
import { isThemeKey } from "@/themes";
import { isValidTimezone } from "@/lib/time/local-day";

export const tripInputSchema = z
  .object({
    title: z.string().trim().min(1, "Give the trip a title").max(120),
    description: z.string().trim().max(2000).optional().transform((v) => v || null),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date"),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick an end date"),
    timezone: z.string().refine(isValidTimezone, "Unknown time zone"),
    themeKey: z.string().refine(isThemeKey, "Unknown theme"),
  })
  .refine((v) => v.endDate >= v.startDate, { message: "End date must be on or after the start date", path: ["endDate"] });

export type TripInput = z.infer<typeof tripInputSchema>;

export function tripInputFromForm(fd: FormData) {
  return tripInputSchema.safeParse({
    title: fd.get("title"),
    description: fd.get("description") ?? undefined,
    startDate: fd.get("startDate"),
    endDate: fd.get("endDate"),
    timezone: fd.get("timezone"),
    themeKey: fd.get("themeKey"),
  });
}

export function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of err.issues) {
    const k = String(i.path[0] ?? "form");
    if (!out[k]) out[k] = i.message;
  }
  return out;
}

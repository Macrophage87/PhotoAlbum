import { z } from "zod";
import { isThemeKey } from "@/themes";

export const collectionInputSchema = z.object({
  title: z.string().trim().min(1, "Give the collection a title").max(120),
  description: z.string().trim().max(2000).optional().transform((v) => v || null),
  themeKey: z.string().refine(isThemeKey, "Unknown theme"),
});

export type CollectionInput = z.infer<typeof collectionInputSchema>;

export function collectionInputFromForm(fd: FormData) {
  return collectionInputSchema.safeParse({ title: fd.get("title"), description: fd.get("description") ?? undefined, themeKey: fd.get("themeKey") });
}

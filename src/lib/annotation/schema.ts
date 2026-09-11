import { z } from "zod";

/** What the helper returns for one item. Everything is optional-tolerant on the way in and normalised on the way out. */
export const annotationSchema = z.object({
  caption: z.string().max(200).describe("One line, under fifteen words, what a family member would write under the photo"),
  description: z.string().max(2000).describe("Two to five sentences: who is doing what, where, the mood; use the notes and names you were given"),
  tags: z.array(z.string().max(40)).max(25).describe("Lowercase keywords a family would search for: activities, food, objects, weather, occasions"),
  place: z.string().max(120).nullable().describe("The place shown or named in the notes, or null"),
  activity: z.string().max(80).nullable().describe("What people are doing, in a few words, or null"),
  objects: z.array(z.string().max(40)).max(20).describe("Notable objects, animals and vehicles"),
  visibleText: z.string().max(500).nullable().describe("Any legible text in the image (signs, banners, cake writing), or null"),
  season: z.enum(["spring", "summer", "autumn", "winter", "unknown"]),
  mood: z.string().max(60).nullable(),
  searchSummary: z.string().max(600).describe("A dense summary for search: synonyms, occasions, relationships mentioned in the notes"),
  estimatedYear: z
    .object({
      from: z.number().int().min(1800).max(2100),
      to: z.number().int().min(1800).max(2100),
      confidence: z.number().min(0).max(1),
      evidence: z.string().max(300),
    })
    .nullable()
    .describe("Only when asked to estimate a date: a year range with the evidence used; otherwise null"),
});

export type Annotation = z.infer<typeof annotationSchema>;

/** The part stored on the item (the estimate lives in its own columns). */
export type StoredAnnotation = Omit<Annotation, "estimatedYear">;

export function toStored(a: Annotation): StoredAnnotation {
  const { estimatedYear: _drop, ...rest } = a;
  void _drop;
  return { ...rest, tags: uniqueLower(rest.tags), objects: uniqueLower(rest.objects) };
}

function uniqueLower(list: string[]): string[] {
  return [...new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

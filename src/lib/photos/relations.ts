import type { PhotoRelation } from "@/generated/prisma/enums";

/** Labels for photo-to-photo relations. Kept free of server imports so client components can use it. */
export const RELATION_LABEL: Record<PhotoRelation, string> = {
  SAME_SCENE: "Same scene",
  BEFORE_AFTER: "Before / after",
  PANORAMA_PART: "Part of a panorama",
  DETAIL_OF: "Detail of",
  RELATED: "Related",
};

/** Links are stored with the smaller id first so a pair can't be linked twice in opposite directions. */
export function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

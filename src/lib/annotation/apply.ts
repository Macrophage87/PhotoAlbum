import { db } from "@/lib/db";
import { annotationSchema, clampAnnotation, toStored, type Annotation, type StoredAnnotation } from "./schema";
import { enqueueEmbedding } from "@/lib/jobs/handlers/embed-photo";
import { applyPlaceEstimate, needsPlaceEstimate } from "./place";
import { isWeakDate } from "@/lib/photos/date-from-neighbours";

export type ApplyResult = { ok: true } | { ok: false; reason: "refusal" | "invalid" | "max_tokens" };

/** Persist a parsed record on the item and keep the raw response briefly for debugging. Never logs content. */
export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

/** The fields a member can rewrite on the item's page (see `updateAnnotation`): theirs, once they have. */
const MEMBER_FIELDS = ["caption", "description", "tags", "place", "activity", "objects", "visibleText", "mood"] as const;

/**
 * The record to store: the fresh one, or — where a member has edited the text — theirs, with only what they cannot
 * edit (the search summary, the season, the title the helper offers) brought up to date.
 */
export function keepMemberText(fresh: StoredAnnotation, current: unknown, edited: boolean): StoredAnnotation {
  if (!edited || !current || typeof current !== "object") return fresh;
  const kept: Record<string, unknown> = { ...fresh };
  for (const k of MEMBER_FIELDS) if (k in current) kept[k] = (current as Record<string, unknown>)[k];
  return kept as StoredAnnotation;
}

export async function applyAnnotation(photoId: string, model: string, parsed: Annotation, raw: { usage?: Usage; batched?: boolean } & Record<string, unknown>, opts: { replaceEdited?: boolean } = {}): Promise<void> {
  const current = await db.photo.findUnique({ where: { id: photoId }, select: { takenAt: true, takenAtSource: true, estimatedDateSource: true, annotation: true, annotationSource: true, title: true, kind: true, lat: true, placeSetById: true, placeEstimatedAt: true } });
  if (!current) return;
  // A member's edits are never overwritten by the notes sweep or the names backfill; only a member pressing
  // "Describe again" and agreeing to lose them replaces them.
  const edited = current.annotationSource === "EDITED" && !opts.replaceEdited;
  const stored = keepMemberText(toStored(parsed), current.annotation, edited);
  const est = parsed.estimatedYear;
  const noReliableDate = isWeakDate(current.takenAtSource, current.takenAt);
  const keepMemberEstimate = current.estimatedDateSource === "MEMBER";
  await db.$transaction([
    db.photo.update({
      where: { id: photoId },
      data: {
        annotation: stored,
        annotationModel: model,
        annotatedAt: new Date(),
        // Re-annotation only refreshes machine text, so an edited record stays the family's.
        annotationSource: edited ? "EDITED" : "MACHINE",
        annotationError: null,
        // A title the family did not write themselves: only ever filled in where there is none (embedded videos keep YouTube's).
        ...(!current.title?.trim() && current.kind !== "EXTERNAL_VIDEO" && stored.title.trim() ? { title: stored.title.trim() } : {}),
        annotationInputTokens: raw.usage?.input_tokens ?? null,
        annotationCacheReadTokens: raw.usage?.cache_read_input_tokens ?? null,
        annotationCacheWriteTokens: raw.usage?.cache_creation_input_tokens ?? null,
        annotationOutputTokens: raw.usage?.output_tokens ?? null,
        annotationBatched: raw.batched ?? false,
        ...(est && noReliableDate && !keepMemberEstimate
          ? { estimatedDate: new Date(Date.UTC(Math.round((est.from + est.to) / 2), 6, 1)), estimatedDateConfidence: est.confidence, estimatedDateSource: "MODEL", estimatedDateNote: `${est.from}–${est.to}: ${est.evidence}` }
          : {}),
      },
    }),
    db.mediaAnnotationRaw.create({ data: { photoId, model, response: raw as object } }),
  ]);
  // The place guess is only ever recorded for an item that was actually asked, so clearing a position later still
  // leaves it eligible for the backfill.
  if (needsPlaceEstimate(current)) await applyPlaceEstimate(photoId, parsed.estimatedPlace);
  // The description changed, so the semantic index for this item is stale.
  await enqueueEmbedding(photoId, true);
}

/** Validate a message the way `messages.parse` would, for batch results that come back as plain messages. */
export function parseMessageContent(content: { type: string; text?: string }[]): Annotation | null {
  const text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  try {
    const result = annotationSchema.safeParse(clampAnnotation(JSON.parse(text)));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Record why an item was not annotated. A terminal failure (refusal, unusable output) counts as done so the item is
 * not re-sent; a transport failure (batch errored or expired) keeps `annotatedAt` empty so a later backfill can retry.
 */
export async function recordFailure(photoId: string, reason: string, opts: { terminal?: boolean } = {}): Promise<void> {
  const terminal = opts.terminal ?? true;
  await db.photo.update({ where: { id: photoId }, data: { annotationError: reason.slice(0, 80), ...(terminal ? { annotatedAt: new Date() } : {}) } }).catch(() => {});
}

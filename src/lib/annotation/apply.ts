import { db } from "@/lib/db";
import { annotationSchema, clampAnnotation, toStored, type Annotation } from "./schema";
import { enqueueEmbedding } from "@/lib/jobs/handlers/embed-photo";
import { applyPlaceEstimate, needsPlaceEstimate } from "./place";
import { isWeakDate } from "@/lib/photos/date-from-neighbours";

export type ApplyResult = { ok: true } | { ok: false; reason: "refusal" | "invalid" | "max_tokens" };

/** Persist a parsed record on the item and keep the raw response briefly for debugging. Never logs content. */
export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

export async function applyAnnotation(photoId: string, model: string, parsed: Annotation, raw: { usage?: Usage; batched?: boolean } & Record<string, unknown>): Promise<void> {
  const current = await db.photo.findUnique({ where: { id: photoId }, select: { takenAt: true, takenAtSource: true, estimatedDateSource: true, annotationSource: true, title: true, kind: true, lat: true, placeEstimatedAt: true } });
  if (!current) return;
  const stored = toStored(parsed);
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
        // A member's edits are never overwritten silently: re-annotation only refreshes machine text.
        annotationSource: current.annotationSource === "EDITED" ? "EDITED" : "MACHINE",
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

import { db } from "@/lib/db";
import { annotationSchema, toStored, type Annotation } from "./schema";

export type ApplyResult = { ok: true } | { ok: false; reason: "refusal" | "invalid" | "max_tokens" };

/** Persist a parsed record on the item and keep the raw response briefly for debugging. Never logs content. */
export async function applyAnnotation(photoId: string, model: string, parsed: Annotation, raw: unknown): Promise<void> {
  const current = await db.photo.findUnique({ where: { id: photoId }, select: { takenAt: true, takenAtSource: true, estimatedDateSource: true, annotationSource: true } });
  if (!current) return;
  const stored = toStored(parsed);
  const est = parsed.estimatedYear;
  const noReliableDate = !current.takenAt || current.takenAtSource === "FILE_MTIME" || current.takenAtSource === "UPLOAD_TIME";
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
        ...(est && noReliableDate && !keepMemberEstimate
          ? { estimatedDate: new Date(Date.UTC(Math.round((est.from + est.to) / 2), 6, 1)), estimatedDateConfidence: est.confidence, estimatedDateSource: "MODEL", estimatedDateNote: `${est.from}–${est.to}: ${est.evidence}` }
          : {}),
      },
    }),
    db.mediaAnnotationRaw.create({ data: { photoId, model, response: raw as object } }),
  ]);
}

/** Validate a message the way `messages.parse` would, for batch results that come back as plain messages. */
export function parseMessageContent(content: { type: string; text?: string }[]): Annotation | null {
  const text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  try {
    const result = annotationSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function recordFailure(photoId: string, reason: string): Promise<void> {
  await db.photo.update({ where: { id: photoId }, data: { annotationError: reason.slice(0, 80), annotatedAt: new Date() } }).catch(() => {});
}

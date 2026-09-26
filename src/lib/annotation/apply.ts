import { db } from "@/lib/db";
import { annotationSchema, clampAnnotation, toStored, type Annotation, type StoredAnnotation } from "./schema";
import { enqueueEmbedding } from "@/lib/jobs/handlers/embed-photo";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { applyPlaceEstimate, needsPlaceEstimate } from "./place";
import { isWeakDate } from "@/lib/photos/date-from-neighbours";
import { judgeHelperText, knownNames, mentionsAnyName, pastHelperTitles, titleIsHelpers } from "./members-only";
import { forgetState, unchangedSince } from "@/lib/people/names-changed";
import { withoutOptedOutNames } from "@/lib/people/unpermitted";
import { forgottenScope, loadTombstone, scrubRecord, type Tombstone } from "@/lib/people/tombstone";

export type ApplyResult = { ok: true } | { ok: false; reason: "refusal" | "invalid" | "max_tokens" };

/** Persist a parsed record on the item and keep the raw response briefly for debugging. Never logs content. */
export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

/**
 * Where the helper's title goes. A title of the family's own is never touched. The helper's goes on the item where
 * it has none, unless it is members-only, when it is kept in `membersTitle` for members to read instead; and on a
 * members-only item a title the helper put there before (see `titleIsHelpers`) comes off it too. What is in
 * `membersTitle` already is replaced only when it was the helper's last title.
 */
export function titlesAfter(
  current: { title: string | null; membersTitle: string | null; previousAiTitle: string | null; titleByHelper?: boolean | null; pastTitles?: string[]; namesSomebody?: boolean },
  aiTitle: string,
  membersOnly: boolean,
): { title: string | null; membersTitle: string | null; titleByHelper: boolean | null } {
  const held = current.membersTitle?.trim() || null;
  const helpers = !held || held === current.previousAiTitle?.trim();
  let membersTitle = helpers ? (membersOnly && aiTitle ? aiTitle : null) : held;
  let title = current.title;
  let titleByHelper = current.titleByHelper ?? null;
  if (membersOnly) {
    if (titleIsHelpers({ title, titleByHelper, aiTitle: current.previousAiTitle, pastTitles: current.pastTitles, namesSomebody: current.namesSomebody })) {
      membersTitle = membersTitle ?? title;
      title = null;
      titleByHelper = null;
    }
  } else if (!title?.trim() && !membersTitle && aiTitle) {
    title = aiTitle;
    titleByHelper = true;
  }
  return { title, membersTitle, titleByHelper };
}

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

/**
 * `sent` is whether the request that produced this answer carried anything members-only, as recorded when it was
 * built (see `requestCarriesMembersOnly`); null when that was not recorded.
 *
 * `requestedAt` is when the request was built (for a batch, when its run was started). An answer that comes back
 * after a forgotten person's name was scrubbed from the item, or after anybody on it was renamed, untagged or
 * changed their mind about being named, is not stored: it may name them again. Nothing is kept of it, not even the
 * raw row, and the item stays due to be described again with the names as they are now.
 */
export async function applyAnnotation(photoId: string, model: string, parsed: Annotation, raw: { usage?: Usage; batched?: boolean } & Record<string, unknown>, opts: { sent?: boolean | null; requestedAt?: Date; tombstone?: Tombstone; attempts?: number; replaceEdited?: boolean } = {}): Promise<void> {
  const requestedAt = opts.requestedAt;
  const current = await db.photo.findUnique({ where: { id: photoId }, select: { takenAt: true, takenAtSource: true, estimatedDateSource: true, annotationSource: true, title: true, membersTitle: true, titleByHelper: true, annotation: true, kind: true, lat: true, placeSetById: true, placeEstimatedAt: true, context: true } });
  if (!current) return;
  // Nobody forgotten comes back by way of a new answer, whoever it is about: their names are taken out first.
  const tombstone = opts.tombstone ?? (await loadTombstone());
  const scope = tombstone.empty ? undefined : await forgottenScope({ photoIds: [photoId] }, tombstone);
  // A member's edits are never overwritten by the notes sweep or the names backfill; only a member pressing
  // "Describe again" and agreeing to lose them replaces them.
  const edited = current.annotationSource === "EDITED" && !opts.replaceEdited;
  // Nor anybody opted out, or waiting to be forgotten, whose record is still there.
  const stored = await withoutOptedOutNames(scrubRecord(keepMemberText(toStored(parsed), current.annotation, edited), tombstone, scope), photoId);
  // Written from names or notes, it is the family's to read: kept off the item's own title and out of public view.
  const judgement = await judgeHelperText(photoId, stored, current.context, opts.sent);
  const membersOnly = judgement.membersOnly;
  const aiTitle = current.kind !== "EXTERNAL_VIDEO" ? stored.title.trim() : "";
  const previousAiTitle = (current.annotation as { title?: string } | null)?.title ?? null;
  // A title of unknown origin on an item going members-only: the helper's past answers and its words decide.
  const unknownTitle = membersOnly && current.title?.trim() && current.titleByHelper === null && current.title.trim() !== previousAiTitle?.trim();
  const titles = titlesAfter(
    {
      title: current.title,
      membersTitle: current.membersTitle,
      previousAiTitle,
      titleByHelper: current.titleByHelper,
      ...(unknownTitle ? { pastTitles: await pastHelperTitles(photoId), namesSomebody: mentionsAnyName(current.title!, await knownNames()) } : {}),
    },
    aiTitle,
    membersOnly,
  );
  const est = parsed.estimatedYear;
  const noReliableDate = isWeakDate(current.takenAtSource, current.takenAt);
  const keepMemberEstimate = current.estimatedDateSource === "MEMBER";
  // Stored only if nothing about who may be named on it changed since the request was built, checked in the write
  // itself; otherwise nothing of it is kept, the raw answer included.
  const stale = Symbol("stale");
  const reload = Symbol("reload");
  const kept = await db.$transaction(async (tx) => {
    const forget = await forgetState(tx, tombstone.loadedAt);
    if (forget.underWay) throw stale;
    // Somebody was forgotten since the forgotten names were read: read them again, and judge the answer afresh.
    if (forget.reload) throw reload;
    const written = await tx.photo.updateMany({
      where: { id: photoId, ...(requestedAt ? unchangedSince(requestedAt) : {}) },
      data: {
        annotation: stored,
        annotationModel: model,
        annotatedAt: new Date(),
        // Re-annotation only refreshes machine text, so an edited record stays the family's.
        annotationSource: edited ? "EDITED" : "MACHINE",
        annotationError: null,
        annotationMembersOnly: membersOnly,
        annotationTitleOnly: judgement.titleOnly,
        annotationTitleWords: judgement.titleOnly ? (judgement.titleWords ?? []) : [],
        annotationTitleFrom: judgement.titleOnly ? (judgement.titleFrom ?? []) : [],
        // New words: whatever a member chose to show was the old text, and this one is judged afresh.
        annotationSharedAt: null,
        // Embedded videos keep YouTube's title; see `titlesAfter` for everything else.
        title: titles.title,
        membersTitle: titles.membersTitle,
        titleByHelper: titles.titleByHelper,
        annotationInputTokens: raw.usage?.input_tokens ?? null,
        annotationCacheReadTokens: raw.usage?.cache_read_input_tokens ?? null,
        annotationCacheWriteTokens: raw.usage?.cache_creation_input_tokens ?? null,
        annotationOutputTokens: raw.usage?.output_tokens ?? null,
        annotationBatched: raw.batched ?? false,
        ...(est && noReliableDate && !keepMemberEstimate
          ? { estimatedDate: new Date(Date.UTC(Math.round((est.from + est.to) / 2), 6, 1)), estimatedDateConfidence: est.confidence, estimatedDateSource: "MODEL", estimatedDateNote: `${est.from}–${est.to}: ${tombstone.scrub(est.evidence, scope)}` }
          : {}),
      },
    });
    if (written.count === 0) throw stale;
    await tx.mediaAnnotationRaw.create({ data: { photoId, model, response: raw as object } });
    return true;
  }).catch((err: unknown) => {
    if (err === stale) return false;
    if (err === reload) return "reload" as const;
    throw err;
  });
  if (kept === "reload") {
    const attempts = opts.attempts ?? 0;
    if (attempts < 3) return applyAnnotation(photoId, model, parsed, raw, { ...opts, tombstone: await loadTombstone(), attempts: attempts + 1 });
  }
  if (kept !== true) {
    await recordFailure(photoId, "names_changed", { terminal: false });
    // Asked again once the change has settled, so no item is left undescribed for it.
    await enqueue(QUEUES.annotatePhoto, { photoId }, { singletonKey: `annotate:${photoId}`, singletonSeconds: 60, startAfter: 60 });
    return;
  }
  // The place guess is only ever recorded for an item that was actually asked, so clearing a position later still
  // leaves it eligible for the backfill.
  // Asked in the same request, so it was written from the same things.
  if (needsPlaceEstimate(current)) await applyPlaceEstimate(photoId, parsed.estimatedPlace, { sent: membersOnly || opts.sent, requestedAt, tombstone });
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

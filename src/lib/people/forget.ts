import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { isHelperTitle } from "@/lib/annotation/helper-text";
import { enqueueEmbedding } from "@/lib/jobs/handlers/embed-photo";
import { annotationMentions, nameMatcher, scrubAnnotation, type NameMatcher } from "./scrub";

/**
 * Taking a forgotten person's name out of what the helper wrote, and finding what members wrote that still says it.
 *
 * Only the helper's words are rewritten: its record on each item, the title it gave an item (while that is still
 * its title), the title it wrote for members, its date and place evidence, and the trip, collection and activity
 * descriptions it wrote. A member's caption, notes, title or description is theirs; it is listed for them (or an
 * admin) to edit instead, which is the only honest thing to do with somebody else's words.
 */

export type PersonNames = { id: string; name: string; formerNames?: string[] | null };

/** A matcher for everything this person has been called, judged against everybody else the album knows. */
export async function matcherFor(person: PersonNames): Promise<NameMatcher> {
  const [people, users] = await Promise.all([
    db.person.findMany({ where: { id: { not: person.id } }, select: { name: true, formerNames: true } }),
    db.user.findMany({ where: { name: { not: null } }, select: { name: true } }),
  ]);
  const others = [...people.flatMap((p) => [p.name, ...(p.formerNames ?? [])]), ...users.map((u) => u.name ?? "")];
  return nameMatcher([person.name, ...(person.formerNames ?? [])], others);
}

/** Long runs of letters from each spelling, for an ILIKE pre-filter that either apostrophe or spacing cannot defeat. */
function probes(m: NameMatcher): string[] {
  const runs = m.forms.map((f) => (f.normalize("NFC").match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).sort((a, b) => b.length - a.length)[0]).filter((r): r is string => Boolean(r));
  return [...new Set(runs)];
}

function likeAny(column: Prisma.Sql, words: string[]): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(words.map((w) => Prisma.sql`${column} ILIKE ${`%${w}%`}`), " OR ")})`;
}

type MachineText = { id: string; title: string | null; membersTitle: string | null; annotation: unknown; placeEstimateName: string | null; placeEstimateNote: string | null; estimatedDateNote: string | null };

/** Whether the helper's words on an item mention them. */
function machineMentions(p: MachineText, m: NameMatcher): boolean {
  return annotationMentions(p.annotation, m) || m.mentions(p.membersTitle) || (isHelperTitle(p.title, p.annotation) && m.mentions(p.title)) || [p.placeEstimateName, p.placeEstimateNote, p.estimatedDateNote].some((t) => m.mentions(t));
}

/**
 * Items whose machine-written text mentions them, wherever they are: a person untagged since, or confirmed on a
 * photograph the helper described from another's notes, is in that text all the same.
 */
export async function photosMentioning(m: NameMatcher): Promise<string[]> {
  const words = probes(m);
  if (!words.length) return [];
  const rows = await db.$queryRaw<MachineText[]>`
    SELECT id, title, "membersTitle", annotation, "placeEstimateName", "placeEstimateNote", "estimatedDateNote" FROM "Photo"
    WHERE ${likeAny(Prisma.sql`annotation::text`, words)} OR ${likeAny(Prisma.sql`"membersTitle"`, words)} OR ${likeAny(Prisma.sql`title`, words)}
       OR ${likeAny(Prisma.sql`"placeEstimateName"`, words)} OR ${likeAny(Prisma.sql`"placeEstimateNote"`, words)} OR ${likeAny(Prisma.sql`"estimatedDateNote"`, words)}`;
  return rows.filter((r) => machineMentions(r, m)).map((r) => r.id);
}

/**
 * Take the name out of the helper's words on these items (and, unless told otherwise, out of every description of
 * a trip, collection or activity the helper wrote).
 *
 * Each item is stamped `namesScrubbedAt`, so an answer to a request built before now is thrown away rather than
 * writing the name back. The keyword index is rebuilt by the item's own trigger on the write; the semantic one is
 * emptied at once and queued to be recomputed, so neither carries the name meanwhile. The helper's raw answers,
 * kept briefly for debugging, go too: they are the name as it was first written. Safe to run again.
 */
export async function forgetNameInText(photoIds: string[], m: NameMatcher, opts: { containers?: boolean } = {}): Promise<void> {
  const ids = [...new Set(photoIds)];
  if (ids.length) {
    const photos = await db.photo.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, membersTitle: true, annotation: true, placeEstimateName: true, placeEstimateNote: true, estimatedDateNote: true } });
    const now = new Date();
    for (const p of photos) {
      const a = p.annotation && typeof p.annotation === "object" && !Array.isArray(p.annotation) ? (p.annotation as StoredAnnotation) : null;
      await db.photo.update({
        where: { id: p.id },
        data: {
          ...(a ? { annotation: scrubAnnotation(a, m) } : {}),
          // The title is only rewritten while it is still the one the helper gave; a member's own title is theirs.
          ...(isHelperTitle(p.title, p.annotation) ? { title: m.scrub(p.title) } : {}),
          membersTitle: m.scrub(p.membersTitle),
          placeEstimateName: m.scrub(p.placeEstimateName),
          placeEstimateNote: m.scrub(p.placeEstimateNote),
          estimatedDateNote: m.scrub(p.estimatedDateNote),
          namesScrubbedAt: now,
        },
      });
    }
    const found = photos.map((p) => p.id);
    if (found.length) {
      await db.$executeRaw`UPDATE "Photo" SET "textEmbedding" = NULL WHERE id IN (${Prisma.join(found)})`;
      await db.mediaAnnotationRaw.deleteMany({ where: { photoId: { in: found } } });
      for (const id of found) await enqueueEmbedding(id, true);
    }
  }
  if (opts.containers === false) return;
  const words = probes(m);
  if (!words.length) return;
  const byHelper = { descriptionByHelper: true, OR: words.map((w) => ({ description: { contains: w, mode: "insensitive" as const } })) };
  const [trips, activities, collections] = await Promise.all([
    db.trip.findMany({ where: byHelper, select: { id: true, description: true } }),
    db.activity.findMany({ where: byHelper, select: { id: true, description: true } }),
    db.collection.findMany({ where: byHelper, select: { id: true, description: true } }),
  ]);
  // Written back only where the name is really there, so nothing else about a trip looks changed.
  for (const t of trips) if (m.mentions(t.description)) await db.trip.update({ where: { id: t.id }, data: { description: m.scrub(t.description) } });
  for (const x of activities) if (m.mentions(x.description)) await db.activity.update({ where: { id: x.id }, data: { description: m.scrub(x.description) } });
  for (const c of collections) if (m.mentions(c.description)) await db.collection.update({ where: { id: c.id }, data: { description: m.scrub(c.description) } });
}

export type MemberText = {
  photos: { id: string; label: string; fields: ("title" | "caption" | "notes")[] }[];
  trips: { slug: string; title: string }[];
  collections: { slug: string; title: string }[];
  activities: { id: string; title: string; tripSlug: string }[];
};

/** How many of each are listed: enough to act on, not the whole album. */
const MEMBER_TEXT_LIMIT = 100;

/**
 * What members wrote that mentions them, which forgetting leaves alone: titles, captions and notes on photographs,
 * and descriptions of trips, collections and activities written by hand. Listed so their authors (or an admin)
 * can decide what to do with their own words.
 */
export async function memberTextMentioning(m: NameMatcher): Promise<MemberText> {
  const out: MemberText = { photos: [], trips: [], collections: [], activities: [] };
  const words = probes(m);
  if (!words.length) return out;
  const photos = await db.$queryRaw<{ id: string; title: string | null; caption: string | null; context: string | null; annotation: unknown; originalName: string }[]>`
    SELECT id, title, caption, context, annotation, "originalName" FROM "Photo"
    WHERE "trashedAt" IS NULL AND (${likeAny(Prisma.sql`title`, words)} OR ${likeAny(Prisma.sql`caption`, words)} OR ${likeAny(Prisma.sql`context`, words)})
    ORDER BY "createdAt" ASC`;
  for (const p of photos) {
    const fields: ("title" | "caption" | "notes")[] = [];
    if (!isHelperTitle(p.title, p.annotation) && m.mentions(p.title)) fields.push("title");
    if (m.mentions(p.caption)) fields.push("caption");
    if (m.mentions(p.context)) fields.push("notes");
    if (fields.length && out.photos.length < MEMBER_TEXT_LIMIT) out.photos.push({ id: p.id, label: p.title?.trim() || p.caption?.trim() || p.originalName, fields });
  }
  const byMember = { descriptionByHelper: false, OR: words.map((w) => ({ description: { contains: w, mode: "insensitive" as const } })) };
  const [trips, collections, activities] = await Promise.all([
    db.trip.findMany({ where: byMember, select: { slug: true, title: true, description: true }, orderBy: { startDate: "asc" } }),
    db.collection.findMany({ where: byMember, select: { slug: true, title: true, description: true }, orderBy: { title: "asc" } }),
    db.activity.findMany({ where: byMember, select: { id: true, title: true, description: true, trip: { select: { slug: true } } }, orderBy: { startTime: "asc" } }),
  ]);
  out.trips = trips.filter((t) => m.mentions(t.description)).slice(0, MEMBER_TEXT_LIMIT).map((t) => ({ slug: t.slug, title: t.title }));
  out.collections = collections.filter((c) => m.mentions(c.description)).slice(0, MEMBER_TEXT_LIMIT).map((c) => ({ slug: c.slug, title: c.title }));
  out.activities = activities.filter((a) => m.mentions(a.description)).slice(0, MEMBER_TEXT_LIMIT).map((a) => ({ id: a.id, title: a.title, tripSlug: a.trip.slug }));
  return out;
}

/**
 * Names an item's helper text should no longer carry: somebody taken off it, or somebody who may no longer be named.
 * Only that item is rewritten — a trip described from many photographs is not rewritten because one tag was wrong.
 */
export async function forgetOnPhoto(photoId: string, person: PersonNames): Promise<void> {
  const m = await matcherFor(person);
  const p = await db.photo.findUnique({ where: { id: photoId }, select: { id: true, title: true, membersTitle: true, annotation: true, placeEstimateName: true, placeEstimateNote: true, estimatedDateNote: true } });
  if (p && machineMentions(p, m)) await forgetNameInText([photoId], m, { containers: false });
}

/**
 * Take a person's name out of the helper's text wherever the album should not have used it: on the items they are
 * confirmed on or mentioned in, and in the descriptions the helper wrote. For somebody whose agreement to be named
 * was withdrawn, or was recorded without evidence they are an adult.
 */
export async function forgetNameEverywhere(person: PersonNames): Promise<void> {
  const m = await matcherFor(person);
  const [faces, animals] = await Promise.all([
    db.face.findMany({ where: { OR: [{ personId: person.id }, { proposedPersonId: person.id }] }, select: { photoId: true }, distinct: ["photoId"] }),
    db.animalDetection.findMany({ where: { OR: [{ personId: person.id }, { proposedPersonId: person.id }] }, select: { photoId: true }, distinct: ["photoId"] }),
  ]);
  const tagged = [...faces, ...animals].map((f) => f.photoId);
  await forgetNameInText([...tagged, ...(await photosMentioning(m))], m);
}

/** The nightly half of withdrawing a name: everybody flagged as named without evidence they are adults. */
export async function scrubPendingNames(): Promise<number> {
  const people = await db.person.findMany({ where: { namesPendingScrub: true }, select: { id: true, name: true, formerNames: true } });
  for (const p of people) {
    await forgetNameEverywhere(p);
    await db.person.update({ where: { id: p.id }, data: { namesPendingScrub: false } });
  }
  return people.length;
}

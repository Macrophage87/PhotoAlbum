import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { isHelperTitle } from "@/lib/annotation/helper-text";
import { enqueueEmbedding } from "@/lib/jobs/handlers/embed-photo";
import { annotationMentions, nameMatcher, scrubAnnotation, type NameMatcher, type Where } from "./scrub";

/**
 * Taking a forgotten person's name out of what the helper wrote, and finding what members wrote that still says it.
 *
 * Only the helper's words are rewritten: its record on each item (a record a member corrected included), the title
 * it gave an item while that is still the item's title, its date and place evidence, and the trip, collection and
 * activity descriptions it wrote. A member's caption, notes, title or description is theirs; it is listed for them
 * (or an admin) to edit instead, which is the only honest thing to do with somebody else's words.
 *
 * Where to look: the photographs the person is, or was, tagged on — where even a short name like "Grace" is her —
 * and, album-wide, only for a full name that could be nobody else's.
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

/** The photographs somebody is on, or was proposed for: where the helper was told their name, or might have been. */
export async function taggedPhotoIds(personId: string): Promise<Set<string>> {
  const who = { OR: [{ personId }, { proposedPersonId: personId }] };
  const [faces, animals] = await Promise.all([
    db.face.findMany({ where: who, select: { photoId: true }, distinct: ["photoId"] }),
    db.animalDetection.findMany({ where: who, select: { photoId: true }, distinct: ["photoId"] }),
  ]);
  return new Set([...faces, ...animals].map((f) => f.photoId));
}

/** Long runs of letters from each full name, for an ILIKE pre-filter; nothing under three letters, which finds everything. */
function probes(forms: string[]): string[] {
  const runs = forms.map((f) => (f.normalize("NFC").match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).sort((a, b) => b.length - a.length)[0] ?? "").filter((r) => [...r].length >= 3);
  return [...new Set(runs)];
}

function likeAny(column: Prisma.Sql, words: string[]): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(words.map((w) => Prisma.sql`${column} ILIKE ${`%${w}%`}`), " OR ")})`;
}

type MachineText = { id: string; title: string | null; membersTitle: string | null; titleByHelper: boolean; annotation: unknown; placeEstimateName: string | null; placeEstimateNote: string | null; estimatedDateNote: string | null };

/** Which of an item's two titles are the helper's words. */
function helpersTitles(p: Pick<MachineText, "title" | "membersTitle" | "titleByHelper" | "annotation">) {
  const hasOwn = Boolean(p.title?.trim());
  return { title: isHelperTitle(p.title, p.annotation, p.titleByHelper), membersTitle: isHelperTitle(p.membersTitle, p.annotation, p.titleByHelper && !hasOwn) };
}

/** Whether the helper's words on an item mention them. */
function machineMentions(p: MachineText, m: NameMatcher, where: Where): boolean {
  const h = helpersTitles(p);
  return annotationMentions(p.annotation, m, where) || (h.title && m.mentions(p.title, where)) || (h.membersTitle && m.mentions(p.membersTitle, where)) || [p.placeEstimateName, p.placeEstimateNote, p.estimatedDateNote].some((t) => m.mentions(t, where));
}

/**
 * Items, anywhere in the album, whose machine-written text mentions one of their full names: the helper may have
 * named them from the notes, or on a photograph they have since been untagged from. Short names are not looked for
 * here — "Grace" in somebody else's photograph is not her.
 */
export async function photosMentioning(m: NameMatcher): Promise<string[]> {
  const words = probes(m.albumForms);
  if (!words.length) return [];
  const rows = await db.$queryRaw<MachineText[]>`
    SELECT id, title, "membersTitle", "titleByHelper", annotation, "placeEstimateName", "placeEstimateNote", "estimatedDateNote" FROM "Photo"
    WHERE ${likeAny(Prisma.sql`annotation::text`, words)} OR ${likeAny(Prisma.sql`"membersTitle"`, words)} OR ${likeAny(Prisma.sql`title`, words)}
       OR ${likeAny(Prisma.sql`"placeEstimateName"`, words)} OR ${likeAny(Prisma.sql`"placeEstimateNote"`, words)} OR ${likeAny(Prisma.sql`"estimatedDateNote"`, words)}`;
  return rows.filter((r) => machineMentions(r, m, {})).map((r) => r.id);
}

/** Trips, activities and collections holding any of these photographs. */
async function containersOf(photoIds: string[]) {
  if (!photoIds.length) return { trips: [] as string[], activities: [] as string[], collections: [] as string[] };
  const photos = await db.photo.findMany({ where: { id: { in: photoIds } }, select: { tripId: true, activityId: true, collections: { select: { collectionId: true } } } });
  const some = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))];
  return { trips: some(photos.map((p) => p.tripId)), activities: some(photos.map((p) => p.activityId)), collections: some(photos.flatMap((p) => p.collections.map((c) => c.collectionId))) };
}

/**
 * Take the name out of the helper's words on these items (and, unless told otherwise, out of the trip, collection
 * and activity descriptions the helper wrote: those holding the person's own photographs, and anywhere else a full
 * name of theirs appears). `tagged` are the items they are, or were, on.
 *
 * Each item is stamped `namesScrubbedAt`, so an answer to a request built before now is thrown away rather than
 * writing the name back. The keyword index is rebuilt by the item's own trigger on the write; the semantic one is
 * emptied at once and queued to be recomputed, so neither carries the name meanwhile. The helper's raw answers,
 * kept briefly for debugging, go too: they are the name as it was first written. Safe to run again.
 */
export async function forgetNameInText(photoIds: string[], m: NameMatcher, opts: { tagged?: Set<string>; containers?: boolean } = {}): Promise<void> {
  const tagged = opts.tagged ?? new Set<string>();
  const ids = [...new Set(photoIds)];
  if (ids.length) {
    const photos = await db.photo.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, membersTitle: true, titleByHelper: true, annotation: true, placeEstimateName: true, placeEstimateNote: true, estimatedDateNote: true } });
    const now = new Date();
    for (const p of photos) {
      const where = { tagged: tagged.has(p.id) };
      const a = p.annotation && typeof p.annotation === "object" && !Array.isArray(p.annotation) ? (p.annotation as StoredAnnotation) : null;
      const h = helpersTitles(p);
      await db.photo.update({
        where: { id: p.id },
        data: {
          ...(a ? { annotation: scrubAnnotation(a, m, where) } : {}),
          // A title is only rewritten while it is the helper's; a member's own title is theirs.
          ...(h.title ? { title: m.scrub(p.title, where) } : {}),
          ...(h.membersTitle ? { membersTitle: m.scrub(p.membersTitle, where) } : {}),
          placeEstimateName: m.scrub(p.placeEstimateName, where),
          placeEstimateNote: m.scrub(p.placeEstimateNote, where),
          estimatedDateNote: m.scrub(p.estimatedDateNote, where),
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
  const near = await containersOf([...tagged]);
  const words = probes(m.albumForms);
  const byHelper = (ids: string[]) => ({ descriptionByHelper: true, OR: [{ id: { in: ids } }, ...words.map((w) => ({ description: { contains: w, mode: "insensitive" as const } }))] });
  const [trips, activities, collections] = await Promise.all([
    db.trip.findMany({ where: byHelper(near.trips), select: { id: true, description: true } }),
    db.activity.findMany({ where: byHelper(near.activities), select: { id: true, description: true } }),
    db.collection.findMany({ where: byHelper(near.collections), select: { id: true, description: true } }),
  ]);
  // Written back only where the name is really there, so nothing else about a trip looks changed. Short names count
  // only in descriptions of trips and the like that hold the person's own photographs.
  const at = (list: string[], id: string) => ({ tagged: list.includes(id) });
  for (const t of trips) if (m.mentions(t.description, at(near.trips, t.id))) await db.trip.update({ where: { id: t.id }, data: { description: m.scrub(t.description, at(near.trips, t.id)) } });
  for (const x of activities) if (m.mentions(x.description, at(near.activities, x.id))) await db.activity.update({ where: { id: x.id }, data: { description: m.scrub(x.description, at(near.activities, x.id)) } });
  for (const c of collections) if (m.mentions(c.description, at(near.collections, c.id))) await db.collection.update({ where: { id: c.id }, data: { description: m.scrub(c.description, at(near.collections, c.id)) } });
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
 * What forgetting leaves alone that mentions them: titles, captions and notes on photographs, and descriptions of
 * trips, collections and activities, written by members — or before the album kept track of who wrote them. Listed
 * so their authors (or an admin) can decide what to do with those words.
 */
export async function memberTextMentioning(m: NameMatcher, tagged: Set<string> = new Set()): Promise<MemberText> {
  const out: MemberText = { photos: [], trips: [], collections: [], activities: [] };
  const words = probes(m.albumForms);
  const taggedIds = [...tagged];
  const anywhere = words.length ? Prisma.sql`(${likeAny(Prisma.sql`title`, words)} OR ${likeAny(Prisma.sql`"membersTitle"`, words)} OR ${likeAny(Prisma.sql`caption`, words)} OR ${likeAny(Prisma.sql`context`, words)})` : Prisma.sql`false`;
  const theirs = taggedIds.length ? Prisma.sql`id IN (${Prisma.join(taggedIds)})` : Prisma.sql`false`;
  const photos = await db.$queryRaw<{ id: string; title: string | null; membersTitle: string | null; titleByHelper: boolean; caption: string | null; context: string | null; annotation: unknown; originalName: string }[]>`
    SELECT id, title, "membersTitle", "titleByHelper", caption, context, annotation, "originalName" FROM "Photo"
    WHERE "trashedAt" IS NULL AND (${anywhere} OR ${theirs})
    ORDER BY "createdAt" ASC`;
  for (const p of photos) {
    const where = { tagged: tagged.has(p.id) };
    const h = helpersTitles(p);
    const fields: ("title" | "caption" | "notes")[] = [];
    if ((!h.title && m.mentions(p.title, where)) || (!h.membersTitle && m.mentions(p.membersTitle, where))) fields.push("title");
    if (m.mentions(p.caption, where)) fields.push("caption");
    if (m.mentions(p.context, where)) fields.push("notes");
    if (fields.length && out.photos.length < MEMBER_TEXT_LIMIT) out.photos.push({ id: p.id, label: p.title?.trim() || p.caption?.trim() || p.originalName, fields });
  }
  const near = await containersOf(taggedIds);
  const byMember = (ids: string[]) => ({ descriptionByHelper: false, description: { not: null }, OR: [{ id: { in: ids } }, ...words.map((w) => ({ description: { contains: w, mode: "insensitive" as const } }))] });
  const [trips, collections, activities] = await Promise.all([
    db.trip.findMany({ where: byMember(near.trips), select: { id: true, slug: true, title: true, description: true }, orderBy: { startDate: "asc" } }),
    db.collection.findMany({ where: byMember(near.collections), select: { id: true, slug: true, title: true, description: true }, orderBy: { title: "asc" } }),
    db.activity.findMany({ where: byMember(near.activities), select: { id: true, title: true, description: true, trip: { select: { slug: true } } }, orderBy: { startTime: "asc" } }),
  ]);
  out.trips = trips.filter((t) => m.mentions(t.description, { tagged: near.trips.includes(t.id) })).slice(0, MEMBER_TEXT_LIMIT).map((t) => ({ slug: t.slug, title: t.title }));
  out.collections = collections.filter((c) => m.mentions(c.description, { tagged: near.collections.includes(c.id) })).slice(0, MEMBER_TEXT_LIMIT).map((c) => ({ slug: c.slug, title: c.title }));
  out.activities = activities.filter((a) => m.mentions(a.description, { tagged: near.activities.includes(a.id) })).slice(0, MEMBER_TEXT_LIMIT).map((a) => ({ id: a.id, title: a.title, tripSlug: a.trip.slug }));
  return out;
}

/**
 * Somebody taken off a photograph was named in what the helper wrote about it because they were on it: the name
 * goes from that one item's machine-written text. A trip described from many photographs is not rewritten because
 * one tag was wrong. The item is stamped either way, so an answer already on its way about it is not stored.
 */
export async function forgetOnPhoto(photoId: string, person: PersonNames): Promise<void> {
  const m = await matcherFor(person);
  const p = await db.photo.findUnique({ where: { id: photoId }, select: { id: true, title: true, membersTitle: true, titleByHelper: true, annotation: true, placeEstimateName: true, placeEstimateNote: true, estimatedDateNote: true } });
  if (!p) return;
  if (machineMentions(p, m, { tagged: true })) await forgetNameInText([photoId], m, { tagged: new Set([photoId]), containers: false });
  else await db.photo.update({ where: { id: photoId }, data: { namesScrubbedAt: new Date() } });
}

/**
 * Take a person's name out of the helper's text wherever the album should not have used it: on the items they are
 * (or were) on, on items naming them in full, and in the descriptions the helper wrote. For somebody whose agreement
 * to be named was withdrawn, or was recorded without evidence they are an adult.
 */
export async function forgetNameEverywhere(person: PersonNames): Promise<void> {
  const m = await matcherFor(person);
  const tagged = await taggedPhotoIds(person.id);
  await forgetNameInText([...tagged, ...(await photosMentioning(m))], m, { tagged });
}

/** How long a withdrawal nobody asked for waits for an admin to record evidence before the names are scrubbed. */
export const WITHDRAWN_GRACE_DAYS = 14;

/**
 * The nightly half of a naming the album switched off by itself (see Person.namingWithdrawnAt): once admins have had
 * their fortnight to record a birthday or an adult confirmation, the names go from the helper's text. Nothing was
 * sent meanwhile; this only decides what happens to what was already written.
 */
export async function scrubWithdrawnNames(now = new Date()): Promise<number> {
  const due = new Date(now.getTime() - WITHDRAWN_GRACE_DAYS * 86_400_000);
  const people = await db.person.findMany({ where: { namingWithdrawnAt: { lte: due } }, select: { id: true, name: true, formerNames: true } });
  for (const p of people) {
    await forgetNameEverywhere(p);
    await db.person.update({ where: { id: p.id }, data: { namingWithdrawnAt: null } });
  }
  return people.length;
}

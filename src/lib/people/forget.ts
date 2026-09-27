import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { helperTitle } from "@/lib/annotation/helper-text";
import { enqueueEmbedding } from "@/lib/jobs/handlers/embed-photo";
import { QUEUES } from "@/lib/jobs/queues";
import { bossJobs } from "@/lib/jobs/schema";
import { isMinor, knownAdult } from "./consent";
import { annotationMentions, nameMatcher, scrubAnnotation, type NameMatcher, type Where } from "./scrub";

/**
 * Taking a forgotten person's name out of what the helper wrote, and finding what members wrote that still says it.
 *
 * Only the helper's words are rewritten: its record on each item (a record a member corrected included), a title
 * it gave an item while that is still the item's title, its date and place evidence, and the trip, collection and
 * activity descriptions it wrote. A member's caption, notes, title or description is theirs; it is listed for them
 * (or an admin) to edit instead, which is the only honest thing to do with somebody else's words.
 *
 * Where to look: the photographs the person is, or was, tagged on — where even "Grace" is her, and every word of
 * her name counts in the helper's keywords — and, anywhere else, only for names that could be nobody else's. Date
 * and place evidence, and descriptions of whole trips, never use the names that are only hers on her own
 * photographs: "May" there is as likely the month.
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

/** The names of everybody else tagged on each of these photographs: their words there are theirs. */
async function othersOn(photoIds: string[], personId?: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!photoIds.length) return out;
  const row = { photoId: true, person: { select: { id: true, name: true } } } as const;
  const [faces, animals] = await Promise.all([
    db.face.findMany({ where: { photoId: { in: photoIds }, personId: { not: null } }, select: row }),
    db.animalDetection.findMany({ where: { photoId: { in: photoIds }, personId: { not: null } }, select: row }),
  ]);
  for (const r of [...faces, ...animals]) if (r.person && r.person.id !== personId) out.set(r.photoId, [...(out.get(r.photoId) ?? []), r.person.name]);
  return out;
}

/** Titles the helper gave these items in its kept answers: a title still on an item that it once gave is its own. */
async function answerTitles(photoIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!photoIds.length) return out;
  const rows = await db.mediaAnnotationRaw.findMany({ where: { photoId: { in: photoIds } }, select: { photoId: true, response: true } });
  for (const r of rows) {
    const content = (r.response as { content?: unknown } | null)?.content;
    // The answer's first text block (a thinking block may come before it).
    const text = Array.isArray(content) ? (content.find((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text") as { text?: unknown } | undefined)?.text : undefined;
    if (typeof text !== "string") continue;
    try {
      const t = helperTitle(JSON.parse(text));
      if (t) out.set(r.photoId, new Set([...(out.get(r.photoId) ?? []), t]));
    } catch {
      // Not the record that was asked for: it gave no title.
    }
  }
  return out;
}

/** Long runs of letters from each spelling, for an ILIKE pre-filter; nothing under three letters, which finds everything. */
function probes(forms: string[]): string[] {
  const runs = forms.map((f) => (f.normalize("NFC").match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).sort((a, b) => b.length - a.length)[0] ?? "").filter((r) => [...r].length >= 3);
  return [...new Set(runs)];
}

function likeAny(column: Prisma.Sql, words: string[]): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(words.map((w) => Prisma.sql`${column} ILIKE ${`%${w}%`}`), " OR ")})`;
}

type MachineText = { id: string; kind: string; title: string | null; membersTitle: string | null; titleByHelper: boolean | null; annotation: unknown; placeEstimateName: string | null; placeEstimateNote: string | null; estimatedDateNote: string | null };

/**
 * Which of an item's two titles are the helper's words: the title its record gives now, or one of its kept answers
 * gave; for the item's own title, also one recorded as the helper's (`titleByHelper` true). A title recorded as a
 * member's (false) is theirs whatever it says, and one from before the album kept track (null) counts as a member's
 * unless it is one of the helper's own titles: it is listed, never rewritten. An embedded video's own title is
 * YouTube's or a member's, never the helper's, whatever it was recorded as or matches.
 */
function helpersTitles(p: Pick<MachineText, "kind" | "title" | "membersTitle" | "titleByHelper" | "annotation">, given: Set<string> = new Set()) {
  const said = (t: string | null) => Boolean(t?.trim()) && (t!.trim() === helperTitle(p.annotation) || given.has(t!.trim()));
  const own = p.kind !== "EXTERNAL_VIDEO" && Boolean(p.title?.trim()) && p.titleByHelper !== false && (p.titleByHelper === true || said(p.title));
  return { title: own, membersTitle: said(p.membersTitle) };
}

/** Whether the helper's words on an item mention them. Evidence notes only by names that are nobody else's. */
function machineMentions(p: MachineText, m: NameMatcher, where: Where, given?: Set<string>): boolean {
  const h = helpersTitles(p, given);
  return annotationMentions(p.annotation, m, where) || (h.title && m.mentions(p.title, where)) || (h.membersTitle && m.mentions(p.membersTitle, where)) || [p.placeEstimateName, p.placeEstimateNote, p.estimatedDateNote].some((t) => m.mentions(t));
}

/**
 * Items, anywhere in the album, whose machine-written text mentions a name of theirs that could be nobody else's:
 * the helper may have named them from the notes, or on a photograph they have since been untagged from.
 */
export async function photosMentioning(m: NameMatcher): Promise<string[]> {
  const words = probes(m.albumForms);
  if (!words.length) return [];
  const rows = await db.$queryRaw<MachineText[]>`
    SELECT id, kind::text AS kind, title, "membersTitle", "titleByHelper", annotation, "placeEstimateName", "placeEstimateNote", "estimatedDateNote" FROM "Photo"
    WHERE ${likeAny(Prisma.sql`annotation::text`, words)} OR ${likeAny(Prisma.sql`"membersTitle"`, words)} OR ${likeAny(Prisma.sql`title`, words)}
       OR ${likeAny(Prisma.sql`"placeEstimateName"`, words)} OR ${likeAny(Prisma.sql`"placeEstimateNote"`, words)} OR ${likeAny(Prisma.sql`"estimatedDateNote"`, words)}`;
  const given = await answerTitles(rows.map((r) => r.id));
  return rows.filter((r) => machineMentions(r, m, {}, given.get(r.id))).map((r) => r.id);
}

/**
 * The helper's raw answers anywhere in the album that name them, deleted: they are its words as first written, kept
 * briefly for debugging, and one about a photograph the forget did not otherwise touch (a caption naming them on
 * somebody else's photograph, text since replaced) would keep the name in clear until it is purged. Matched as on
 * their own photographs, any word of their name in any case (tags come lower-cased), which errs towards deleting a
 * debugging copy.
 */
export async function forgetRawAnswers(m: NameMatcher): Promise<number> {
  const words = probes([...m.albumForms, ...m.tombstoneForms.filter((f) => !f.derived).map((f) => f.form)]);
  if (!words.length) return 0;
  const rows = await db.$queryRaw<{ id: string; text: string }[]>`SELECT id, response::text AS text FROM "MediaAnnotationRaw" WHERE ${likeAny(Prisma.sql`response::text`, words)}`;
  const ids = rows.filter((r) => m.mentions(r.text, { tagged: true }) || m.scrubKeywords(r.text, { tagged: true }) !== r.text).map((r) => r.id);
  if (ids.length) await db.mediaAnnotationRaw.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}

/** A file name's extension, kept when the rest goes: the track importer tells a file's kind by it. */
const extensionOf = (name: string) => (name.split(".").length > 1 ? (name.split(".").pop() ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) : "");

/**
 * The file names the queue keeps: a Google Photos import job carries each picked item's file name, and a track
 * import job the uploaded file's, for up to three weeks. Queued ones are rewritten to a name that says nothing (the
 * Picker job never reads it; the track importer only reads the extension, which stays), and finished ones, whose
 * output may repeat the name, are deleted. Never fails the forget: an unreadable queue is logged.
 */
export async function forgetQueuedFileNames(m: NameMatcher): Promise<number> {
  const words = probes([...m.albumForms, ...m.tombstoneForms.filter((f) => !f.derived && !f.capitalizedOnly).map((f) => f.form)]);
  if (!words.length) return 0;
  const loose = looseMatcher(m);
  let changed = 0;
  try {
    const jobs = await db.$queryRaw<{ id: string; name: string; state: string; data: Record<string, unknown> | null; output: unknown }[]>`
      SELECT id::text AS id, name, state::text AS state, data, output FROM ${bossJobs()}
      WHERE name = ANY(${[QUEUES.googlePickerImport, QUEUES.importTrack]}::text[])
        AND (${likeAny(Prisma.sql`data::text`, words)} OR ${likeAny(Prisma.sql`COALESCE(output::text, '')`, words)})`;
    for (const j of jobs) {
      if (!loose(JSON.stringify(j.data)) && !loose(JSON.stringify(j.output ?? null))) continue;
      if (["completed", "failed", "cancelled"].includes(j.state)) {
        changed += await db.$executeRaw`DELETE FROM ${bossJobs()} WHERE id = ${j.id}::uuid AND name = ${j.name}`;
        continue;
      }
      const data = { ...(j.data ?? {}) };
      if (j.name === QUEUES.importTrack && typeof data.originalName === "string" && loose(data.originalName)) {
        const ext = extensionOf(data.originalName);
        data.originalName = ext ? `track.${ext}` : "track";
      }
      if (j.name === QUEUES.googlePickerImport && data.items && typeof data.items === "object") {
        data.items = Object.fromEntries(
          Object.entries(data.items as Record<string, { filename?: unknown }>).map(([key, item]) => {
            if (!item || typeof item.filename !== "string" || !loose(item.filename)) return [key, item];
            const ext = extensionOf(item.filename);
            return [key, { ...item, filename: ext ? `${key}.${ext}` : key }];
          }),
        );
      }
      changed += await db.$executeRaw`UPDATE ${bossJobs()} SET data = ${JSON.stringify(data)}::jsonb WHERE id = ${j.id}::uuid AND name = ${j.name}`;
    }
  } catch (err) {
    console.error("[forget] could not clear file names from the queue", err instanceof Error ? err.message : err);
  }
  return changed;
}

/** Trips, activities and collections holding any of these photographs. */
async function containersOf(photoIds: string[]) {
  if (!photoIds.length) return { trips: [] as string[], activities: [] as string[], collections: [] as string[] };
  const photos = await db.photo.findMany({ where: { id: { in: photoIds } }, select: { tripId: true, activityId: true, collections: { select: { collectionId: true } } } });
  const some = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))];
  return { trips: some(photos.map((p) => p.tripId)), activities: some(photos.map((p) => p.activityId)), collections: some(photos.flatMap((p) => p.collections.map((c) => c.collectionId))) };
}

/**
 * What could name them in public that was not there at the last pass: text the helper wrote since, text a member has
 * shown to everyone since (which is not written again), and photographs they have been tagged on since, where even
 * their first name is theirs.
 */
function writtenSince(since: Date, personId?: string): Prisma.PhotoWhereInput {
  const tag = personId ? { some: { personId, confirmedAt: { gt: since } } } : null;
  return { OR: [{ annotatedAt: { gt: since } }, { annotationSharedAt: { gt: since } }, ...(tag ? [{ faces: tag }, { animals: tag }] : [])] };
}

export type ForgetScope = {
  /** The items they are, or were, on. */
  tagged?: Set<string>;
  /** The person being forgotten, so the others tagged beside them are known. */
  personId?: string;
  /** Also the trip, collection and activity descriptions the helper wrote (the default). */
  containers?: boolean;
  /**
   * Only what strangers can read: the item's own title, and the helper's text and descriptions that are not kept
   * for members. For a naming the album withdrew by itself, whose members-only text waits for admins.
   */
  publicOnly?: boolean;
  /** Only what the helper wrote after this (for the nightly public pass). */
  since?: Date | null;
};

/**
 * Take the name out of the helper's words on these items, and (unless told otherwise) out of the trip, collection
 * and activity descriptions the helper wrote that mention a name of theirs that could be nobody else's.
 *
 * Each item is stamped `namesScrubbedAt`, so an answer to a request built before now is thrown away rather than
 * writing the name back. The keyword index is rebuilt by the item's own trigger on the write; the semantic one is
 * emptied at once and queued to be recomputed, so neither carries the name meanwhile. The helper's raw answers,
 * kept briefly for debugging, go too: they are the name as it was first written. Safe to run again.
 */
export async function forgetNameInText(photoIds: string[], m: NameMatcher, opts: ForgetScope = {}): Promise<void> {
  const tagged = opts.tagged ?? new Set<string>();
  const ids = [...new Set(photoIds)];
  const touched: string[] = [];
  if (ids.length) {
    const [photos, others, given] = await Promise.all([
      db.photo.findMany({ where: { id: { in: ids }, ...(opts.since ? writtenSince(opts.since, opts.personId) : {}) }, select: { id: true, kind: true, title: true, membersTitle: true, titleByHelper: true, annotation: true, annotationMembersOnly: true, placeEstimateName: true, placeEstimateNote: true, placeEstimateMembersOnly: true, estimatedDateNote: true } }),
      othersOn(ids.filter((id) => tagged.has(id)), opts.personId),
      answerTitles(ids),
    ]);
    const now = new Date();
    for (const p of photos) {
      const where: Where = { tagged: tagged.has(p.id), others: others.get(p.id) ?? [] };
      const a = p.annotation && typeof p.annotation === "object" && !Array.isArray(p.annotation) ? (p.annotation as StoredAnnotation) : null;
      const h = helpersTitles(p, given.get(p.id));
      const helperText = !opts.publicOnly || !p.annotationMembersOnly;
      const evidence = !opts.publicOnly || !p.placeEstimateMembersOnly;
      const next = {
        ...(a && helperText ? { annotation: scrubAnnotation(a, m, where) } : {}),
        // A title is only rewritten while it is the helper's; a member's own title is theirs.
        ...(h.title ? { title: m.scrub(p.title, where) } : {}),
        ...(h.membersTitle && !opts.publicOnly ? { membersTitle: m.scrub(p.membersTitle, where) } : {}),
        // Evidence says "May 1990" as readily as "May at the lake": only names that could be nobody else's.
        ...(evidence ? { placeEstimateName: m.scrub(p.placeEstimateName), placeEstimateNote: m.scrub(p.placeEstimateNote), estimatedDateNote: m.scrub(p.estimatedDateNote) } : {}),
      };
      const changed = Object.entries(next).some(([k, v]) => JSON.stringify(v) !== JSON.stringify((p as Record<string, unknown>)[k]));
      if (changed) touched.push(p.id);
      // A forget stamps every photograph it looked at, so no answer about any of them is written over it; the
      // withdrawal's public pass writes (and stamps) only what it changed.
      if (changed || !opts.publicOnly) await db.photo.update({ where: { id: p.id }, data: { ...next, namesScrubbedAt: now } });
    }
    const found = opts.publicOnly ? touched : photos.map((p) => p.id);
    if (found.length) {
      await db.$executeRaw`UPDATE "Photo" SET "textEmbedding" = NULL WHERE id IN (${Prisma.join(found)})`;
      if (!opts.publicOnly) await db.mediaAnnotationRaw.deleteMany({ where: { photoId: { in: found } } });
      for (const id of found) await enqueueEmbedding(id, true);
    }
  }
  if (opts.containers === false) return;
  // Descriptions of whole trips are written from many photographs, and say "in May" of the month: only names that
  // could be nobody else's are taken out of them. What is left naming them is listed (see memberTextMentioning).
  const near = await containersOf([...tagged]);
  const words = probes(m.albumForms);
  const byHelper = (ids: string[]) => ({ descriptionByHelper: true, ...(opts.publicOnly ? { descriptionMembersOnly: false } : {}), ...(opts.since ? { updatedAt: { gt: opts.since } } : {}), OR: [{ id: { in: ids } }, ...words.map((w) => ({ description: { contains: w, mode: "insensitive" as const } }))] });
  const [trips, activities, collections] = await Promise.all([
    db.trip.findMany({ where: byHelper(near.trips), select: { id: true, description: true } }),
    db.activity.findMany({ where: byHelper(near.activities), select: { id: true, description: true } }),
    db.collection.findMany({ where: byHelper(near.collections), select: { id: true, description: true } }),
  ]);
  for (const t of trips) if (m.mentions(t.description)) await db.trip.update({ where: { id: t.id }, data: { description: m.scrub(t.description) } });
  for (const x of activities) if (m.mentions(x.description)) await db.activity.update({ where: { id: x.id }, data: { description: m.scrub(x.description) } });
  for (const c of collections) if (m.mentions(c.description)) await db.collection.update({ where: { id: c.id }, data: { description: m.scrub(c.description) } });
}

export type MemberTextField = "title" | "caption" | "notes" | "place" | "file name" | "trash note" | "link note";
export type ContainerTextField = "title" | "description" | "web address";
export type PersonTextField = "relationship" | "descriptors" | "former names";
export type TrackTextField = "name" | "file name";
export type MemberText = {
  photos: { id: string; label: string; fields: MemberTextField[]; trashed?: boolean }[];
  trips: { id: string; slug: string; title: string; fields: ContainerTextField[] }[];
  collections: { id: string; slug: string; title: string; fields: ContainerTextField[] }[];
  activities: { id: string; title: string; tripSlug: string }[];
  /** Other people's records: what a member typed about them. */
  people: { id: string; label: string; fields: PersonTextField[] }[];
  tracks: { id: string; label: string; href: string; fields: TrackTextField[] }[];
  /** Takeout imports whose report lists a file or album by the name (admins'). */
  imports: { id: string; label: string }[];
};

/**
 * What a forget's leftover list keeps: ids and which fields, never words, so nothing stored is the name — trips and
 * collections by id too, since a web address may be it.
 */
export type LeftoverItems = {
  photos: { id: string; fields: MemberTextField[] }[];
  trips: { id?: string; slug?: string; fields?: ContainerTextField[] }[];
  collections: { id?: string; slug?: string; fields?: ContainerTextField[] }[];
  activities: { id: string }[];
  people: { id: string; fields: PersonTextField[] }[];
  tracks: { id: string; fields: TrackTextField[] }[];
  imports: { id: string }[];
};

/** The list as kept (see `LeftoverItems`). */
export function leftoverItems(t: MemberText): LeftoverItems {
  return {
    photos: t.photos.map((p) => ({ id: p.id, fields: p.fields })),
    trips: t.trips.map((x) => ({ id: x.id, fields: x.fields })),
    collections: t.collections.map((x) => ({ id: x.id, fields: x.fields })),
    activities: t.activities.map((x) => ({ id: x.id })),
    people: t.people.map((x) => ({ id: x.id, fields: x.fields })),
    tracks: t.tracks.map((x) => ({ id: x.id, fields: x.fields })),
    imports: t.imports.map((x) => ({ id: x.id })),
  };
}

/** Everything listed, counted. */
export function memberTextCount(t: MemberText): number {
  return t.photos.length + t.trips.length + t.collections.length + t.activities.length + t.people.length + t.tracks.length + t.imports.length;
}

/** How many of each are listed: enough to act on, not the whole album. */
const MEMBER_TEXT_LIMIT = 100;

/** Letters and digits only, lower-cased and hyphen-joined, the way a web address or a file name spells a name. */
function hyphenated(text: string): string {
  return `-${text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")}-`;
}

/**
 * Whether text a member typed without thinking of it as prose names them: a file name ("zebulon_quince_80.jpg"), a
 * web address, a note. By the rules for prose, or by one of their full names spelled out in any case — never by a
 * first name alone, or a one-word name that is also a word.
 */
function looseMatcher(m: NameMatcher): (text: string | null | undefined) => boolean {
  const names = [...new Set([...m.albumForms, ...m.tombstoneForms.filter((f) => !f.derived && !f.capitalizedOnly).map((f) => f.form)])];
  const forms = names.map(hyphenated).filter((f) => f.length > 4);
  // A full name run together ("zebulonquince", "ZebulonQuince80"): only names of more than one word, whose joined
  // spelling is no everyday word.
  const joined = names.map(hyphenated).filter((f) => f.slice(1, -1).includes("-")).map((f) => f.replace(/-/g, "")).filter((f) => f.length >= 8);
  return (text) => {
    if (!text?.trim()) return false;
    if (m.mentions(text)) return true;
    const h = hyphenated(text);
    return forms.some((f) => h.includes(f)) || joined.some((f) => h.replace(/-/g, "").includes(f));
  };
}

/**
 * What forgetting leaves that mentions them: titles, captions and notes on photographs, and descriptions of trips,
 * collections and activities, written by members — or before the album kept track of who wrote them — and the
 * helper's descriptions of trips around their photographs where only a name that is also a word ("May") is left.
 * And what else members typed that can hold a name: a photograph's file name, a note on why it is in the trash or
 * how it is linked to another, a trip's or collection's web address (made from its first title, and not changed
 * with it), other people's relationship, descriptors and former names, a track's name and file, and a Takeout
 * import's report. Listed so their authors (or an admin) can decide what to do with those words.
 */
export async function memberTextMentioning(m: NameMatcher, tagged: Set<string> = new Set(), personId?: string, limit = MEMBER_TEXT_LIMIT): Promise<MemberText> {
  const out: MemberText = { photos: [], trips: [], collections: [], activities: [], people: [], tracks: [], imports: [] };
  const words = probes(m.albumForms);
  const loose = looseMatcher(m);
  // For what is spelled without capitals or spaces: the long runs of every full name.
  const anyCase = probes([...m.albumForms, ...m.tombstoneForms.filter((f) => !f.derived && !f.capitalizedOnly).map((f) => f.form)]);
  const taggedIds = [...tagged];
  const linked = anyCase.length ? await db.photoLink.findMany({ where: { OR: anyCase.map((w) => ({ note: { contains: w, mode: "insensitive" as const } })) }, select: { photoAId: true, note: true } }) : [];
  const linkNotes = new Map<string, string[]>();
  for (const l of linked) linkNotes.set(l.photoAId, [...(linkNotes.get(l.photoAId) ?? []), l.note ?? ""]);
  const anywhere = words.length ? Prisma.sql`(${likeAny(Prisma.sql`title`, words)} OR ${likeAny(Prisma.sql`"membersTitle"`, words)} OR ${likeAny(Prisma.sql`caption`, words)} OR ${likeAny(Prisma.sql`context`, words)})` : Prisma.sql`false`;
  const typed = anyCase.length ? Prisma.sql`(${likeAny(Prisma.sql`"originalName"`, anyCase)} OR ${likeAny(Prisma.sql`"trashNote"`, anyCase)} OR ${likeAny(Prisma.sql`"placeName"`, anyCase)})` : Prisma.sql`false`;
  const theirs = taggedIds.length ? Prisma.sql`id IN (${Prisma.join(taggedIds)})` : Prisma.sql`false`;
  const links = linkNotes.size ? Prisma.sql`id IN (${Prisma.join([...linkNotes.keys()])})` : Prisma.sql`false`;
  const photos = await db.$queryRaw<{ id: string; kind: string; title: string | null; membersTitle: string | null; titleByHelper: boolean | null; caption: string | null; context: string | null; annotation: unknown; originalName: string; trashNote: string | null; trashedAt: Date | null; placeName: string | null }[]>`
    SELECT id, kind::text AS kind, title, "membersTitle", "titleByHelper", caption, context, annotation, "originalName", "trashNote", "trashedAt", "placeName" FROM "Photo"
    WHERE ("trashedAt" IS NULL AND (${anywhere} OR ${theirs})) OR ${typed} OR ${links}
    ORDER BY "createdAt" ASC`;
  const [others, given] = await Promise.all([othersOn(taggedIds, personId), answerTitles(photos.map((p) => p.id))]);
  for (const p of photos) {
    const where: Where = { tagged: tagged.has(p.id), others: others.get(p.id) ?? [] };
    const h = helpersTitles(p, given.get(p.id));
    const fields: MemberTextField[] = [];
    // A photograph in the trash is listed for what only it still carries, its file name and the note on why.
    if (!p.trashedAt) {
      if ((!h.title && m.mentions(p.title, where)) || (!h.membersTitle && m.mentions(p.membersTitle, where))) fields.push("title");
      if (m.mentions(p.caption, where)) fields.push("caption");
      if (m.mentions(p.context, where)) fields.push("notes");
      // The place's name, from the address lookup or a guess a member accepted ("Zebulon Quince's cabin"): shown
      // with the photograph and searched by it, and changed by setting the place again.
      if (m.mentions(p.placeName, where) || loose(p.placeName)) fields.push("place");
    }
    if (loose(p.originalName)) fields.push("file name");
    if (loose(p.trashNote)) fields.push("trash note");
    if ((linkNotes.get(p.id) ?? []).some(loose)) fields.push("link note");
    if (fields.length && out.photos.length < limit) out.photos.push({ id: p.id, label: p.title?.trim() || p.caption?.trim() || p.originalName, fields, ...(p.trashedAt ? { trashed: true } : {}) });
  }
  const near = await containersOf(taggedIds);
  // Around their photographs anybody's words count, the helper's too; elsewhere only members' — and a trip's,
  // collection's or activity's title is always a member's. A web address is looked for by any case.
  const contains = (field: "title" | "description") => words.map((w) => ({ [field]: { contains: w, mode: "insensitive" as const } }));
  const slugs = anyCase.map((w) => ({ slug: { contains: hyphenated(w).slice(1, -1) } }));
  const found = (ids: string[]) => ({ OR: [{ id: { in: ids } }, { descriptionByHelper: false, OR: contains("description") }, ...(words.length ? [{ OR: contains("title") }] : [])] });
  const foundOrAddressed = (ids: string[]) => ({ OR: [...found(ids).OR, ...slugs] });
  const [trips, collections, activities] = await Promise.all([
    db.trip.findMany({ where: foundOrAddressed(near.trips), select: { id: true, slug: true, title: true, description: true }, orderBy: { startDate: "asc" } }),
    db.collection.findMany({ where: foundOrAddressed(near.collections), select: { id: true, slug: true, title: true, description: true }, orderBy: { title: "asc" } }),
    db.activity.findMany({ where: found(near.activities), select: { id: true, title: true, description: true, trip: { select: { slug: true } } }, orderBy: { startTime: "asc" } }),
  ]);
  const containerFields = (x: { title: string; description: string | null; slug?: string }, tagged: boolean): ContainerTextField[] => [
    ...(m.mentions(x.title, { tagged }) ? ["title" as const] : []),
    ...(m.mentions(x.description, { tagged }) ? ["description" as const] : []),
    ...(x.slug !== undefined && loose(x.slug) ? ["web address" as const] : []),
  ];
  out.trips = trips.map((t) => ({ id: t.id, slug: t.slug, title: t.title, fields: containerFields(t, near.trips.includes(t.id)) })).filter((t) => t.fields.length).slice(0, limit);
  out.collections = collections.map((c) => ({ id: c.id, slug: c.slug, title: c.title, fields: containerFields(c, near.collections.includes(c.id)) })).filter((c) => c.fields.length).slice(0, limit);
  out.activities = activities.filter((a) => containerFields(a, near.activities.includes(a.id)).length).slice(0, limit).map((a) => ({ id: a.id, title: a.title, tripSlug: a.trip.slug }));

  // Other people: few enough to read every one.
  const people = await db.person.findMany({ where: { ...(personId ? { id: { not: personId } } : {}), OR: [{ relationship: { not: null } }, { descriptors: { not: null } }, { formerNames: { isEmpty: false } }] }, select: { id: true, name: true, relationship: true, descriptors: true, formerNames: true }, orderBy: { name: "asc" } });
  for (const x of people) {
    const fields: PersonTextField[] = [...(loose(x.relationship) ? ["relationship" as const] : []), ...(loose(x.descriptors) ? ["descriptors" as const] : []), ...(x.formerNames.some(loose) ? ["former names" as const] : [])];
    if (fields.length && out.people.length < limit) out.people.push({ id: x.id, label: x.name, fields });
  }
  if (anyCase.length) {
    const tracks = await db.track.findMany({
      where: { OR: anyCase.flatMap((w) => [{ name: { contains: w, mode: "insensitive" as const } }, { originalFile: { contains: w, mode: "insensitive" as const } }]) },
      select: { id: true, name: true, originalFile: true, trip: { select: { slug: true } }, activity: { select: { id: true } } },
      orderBy: { startTime: "asc" },
    });
    for (const t of tracks) {
      const fields: TrackTextField[] = [...(loose(t.name) ? ["name" as const] : []), ...(loose(t.originalFile) ? ["file name" as const] : [])];
      if (fields.length && out.tracks.length < limit) out.tracks.push({ id: t.id, label: t.name, href: t.activity ? `/trips/${t.trip.slug}/activities/${t.activity.id}` : `/trips/${t.trip.slug}`, fields });
    }
    const imports = await db.$queryRaw<{ id: string; report: string; archiveName: string }[]>`
      SELECT id, COALESCE(report::text, '') AS report, "archiveName" FROM "TakeoutImport" WHERE ${likeAny(Prisma.sql`COALESCE(report::text, '')`, anyCase)} OR ${likeAny(Prisma.sql`"archiveName"`, anyCase)} ORDER BY "startedAt" ASC`;
    // The archive's own name too, which is the file the admin put in the inbox.
    out.imports = imports.filter((i) => loose(i.report) || loose(i.archiveName)).slice(0, limit).map((i) => ({ id: i.id, label: i.archiveName }));
  }
  return out;
}

/**
 * The photographs in trips, collections and activities whose members' words name them: those words go to the helper
 * with every photograph there, so what it wrote about any of them may name them.
 */
export async function photosInContainers(t: Pick<MemberText, "trips" | "collections" | "activities">): Promise<string[]> {
  const trips = t.trips.map((x) => x.id);
  const collections = t.collections.map((x) => x.id);
  const activities = t.activities.map((x) => x.id);
  if (!trips.length && !collections.length && !activities.length) return [];
  const rows = await db.photo.findMany({ where: { OR: [{ tripId: { in: trips } }, { activityId: { in: activities } }, { collections: { some: { collectionId: { in: collections } } } }] }, select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * Somebody taken off a photograph was named in what the helper wrote about it because they were on it: the name
 * goes from that one item's machine-written text. A trip described from many photographs is not rewritten because
 * one tag was wrong. The item is stamped either way, so an answer already on its way about it is not stored.
 */
export async function forgetOnPhoto(photoId: string, person: PersonNames): Promise<void> {
  const m = await matcherFor(person);
  const p = await db.photo.findUnique({ where: { id: photoId }, select: { id: true, kind: true, title: true, membersTitle: true, titleByHelper: true, annotation: true, placeEstimateName: true, placeEstimateNote: true, estimatedDateNote: true } });
  if (!p) return;
  const others = (await othersOn([photoId], person.id)).get(photoId) ?? [];
  if (machineMentions(p, m, { tagged: true, others }, (await answerTitles([photoId])).get(photoId))) await forgetNameInText([photoId], m, { tagged: new Set([photoId]), personId: person.id, containers: false });
  else await db.photo.update({ where: { id: photoId }, data: { namesScrubbedAt: new Date() } });
}

/**
 * Take a person's name out of the helper's text wherever the album should not have used it: on the items they are
 * (or were) on, on items naming them by a name nobody else has, and in the descriptions the helper wrote. For
 * somebody whose agreement to be named was withdrawn, or was recorded without evidence they are an adult.
 */
export async function forgetNameEverywhere(person: PersonNames, opts: { publicOnly?: boolean; since?: Date | null } = {}): Promise<void> {
  const m = await matcherFor(person);
  const tagged = await taggedPhotoIds(person.id);
  await forgetNameInText([...tagged, ...(await photosMentioning(m))], m, { tagged, personId: person.id, publicOnly: opts.publicOnly, since: opts.since });
}

/**
 * The helper's text on an item, and its title, without the name of anybody whose naming the album withdrew by itself:
 * for text a member is about to show to everyone, which the nightly public pass would otherwise not reach for days.
 */
export async function withoutWithdrawnNames(photoId: string, text: { annotation: unknown; title: string | null }): Promise<{ annotation: unknown; title: string | null; changed: boolean }> {
  const people = await db.person.findMany({ where: { namingWithdrawnAt: { not: null } }, select: { id: true, name: true, formerNames: true } });
  let annotation = text.annotation;
  let title = text.title;
  if (!people.length) return { annotation, title, changed: false };
  const tagged = await db.face.findMany({ where: { photoId, OR: [{ personId: { in: people.map((p) => p.id) } }, { proposedPersonId: { in: people.map((p) => p.id) } }] }, select: { personId: true, proposedPersonId: true } });
  const on = new Set(tagged.flatMap((f) => [f.personId, f.proposedPersonId]));
  for (const p of people) {
    const m = await matcherFor(p);
    const where: Where = { tagged: on.has(p.id), others: on.has(p.id) ? ((await othersOn([photoId], p.id)).get(photoId) ?? []) : [] };
    if (annotation && typeof annotation === "object" && !Array.isArray(annotation)) annotation = scrubAnnotation(annotation as StoredAnnotation, m, where);
    title = m.scrub(title, where);
  }
  return { annotation, title, changed: JSON.stringify(annotation) !== JSON.stringify(text.annotation) || title !== text.title };
}

/** How long a withdrawal nobody asked for waits for an admin to record evidence before members-only text is scrubbed. */
export const WITHDRAWN_GRACE_DAYS = 14;

/**
 * The nightly half of a naming the album switched off by itself (see Person.namingWithdrawnAt). What strangers can
 * read is scrubbed at once — every night until then, so nothing written meanwhile keeps it either. What only members
 * read waits for admins' fortnight to record a birthday or an adult confirmation, and is then scrubbed too. Nothing
 * was sent to the helper meanwhile.
 */
export async function scrubWithdrawnNames(now = new Date()): Promise<number> {
  const due = new Date(now.getTime() - WITHDRAWN_GRACE_DAYS * 86_400_000);
  const people = await db.person.findMany({ where: { namingWithdrawnAt: { not: null } }, select: { id: true, name: true, formerNames: true, namingWithdrawnAt: true, namingPublicScrubbedAt: true } });
  let done = 0;
  for (const p of people) {
    if (p.namingWithdrawnAt! <= due) {
      await forgetNameEverywhere(p);
      await db.person.update({ where: { id: p.id }, data: { namingWithdrawnAt: null, namingPublicScrubbedAt: null } });
      done += 1;
    } else {
      // The whole album the first time; after that only what the helper has written since.
      const at = new Date();
      await forgetNameEverywhere(p, { publicOnly: true, since: p.namingPublicScrubbedAt });
      await db.person.update({ where: { id: p.id }, data: { namingPublicScrubbedAt: at } });
    }
  }
  return done;
}

export type WithdrawalReason = "minor" | "no-evidence" | "turned-off";

/** Why the album stopped using somebody's name by itself, for saying so honestly. */
export function withdrawalReason(p: { birthday: Date | null; adultAttestedAt: Date | null; adultConfirmedAt?: Date | null }, now = new Date()): WithdrawalReason {
  if (p.birthday && isMinor(p, now)) return "minor";
  return knownAdult(p, now) ? "turned-off" : "no-evidence";
}

/** What to tell admins about a naming the album withdrew by itself, and what they can do. */
export function withdrawalNotice(name: string, reason: WithdrawalReason, on: Date): string {
  const when = on.toLocaleDateString("en-US");
  if (reason === "minor") return `${name}'s birthday shows they are under 18, so the album no longer uses their name. It will be taken out of descriptions already written on ${when}.`;
  if (reason === "turned-off") return `Using ${name}'s name was turned off before; their name will be taken out of old descriptions on ${when}.`;
  return `The album can't be sure ${name} is over 18, so it stopped using their name. To keep it, record a birthday or adult confirmation and turn their name back on; otherwise it is taken out of descriptions already written on ${when}. Naming stays off until an admin turns it on.`;
}

/** When a withdrawal's members-only scrub is due. */
export function withdrawalDue(at: Date): Date {
  return new Date(at.getTime() + WITHDRAWN_GRACE_DAYS * 86_400_000);
}

import { db } from "@/lib/db";
import type { StoredAnnotation } from "./schema";
import { mentionsAnyName, mentionsAnyTitle, nameMatcher, namePatterns, titleWordsIn, type NamePattern } from "./names";
import { childOnly, namesSomebodyRestricted } from "@/lib/people/restricted";
import { relaxedWordHolds, strictFirstNames, strictNormalize } from "@/lib/people/strict-names";
import { nameCheckForPhoto, type NameCheck } from "@/lib/people/name-check";

export { foldForNames, mentionsAnyName, mentionsAnyTitle, NAME_PARTICLES, namePatterns } from "./names";

/**
 * Why a text is for members only. `titleOnly` when the one reason is a word from the title of a trip or collection
 * strangers cannot open: that reason goes away when the trip or collection is made public (see `rejudge.ts`), the
 * others never do.
 */
export type Judgement = {
  membersOnly: boolean;
  titleOnly: boolean;
  /** For a title-word flag: the words, and the trips and collections (`trip:<id>`, `collection:<id>`) they came from. */
  titleWords?: string[];
  titleFrom?: string[];
};

const judged = (hard: boolean, title: boolean): Judgement => ({ membersOnly: hard || title, titleOnly: !hard && title });

/** A private trip or collection an item is in, keyed as `trip:<id>` or `collection:<id>`. */
export type PrivateContainer = { key: string; title: string };

/** Which private containers' title words the text repeats, and which words. */
export function titleHits(text: string, containers: PrivateContainer[]): { words: string[]; from: string[] } {
  const words = new Set<string>();
  const from: string[] = [];
  for (const c of containers) {
    const hit = titleWordsIn(text, [c.title]);
    if (hit.length) {
      from.push(c.key);
      for (const w of hit) words.add(w);
    }
  }
  return { words: [...words], from };
}

/**
 * Whether the helper's text for an item is for members only.
 *
 * Strangers never read people's names, uploaders' names or the uploader's notes, and the helper is handed exactly
 * those — the names the family confirmed, so it will write "Ada and Ben on the porch", and the notes, which it is
 * told to trust. Asking it to leave them out again for strangers would be asking it to be careful, which is not the
 * same as being sure; so what it wrote from any of them is simply not shown or searchable outside the family.
 *
 * Judged from what it was given rather than what it happened to say: `sent` is what the request that produced it
 * carried (see `requestCarriesMembersOnly`), recorded when the request was built, so untagging somebody or clearing
 * the notes while a batch is out cannot make its answer public. Notes or anybody tagged now count as well, for
 * answers whose request was not recorded. Two things are judged from the words: a name the album knows turning up
 * anyway (see `names.ts`), and a word from the title of a trip or collection strangers cannot open (the helper is
 * given those titles too). The titles are checked by their words rather than flagged outright, because a trip is
 * usually private while it is being filled and made public afterwards.
 */
export async function judgeHelperText(photoId: string, text: Pick<StoredAnnotation, "title" | "caption" | "description" | "searchSummary" | "place" | "tags">, context: string | null, sent?: boolean | null): Promise<Judgement> {
  const said = helperText(text);
  // And anybody who may not be named, found strictly (any case, any spelling): "HAPPY BIRTHDAY ROSE" on a banner. Both
  // at the item's level (name-check.ts).
  const level = await nameCheckForPhoto(photoId);
  const texts = [text.title, text.caption, text.description, text.place];
  const lists = [text.searchSummary, ...(text.tags ?? [])];
  const hard = Boolean(sent || context?.trim()) || (await taggedOn(photoId)) || (await knownNamesLook(level))({ texts, lists, said }) || (await namesSomebodyRestricted(texts, lists, level));
  const hits = titleHits(said, await privateContainersOf(photoId));
  return { ...judged(hard, hits.from.length > 0), ...(hits.from.length ? { titleWords: hits.words, titleFrom: hits.from } : {}) };
}

/** `judgeHelperText`, as a yes or no. */
export async function writtenFromMembersOnly(photoId: string, text: Pick<StoredAnnotation, "title" | "caption" | "description" | "searchSummary" | "place" | "tags">, context: string | null, sent?: boolean | null): Promise<boolean> {
  return (await judgeHelperText(photoId, text, context, sent)).membersOnly;
}

/** Everything the helper wrote about a photograph that anybody could read. */
export function helperText(text: Partial<Pick<StoredAnnotation, "title" | "caption" | "description" | "searchSummary" | "place" | "tags">>): string {
  return [text.title, text.caption, text.description, text.searchSummary, text.place, ...(text.tags ?? [])].filter(Boolean).join("\n");
}

/**
 * The same judgement for the helper's guess at where an item was: its name and its evidence line are shown beside
 * the pin, and it is written from the same notes and titles. The coordinates themselves are the item's position,
 * which the album shows anybody who may see it.
 */
export async function placeFromMembersOnly(photoId: string, place: { name: string | null; evidence: string | null }, context: string | null, sent?: boolean | null): Promise<boolean> {
  if (sent || context?.trim()) return true;
  const said = [place.name, place.evidence].filter(Boolean).join("\n");
  const level = await nameCheckForPhoto(photoId);
  return (await knownNamesLook(level))({ texts: [said] }) || mentionsAnyTitle(said, await privateTitlesOf(photoId)) || (await namesSomebodyRestricted([said], [], level));
}

/**
 * What a request to the helper carries that only members may read: the uploader's notes, or confirmed names.
 * Recorded with the request (`annotationCustomId` for a batch) and handed back with its answer.
 */
export function requestCarriesMembersOnly(item: { context: string | null }, names: string[]): boolean {
  return Boolean(item.context?.trim()) || names.length > 0;
}

/**
 * A batch answer comes back with nothing but the id it was sent under, so what the request carried rides on that id:
 * `<photoId>-m` when it carried anything members-only. Ids are cuids, which have no hyphen.
 */
export function annotationCustomId(photoId: string, membersOnly: boolean): string {
  return membersOnly ? `${photoId}-m` : photoId;
}

/** The photograph an answer is for, and whether its request carried anything members-only (null: not recorded). */
export function parseAnnotationCustomId(customId: string): { photoId: string; sent: boolean | null } {
  const [photoId, mark] = customId.split("-");
  if (mark === undefined) return { photoId, sent: null };
  return { photoId, sent: mark === "m" ? true : null };
}

/**
 * The same judgement for a trip's, a collection's or an activity's description: the helper was handed names, the
 * notes on the photographs it was shown, the description it is replacing when that was members-only, or the title
 * of a trip strangers cannot open; or what it wrote names somebody the album knows. `level`: the container's
 * (name-check.ts), strict when not given.
 */
export async function judgeDescription(description: string, given: { names: string[]; notes: boolean; previous?: boolean; privateTitles?: string[]; level?: NameCheck }): Promise<Judgement> {
  const hard = Boolean(given.names.length || given.notes || given.previous) || (await knownNamesLook(given.level ?? "STRICT"))({ texts: [description] }) || (await namesSomebodyRestricted([description], [], given.level));
  const words = titleWordsIn(description, given.privateTitles ?? []);
  return { ...judged(hard, words.length > 0), ...(words.length ? { titleWords: words } : {}) };
}

/** `judgeDescription`, as a yes or no. */
export async function descriptionFromMembersOnly(description: string, given: { names: string[]; notes: boolean; previous?: boolean; privateTitles?: string[]; level?: NameCheck }): Promise<boolean> {
  return (await judgeDescription(description, given)).membersOnly;
}

/**
 * A description a member saved by hand. Once members-only it stays so until a member says otherwise (the
 * "show this to everyone" control), however it is edited; fresh words that name somebody the album knows start
 * members-only, the same rule the helper's text is held to.
 */
export async function handWrittenMembersOnly(before: { descriptionMembersOnly: boolean } | null, text: string | null | undefined): Promise<boolean> {
  if (before?.descriptionMembersOnly) return true;
  return Boolean(text?.trim()) && mentionsAnyName(text!, await knownNames());
}

type DescriptionBefore = { description: string | null; descriptionMembersOnly: boolean; descriptionSharedAt?: Date | null } | null;

/** The same words, give or take the line endings a textarea sends back and the spacing around them. */
export function sameDescription(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => (s ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  return norm(a) === norm(b);
}

/**
 * What a description saved by hand is stored with. Members-only stays members-only (`handWrittenMembersOnly`); one a
 * member chose to show to everyone stays shown while its words are the same; new words are judged afresh.
 */
export async function handWrittenDescription(before: DescriptionBefore, text: string | null | undefined): Promise<{ descriptionMembersOnly: boolean; descriptionSharedAt: Date | null; unchanged: boolean }> {
  const unchanged = Boolean(before) && sameDescription(before!.description, text);
  if (unchanged && before!.descriptionSharedAt && !before!.descriptionMembersOnly) return { descriptionMembersOnly: false, descriptionSharedAt: before!.descriptionSharedAt, unchanged };
  return { descriptionMembersOnly: await handWrittenMembersOnly(before, text), descriptionSharedAt: null, unchanged };
}

/**
 * A title as titles are compared: runs of whitespace as one space, none at either end. The members_only_text
 * migration compared with btrim, and a title typed with a double space or a trailing newline is the same title.
 */
export function titleKey(title: string | null | undefined): string {
  return (title ?? "").replace(/\s+/g, " ").trim();
}

/** Two titles that are the same words (see `titleKey`); an empty one is nobody's. */
export function sameTitle(a: string | null | undefined, b: string | null | undefined): boolean {
  const k = titleKey(a);
  return k !== "" && k === titleKey(b);
}

/**
 * Whether the title on an item is provably the helper's, so that a members-only item loses it. The album records
 * who wrote a title (`titleByHelper`); a title from before it did is the helper's when it is one the helper gave
 * (now or in a past answer still kept). A title the family typed since is never taken. One from before that cannot
 * be proved either way is `unknownTitleAside`'s to decide.
 */
export function titleIsHelpers(p: { title: string | null; titleByHelper: boolean | null; aiTitle: string | null; pastTitles?: string[] }): boolean {
  const own = titleKey(p.title);
  if (!own || p.titleByHelper === false) return false;
  if (p.titleByHelper === true || own === titleKey(p.aiTitle)) return true;
  return Boolean(p.pastTitles?.some((t) => titleKey(t) === own));
}

/**
 * A title from before the album recorded who wrote titles, on a members-only item, that is not provably the
 * helper's (see `titleIsHelpers`) but names somebody the album knows. It may be an old helper title whose answer has
 * since been purged, or a member's own words: strangers must not read it either way, and nothing a member wrote may
 * be lost. So it moves to `membersTitle` ("move") when that holds nothing or only the helper's current title, which
 * the helper's record still keeps; with anything else there it has nowhere to go, and it is left where it is for
 * somebody to look at ("stuck"). Null when the rule does not apply. Call only once `titleIsHelpers` said no.
 */
export function unknownTitleAside(p: { title: string | null; titleByHelper?: boolean | null; membersTitle: string | null; aiTitle: string | null; namesSomebody?: boolean }): "move" | "stuck" | null {
  if (p.titleByHelper != null || !titleKey(p.title) || !p.namesSomebody) return null;
  return !titleKey(p.membersTitle) || sameTitle(p.membersTitle, p.aiTitle) ? "move" : "stuck";
}

/** Said once per pass for a title `unknownTitleAside` had nowhere to put: which item, never the words. */
export function warnStuckTitle(photoId: string): void {
  console.warn(`[members-only] ${photoId}: a title of unknown origin names somebody, and its members' title is taken; left as it is`);
}

/** The titles in the helper's past answers for an item, from the raw responses still kept. */
export async function pastHelperTitles(photoId: string): Promise<string[]> {
  const raws = await db.mediaAnnotationRaw.findMany({ where: { photoId }, select: { response: true } });
  const titles: string[] = [];
  for (const r of raws) {
    const content = (r.response as { content?: { type?: string; text?: string }[] } | null)?.content;
    const text = Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("") : "";
    try {
      const title = (JSON.parse(text) as { title?: unknown }).title;
      // Cut where the stored title was cut (see clampAnnotation), so a long one still matches what went on the item.
      if (typeof title === "string" && titleKey(title.slice(0, 80))) titles.push(titleKey(title.slice(0, 80)));
    } catch {
      // Not a record: nothing to learn from it.
    }
  }
  return titles;
}

async function taggedOn(photoId: string): Promise<boolean> {
  const [face, animal] = await Promise.all([
    db.face.findFirst({ where: { photoId, personId: { not: null } }, select: { id: true } }),
    db.animalDetection.findFirst({ where: { photoId, personId: { not: null } }, select: { id: true } }),
  ]);
  return Boolean(face || animal);
}

/** The trip and collections an item is in that strangers cannot open. */
export async function privateContainersOf(photoId: string): Promise<PrivateContainer[]> {
  const p = await db.photo.findUnique({ where: { id: photoId }, select: { trip: { select: { id: true, title: true, visibility: true } }, collections: { select: { collection: { select: { id: true, title: true, visibility: true } } } } } });
  if (!p) return [];
  return [
    ...(p.trip && p.trip.visibility !== "PUBLIC" ? [{ key: `trip:${p.trip.id}`, title: p.trip.title }] : []),
    ...p.collections.flatMap(({ collection: c }) => (c.visibility !== "PUBLIC" ? [{ key: `collection:${c.id}`, title: c.title }] : [])),
  ];
}

/** Titles of the trip and collections an item is in that strangers cannot open. */
export async function privateTitlesOf(photoId: string): Promise<string[]> {
  const p = await db.photo.findUnique({ where: { id: photoId }, select: { trip: { select: { title: true, visibility: true } }, collections: { select: { collection: { select: { title: true, visibility: true } } } } } });
  if (!p) return [];
  const all = [p.trip, ...p.collections.map((c) => c.collection)];
  return all.flatMap((c) => (c && c.visibility !== "PUBLIC" ? [c.title] : []));
}

/**
 * The same, each with who it belongs to (`person:<id>` or `user:<id>`), so that somebody new with an old name, or a
 * rename, is a name the sweep has not judged yet.
 */
export async function knownNameEntries(client: Pick<typeof db, "person" | "user"> = db): Promise<{ key: string; name: string }[]> {
  const [people, members] = await Promise.all([
    client.person.findMany({ select: { id: true, name: true } }),
    client.user.findMany({ where: { name: { not: null } }, select: { id: true, name: true } }),
  ]);
  return [...people.map((p) => ({ key: `person:${p.id}:${p.name}`, name: p.name })), ...members.map((m) => ({ key: `user:${m.id}:${m.name}`, name: m.name ?? "" }))].filter((e) => e.name.trim());
}

/** Everybody the album has a name for: the people and pets it knows, and its members. */
export async function knownNames(): Promise<string[]> {
  const [people, members] = await Promise.all([
    db.person.findMany({ select: { name: true } }),
    db.user.findMany({ where: { name: { not: null } }, select: { name: true } }),
  ]);
  return [...people.map((p) => p.name), ...members.map((m) => m.name ?? "")];
}

/**
 * The members-only rule's look for a name the album knows (names.ts), at a level (name-check.ts). Strict: as it always
 * was, over `said` (every field run together). Relaxed: the same, but for the single-word first names of children
 * restricted for being children and nothing else, which are looked for field by field and let through where one of
 * the relaxed check's excuses applies (relaxed-names.ts; never in keywords or tags for a lower-case word). A first name
 * somebody else in the album (an adult, a member, anybody not a child alone) also has keeps the rule unchanged, as do
 * everybody's surnames and whole names. `only`: these names rather than everybody's (a judging pass for some names).
 */
export type NamesLook = (words: { texts: (string | null | undefined)[]; lists?: (string | null | undefined)[]; said?: string }) => boolean;

export async function knownNamesLook(level: NameCheck, only?: string[]): Promise<NamesLook> {
  const present = (l: (string | null | undefined)[]) => l.filter((t): t is string => typeof t === "string" && t.trim() !== "");
  const joined = (w: Parameters<NamesLook>[0]) => w.said ?? [...present(w.texts), ...present(w.lists ?? [])].join("\n");
  if (level !== "RELAXED") {
    const test = nameMatcher((only ?? (await knownNames())).flatMap(namePatterns));
    return (w) => Boolean(test?.(joined(w)));
  }
  const [people, members] = await Promise.all([
    db.person.findMany({ select: { name: true, formerNames: true, kind: true, birthday: true, optedOutAt: true, forgetPendingAt: true, namingWithdrawnAt: true, nameInDescriptions: true, nameInDescriptionsSetAt: true } }),
    db.user.findMany({ where: { name: { not: null } }, select: { name: true } }),
  ]);
  const single = (p: NamePattern) => p.words.length === 1 && !p.cjk;
  const key = (p: NamePattern) => `${p.exactCase ? "cs" : "ci"}:${p.words[0]}`;
  const excusable = new Map<string, NamePattern>();
  const others = new Set<string>();
  for (const p of people) {
    const firsts = p.kind === "HUMAN" && childOnly(p) ? strictFirstNames([p.name, ...(p.formerNames ?? [])]) : null;
    for (const pat of namePatterns(p.name).filter(single)) {
      if (firsts?.has(strictNormalize(pat.words[0]))) excusable.set(key(pat), pat);
      else others.add(key(pat));
    }
  }
  for (const m of members) for (const pat of namePatterns(m.name ?? "").filter(single)) others.add(key(pat));
  for (const k of others) excusable.delete(k);
  const asked = (only ?? [...people.map((p) => p.name), ...members.map((m) => m.name ?? "")]).flatMap(namePatterns);
  const test = nameMatcher(asked.filter((p) => !(single(p) && excusable.has(key(p)))));
  const relaxed = [...new Set(asked.filter((p) => single(p) && excusable.has(key(p))).map(key))].map((k) => excusable.get(k)!);
  return (w) => {
    if (test?.(joined(w))) return true;
    const texts = present(w.texts);
    const lists = present(w.lists ?? []);
    return relaxed.some((p) => texts.some((t) => relaxedWordHolds(t, p, false)) || lists.some((t) => relaxedWordHolds(t, p, true)));
  };
}

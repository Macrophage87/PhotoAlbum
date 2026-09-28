import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { bossJobs } from "@/lib/jobs/schema";
import { withTryLock } from "@/lib/advisory-lock";
import type { StoredAnnotation } from "./schema";
import { guessWords, holdsAt, noteRelaxedDescription, noteRelaxedRelease, shownOf } from "./relaxed-release";
import { helperText, knownNameEntries, knownNames, knownNamesLook, pastHelperTitles, sameTitle, titleHits, titleIsHelpers, titleKey, unknownTitleAside, warnStuckTitle, type PrivateContainer } from "./members-only";
import { nameMatcher, namePatterns, spokenWords, titleWords } from "./names";
import { namesSomebodyRestricted } from "@/lib/people/restricted";
import { albumNameCheck, anyRelaxed, photoNameCheck, PLACED_SELECT, tripNameCheck, type NameCheck, type Placed } from "@/lib/people/name-check";

/**
 * Judging again what was written before something changed.
 *
 * The helper's text, its place guesses and descriptions are judged when they are written (see `members-only.ts`).
 * Things change afterwards: a name becomes known (somebody is added, tagged under a new name, renamed, or a member
 * sets their name), a trip or collection changes title or visibility, a photograph joins a trip or a collection.
 * Each is answered here, in the background, never inside the request that made the change, and by the same rule as
 * at writing (`names.ts`): a name that is also an everyday word is only matched with a capital, so nothing is
 * skipped for being common. The children and the dog are the most named of all.
 *
 * Making something members-only is written against the words that were judged — the annotation's revision, the
 * title fields, the flags as read — never against `updatedAt`, which everything else moves too: a write that misses
 * because the row changed is read again and judged again, and a name is only recorded as judged once every write for
 * it has landed. Making something public again (the only other direction) is guarded by `updatedAt` as well, and
 * gives up rather than retries.
 *
 * What it will not do: move a title the family typed (see `titleIsHelpers`), or touch anything a member chose to
 * show to everyone (`annotationSharedAt`, `descriptionSharedAt`) — that stays shown until it is written again.
 */
export type RejudgeJob = {
  /**
   * Whose names to look for: people and members by id, never by name — a queued job outlives the request, and a
   * forgotten person's name must not wait in the queue for days. Their names are read when the job runs.
   */
  people?: string[];
  members?: string[];
  /** Only in jobs queued before names were asked for by id; still run, never queued. */
  names?: string[];
  tripId?: string;
  collectionId?: string;
  sweep?: boolean;
  /**
   * A name check made stricter (name-check.ts): what is shown to everyone, on the trip given or album-wide, checked
   * again at the level it has now (see `rejudgeNameCheck`).
   */
  recheck?: { tripId?: string };
};

/** `missed`: writes that could not land after judging again; while there are any, nothing is recorded as judged. */
export type RejudgeResult = { photos: number; titles: number; unflagged: number; places: number; descriptions: number; missed: number; /** Which rows missed, for the log. */ missedIds?: string[] };

const empty = (): RejudgeResult => ({ photos: 0, titles: 0, unflagged: 0, places: 0, descriptions: 0, missed: 0, missedIds: [] });
const miss = (result: RejudgeResult, id: string) => {
  result.missed++;
  result.missedIds = [...(result.missedIds ?? []), id];
};

/** Bump when the rules in names.ts or the ones here change: the next sweep then judges the whole album again. */
export const MATCHER_VERSION = "2026-09-27.1";

const BATCH = 200;
/** How many rows are judged between yields to the event loop. */
const YIELD_EVERY = 50;
/** How many times a missed write is read and judged again. */
const ATTEMPTS = 4;
/** One sweep at a time (see withTryLock), whoever runs it. */
const SWEEP_LOCK = 0x726a7377; // "rjsw"

type Container = { id: string; title: string; visibility: string };
type Row = {
  id: string; updatedAt: Date; kind: string; context: string | null; title: string | null; titleByHelper: boolean | null; membersTitle: string | null; annotation: unknown; annotationRevision: number;
  annotationMembersOnly: boolean; annotationTitleOnly: boolean; annotationTitleWords: string[]; annotationTitleFrom: string[]; annotationSharedAt: Date | null; relaxedReleaseAt: Date | null;
  trip: (Container & { nameCheck: NameCheck | null }) | null; collections: { collection: Container }[];
};

const container = { select: { id: true, title: true, visibility: true } } as const;
const rowSelect = {
  id: true, updatedAt: true, kind: true, context: true, title: true, titleByHelper: true, membersTitle: true, annotation: true, annotationRevision: true,
  annotationMembersOnly: true, annotationTitleOnly: true, annotationTitleWords: true, annotationTitleFrom: true, annotationSharedAt: true, relaxedReleaseAt: true,
  trip: { select: { id: true, title: true, visibility: true, nameCheck: true } }, collections: { select: { collection: container } },
} as const;

/** Lets a request in: the worker may share its process with the web server. */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));
let judgedSinceYield = 0;
/**
 * Between rows. `signal`: the job's, which pg-boss fires once it has given up on the run and queued its retry; the
 * run then stops here rather than go on beside the retry. What it wrote stands (every write is guarded), and nothing
 * is recorded as judged.
 */
async function pace(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (++judgedSinceYield % YIELD_EVERY === 0) await breathe();
}

/** Every annotated photograph matching `where`, a batch at a time; nothing is kept between batches. */
async function* annotated(where: Prisma.PhotoWhereInput = {}, signal?: AbortSignal): AsyncGenerator<Row> {
  let cursor: string | null = null;
  for (;;) {
    // Past the last id read rather than from a cursor row: a pass that changes what `where` asks about (a flag it
    // clears) must not lose the row after the one it just changed.
    const rows: Row[] = await db.photo.findMany({ where: { AND: [{ NOT: { annotation: { equals: Prisma.DbNull } } }, where, ...(cursor ? [{ id: { gt: cursor } }] : [])] }, orderBy: { id: "asc" }, take: BATCH, select: rowSelect });
    if (!rows.length) return;
    for (const r of rows) {
      await pace(signal);
      yield r;
    }
    cursor = rows[rows.length - 1].id;
  }
}

const reread = (id: string) => db.photo.findUnique({ where: { id }, select: rowSelect }) as Promise<Row | null>;
const aiTitleOf = (r: Pick<Row, "annotation" | "kind">) => (r.kind === "EXTERNAL_VIDEO" ? null : ((r.annotation as StoredAnnotation | null)?.title ?? "").trim() || null);
const textOf = (r: Row) => helperText((r.annotation ?? {}) as StoredAnnotation);
/** The item's titles that may be the helper's words: its own (unless recorded as a member's), and the members' one. */
const titlesOf = (r: Row) => [r.kind !== "EXTERNAL_VIDEO" && r.titleByHelper !== false ? r.title : null, r.membersTitle].filter(Boolean).join("\n");
const privateContainers = (r: Row): PrivateContainer[] => [
  ...(r.trip && r.trip.visibility !== "PUBLIC" ? [{ key: `trip:${r.trip.id}`, title: r.trip.title }] : []),
  ...r.collections.flatMap(({ collection: c }) => (c.visibility !== "PUBLIC" ? [{ key: `collection:${c.id}`, title: c.title }] : [])),
];

/**
 * The title fields once the item is members-only: the helper's title (see `titleIsHelpers`) comes off it, and a
 * title of unknown origin naming somebody goes aside for members (see `unknownTitleAside`). `names` is the pass's
 * name matcher, null for none.
 */
async function titleData(r: Row, names: ((text: string) => boolean) | null): Promise<{ title?: null; membersTitle?: string; titleByHelper?: null }> {
  if (r.kind === "EXTERNAL_VIDEO") return {};
  const ai = aiTitleOf(r);
  const own = titleKey(r.title) || null;
  const unknown = own && r.titleByHelper === null && own !== titleKey(ai);
  const helpers = titleIsHelpers({ title: r.title, titleByHelper: r.titleByHelper, aiTitle: ai, ...(unknown ? { pastTitles: await pastHelperTitles(r.id) } : {}) });
  const kept = titleKey(r.membersTitle) || null;
  if (helpers) return { title: null, titleByHelper: null, ...(kept ? {} : { membersTitle: ai ?? own! }) };
  const aside = unknownTitleAside({ title: r.title, titleByHelper: r.titleByHelper, membersTitle: r.membersTitle, aiTitle: ai, namesSomebody: Boolean(unknown && names?.(own!)) });
  // The helper's current title stays in its record; the member's words (or an old helper's) are what members read.
  if (aside === "move") return { title: null, titleByHelper: null, membersTitle: r.title! };
  if (aside === "stuck") warnStuckTitle(r.id);
  return ai && !kept ? { membersTitle: ai } : {};
}

/** The row exactly as judged: the same words, the same titles, the same flags, and not shown to everyone since. */
const asJudged = (r: Row): Prisma.PhotoWhereInput => ({
  id: r.id,
  annotationRevision: r.annotationRevision,
  annotationSharedAt: null,
  annotationMembersOnly: r.annotationMembersOnly,
  annotationTitleOnly: r.annotationTitleOnly,
  title: r.title,
  titleByHelper: r.titleByHelper,
  membersTitle: r.membersTitle,
});

/**
 * Flag a photograph: for a name or anything else stronger (`hits` null), or for a private title's words, which are
 * remembered with the containers they came from. Returns whether the write landed.
 */
export async function flagPhoto(r: Row, hits: { words: string[]; from: string[] } | null, names: ((text: string) => boolean) | null = null): Promise<boolean> {
  const hardNow = r.annotationMembersOnly && !r.annotationTitleOnly;
  const titleOnly = !hardNow && hits !== null;
  const data = {
    annotationMembersOnly: true,
    annotationTitleOnly: titleOnly,
    annotationTitleWords: titleOnly ? [...new Set([...r.annotationTitleWords, ...hits!.words])] : [],
    annotationTitleFrom: titleOnly ? [...new Set([...r.annotationTitleFrom, ...hits!.from])] : [],
    ...(await titleData(r, names)),
  };
  return (await db.photo.updateMany({ where: asJudged(r), data })).count > 0;
}

/**
 * Judge one photograph, and write what that decides; when the write misses because the row changed, read it again
 * and judge it again. `decide` returns what to write for a row, or null for nothing.
 */
async function settle(first: Row, decide: (r: Row) => Promise<"flag" | "hits" | "merge" | "title" | null>, names: ((text: string) => boolean) | null, result: RejudgeResult, hitsOf?: (r: Row) => { words: string[]; from: string[] }): Promise<void> {
  let r: Row | null = first;
  for (let attempt = 0; attempt < ATTEMPTS && r; attempt++) {
    const what = await decide(r);
    if (!what) return;
    let landed: boolean;
    if (what === "merge") {
      // Already held for title words: remember the new ones too, so lifting it later asks about them as well.
      const hits = hitsOf!(r);
      landed = (await db.photo.updateMany({ where: asJudged(r), data: { annotationTitleWords: [...new Set([...r.annotationTitleWords, ...hits.words])], annotationTitleFrom: [...new Set([...r.annotationTitleFrom, ...hits.from])] } })).count > 0;
    } else if (what === "title") {
      const data = await titleData(r, names);
      if (!("title" in data)) return;
      landed = (await db.photo.updateMany({ where: asJudged(r), data })).count > 0;
      if (landed) result.titles++;
    } else {
      landed = await flagPhoto(r, what === "hits" ? hitsOf!(r) : null, names);
      if (landed) result.photos++;
    }
    if (landed) return;
    r = await reread(r.id);
  }
  if (r) miss(result, r.id);
}

/** A guess's words, and where it is (for its level). */
const guessSelect = { id: true, placeEstimateName: true, placeEstimateNote: true, ...PLACED_SELECT } as const;

/** A guess the album still holds, shown or not: it has a name or evidence to judge. */
const HELD_GUESS = { OR: [{ placeEstimateName: { not: null } }, { placeEstimateNote: { not: null } }] } satisfies Prisma.PhotoWhereInput;

/**
 * Names: flag what mentions them and is not members-only yet (or is only because of a title word, which a name
 * outranks), and take the helper's titles off members-only items. `names` absent means everybody the album knows.
 */
export async function rejudgeNames(names?: string[], signal?: AbortSignal): Promise<RejudgeResult> {
  const result = empty();
  const asked = names ?? (await knownNames());
  const test = nameMatcher(asked.flatMap(namePatterns));
  if (!test) return result;
  // Where the name check is relaxed, the same look as at writing (see `knownNamesLook`), field by field.
  const album = await albumNameCheck();
  const relaxed = (await anyRelaxed()) ? await knownNamesLook("RELAXED", asked) : null;
  const relaxedAt = (level: NameCheck) => (relaxed && level === "RELAXED" ? relaxed : null);
  const mentions = (r: Row) => {
    const look = relaxedAt(photoNameCheck(r, album));
    if (!look) return test(textOf(r)) || test(titlesOf(r));
    const a = (r.annotation ?? {}) as Partial<StoredAnnotation>;
    return look({ texts: [a.title, a.caption, a.description, a.place], lists: [a.searchSummary, ...(a.tags ?? [])], said: textOf(r) }) || look({ texts: [r.kind !== "EXTERNAL_VIDEO" && r.titleByHelper !== false ? r.title : null, r.membersTitle] });
  };
  const decide = async (r: Row) => {
    if (r.annotationSharedAt) return null;
    const hard = r.annotationMembersOnly && !r.annotationTitleOnly;
    // The titles too, not only the helper's text as it is now: a title the helper gave in an earlier answer ("Ada's
    // birthday cake", from notes since cleared) outlives the text that is judged. A title a member typed since the
    // album kept track, and an embedded video's own, are theirs to publish and hold nothing back.
    if (!hard && mentions(r)) return "flag" as const;
    // Kept shown only because the relaxed look excused a name the strict one finds: marked (relaxed-release.ts), so
    // that a stricter level later still finds it.
    if (!r.annotationMembersOnly && relaxedAt(photoNameCheck(r, album)) && (test(textOf(r)) || test(titlesOf(r)))) await noteRelaxedRelease(r.id, "RELAXED");
    if (r.annotationMembersOnly && r.title?.trim() && r.titleByHelper !== false) return "title" as const;
    return null;
  };
  for await (const r of annotated({}, signal)) await settle(r, decide, test, result);

  // Place guesses, guarded on the words of the guess: every guess the album holds, whether or not it is the item's
  // place right now. One under a place set by hand comes back when that move is undone, with whatever flag it had.
  let cursor: string | null = null;
  for (;;) {
    // Past the last id read (see `annotated`): this flips the very flag it asks about.
    const guesses: ({ id: string; placeEstimateName: string | null; placeEstimateNote: string | null } & Placed)[] = await db.photo.findMany({ where: { ...HELD_GUESS, placeEstimateMembersOnly: false, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: "asc" }, take: BATCH, select: guessSelect });
    if (!guesses.length) break;
    for (const first of guesses) {
      let g: (typeof guesses)[number] | null = first;
      let settled = false;
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const said = g ? [g.placeEstimateName, g.placeEstimateNote].filter(Boolean).join("\n") : "";
        const look = g && relaxedAt(photoNameCheck(g, album));
        if (!g || !(look ? look({ texts: [said] }) : test(said))) {
          // Kept shown only by the relaxed look: marked, as above.
          if (g && look && test(said)) await noteRelaxedRelease(g.id, "RELAXED");
          settled = true;
          break;
        }
        const done = await db.photo.updateMany({ where: { id: g.id, ...HELD_GUESS, placeEstimateMembersOnly: false, placeEstimateName: g.placeEstimateName, placeEstimateNote: g.placeEstimateNote }, data: { placeEstimateMembersOnly: true } });
        if (done.count) { result.places++; settled = true; break; }
        g = await db.photo.findFirst({ where: { id: g.id, ...HELD_GUESS, placeEstimateMembersOnly: false }, select: guessSelect });
      }
      if (!settled) miss(result, first.id);
      await pace(signal);
    }
    cursor = guesses[guesses.length - 1].id;
  }

  // Descriptions, guarded on their words and flags as read; each at its own level (a trip's and its activities' by the
  // trip, a collection's by the album).
  const described = (level: NameCheck) => (description: string) => {
    const look = relaxedAt(level);
    return look ? look({ texts: [description] }) : test(description);
  };
  const tripLevels = new Map((await db.trip.findMany({ where: { nameCheck: { not: null } }, select: { id: true, nameCheck: true } })).map((t) => [t.id, t.nameCheck]));
  const judgeAll = async <T extends { id: string; description: string | null; descriptionMembersOnly: boolean }>(load: () => Promise<T[]>, reload: (id: string) => Promise<T | null>, write: (d: T) => Promise<number>, levelOf: (d: T) => NameCheck, kind: "trip" | "activity" | "collection") => {
    for (const first of await load()) {
      let d: T | null = first;
      let settled = false;
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        if (!d || !d.description || !described(levelOf(d))(d.description)) {
          // Kept shown only by the relaxed look: marked, as above.
          if (d?.description && levelOf(d) === "RELAXED" && relaxed && test(d.description)) await noteRelaxedDescription(kind, d.id, "RELAXED");
          settled = true;
          break;
        }
        if ((await write(d)) > 0) { result.descriptions++; settled = true; break; }
        d = await reload(d.id);
      }
      if (!settled) miss(result, first.id);
      await pace(signal);
    }
  };
  const unshown = { description: { not: null }, descriptionSharedAt: null };
  await judgeAll(
    () => db.trip.findMany({ where: { ...unshown, descriptionMembersOnly: false }, select: { id: true, description: true, descriptionMembersOnly: true } }),
    (id) => db.trip.findFirst({ where: { id, ...unshown, descriptionMembersOnly: false }, select: { id: true, description: true, descriptionMembersOnly: true } }),
    async (t) => (await db.trip.updateMany({ where: { id: t.id, description: t.description, descriptionMembersOnly: false, descriptionSharedAt: null }, data: { descriptionMembersOnly: true } })).count,
    (t) => tripNameCheck({ nameCheck: tripLevels.get(t.id) ?? null }, album),
    "trip",
  );
  await judgeAll(
    () => db.collection.findMany({ where: { ...unshown, descriptionMembersOnly: false }, select: { id: true, description: true, descriptionMembersOnly: true } }),
    (id) => db.collection.findFirst({ where: { id, ...unshown, descriptionMembersOnly: false }, select: { id: true, description: true, descriptionMembersOnly: true } }),
    async (c) => (await db.collection.updateMany({ where: { id: c.id, description: c.description, descriptionMembersOnly: false, descriptionSharedAt: null }, data: { descriptionMembersOnly: true } })).count,
    () => album,
    "collection",
  );
  const openActivity = { ...unshown, OR: [{ descriptionMembersOnly: false }, { descriptionTitleOnly: true }] };
  const activitySelect = { id: true, tripId: true, description: true, descriptionMembersOnly: true, descriptionTitleOnly: true } as const;
  await judgeAll(
    () => db.activity.findMany({ where: openActivity, select: activitySelect }),
    (id) => db.activity.findFirst({ where: { id, ...openActivity }, select: activitySelect }),
    async (a) => (await db.activity.updateMany({ where: { id: a.id, description: a.description, descriptionMembersOnly: a.descriptionMembersOnly, descriptionTitleOnly: a.descriptionTitleOnly, descriptionSharedAt: null }, data: { descriptionMembersOnly: true, descriptionTitleOnly: false, descriptionTitleWords: [] } })).count,
    (a) => tripNameCheck({ nameCheck: tripLevels.get(a.tripId) ?? null }, album),
    "activity",
  );
  return result;
}

/** Every word of every title strangers cannot read, album-wide. */
async function privateTitleWords(): Promise<Set<string>> {
  const [trips, collections] = await Promise.all([
    db.trip.findMany({ where: { visibility: { not: "PUBLIC" } }, select: { title: true } }),
    db.collection.findMany({ where: { visibility: { not: "PUBLIC" } }, select: { title: true } }),
  ]);
  return new Set(titleWords([...trips, ...collections].map((c) => c.title)));
}

/** The containers a flag came from, as they are now (a deleted one is missing). */
async function containersNow(keys: string[]): Promise<Map<string, Container>> {
  const ids = (kind: string) => keys.filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1));
  const [trips, collections] = await Promise.all([
    db.trip.findMany({ where: { id: { in: ids("trip") } }, select: { id: true, title: true, visibility: true } }),
    db.collection.findMany({ where: { id: { in: ids("collection") } }, select: { id: true, title: true, visibility: true } }),
  ]);
  return new Map([...trips.map((t) => [`trip:${t.id}`, t] as const), ...collections.map((c) => [`collection:${c.id}`, c] as const)]);
}

/**
 * Whether the title words that flagged something are public now: every container they came from is public and its
 * title still carries them, and no title strangers cannot read has any of them. A renamed-away title, a deleted
 * container, a photograph that moved on from a still-private one: all keep the flag.
 */
async function titleWordsArePublic(words: string[], from: string[], privateWords: Set<string>): Promise<boolean> {
  if (!words.length || !from.length) return false;
  if (words.some((w) => privateWords.has(w))) return false;
  const now = await containersNow(from);
  if (from.some((k) => now.get(k)?.visibility !== "PUBLIC")) return false;
  const carried = new Set(titleWords(from.map((k) => now.get(k)!.title)));
  return words.every((w) => carried.has(w));
}

async function tagged(photoId: string): Promise<boolean> {
  const [face, animal] = await Promise.all([
    db.face.findFirst({ where: { photoId, personId: { not: null } }, select: { id: true } }),
    db.animalDetection.findFirst({ where: { photoId, personId: { not: null } }, select: { id: true } }),
  ]);
  return Boolean(face || animal);
}

/**
 * Title words: flag the helper's text that repeats a word of a title strangers cannot open, for the photographs in
 * one trip or collection, or the ones given, or all of them. A flag held only for title words is lifted when those
 * words are public (see `titleWordsArePublic`) and nothing else holds it: no name the album knows (its own judging
 * may not have run yet), no notes, nobody tagged. A trip's activities' descriptions are judged against the trip's
 * title the same way.
 */
export async function rejudgeTitles(scope: { tripId?: string; collectionId?: string; photoIds?: string[] } = {}, signal?: AbortSignal): Promise<RejudgeResult> {
  // What was ever judged relaxed here is checked at the level it has now too (see `rejudgeNameCheck`).
  const result = await rejudgeNameCheck(scope, signal);
  const where: Prisma.PhotoWhereInput = scope.photoIds ? { id: { in: scope.photoIds } } : scope.tripId ? { tripId: scope.tripId } : scope.collectionId ? { collections: { some: { collectionId: scope.collectionId } } } : {};
  const privateWords = await privateTitleWords();
  const names = nameMatcher((await knownNames()).flatMap(namePatterns));
  const album = await albumNameCheck();
  const relaxed = (await anyRelaxed()) ? await knownNamesLook("RELAXED") : null;
  // A name the album knows, at the level of where the words are (see `knownNamesLook`), all fields run together.
  const named = (text: string, level: NameCheck) => (relaxed && level === "RELAXED" ? relaxed({ texts: [], lists: [text], said: text }) : Boolean(names?.(text)));
  const hitsOf = (r: Row) => titleHits(textOf(r), privateContainers(r));
  const decide = async (r: Row) => {
    if (r.annotationSharedAt) return null;
    const hits = hitsOf(r);
    if (!hits.from.length) return null;
    if (!r.annotationMembersOnly) return "hits" as const;
    const known = new Set(r.annotationTitleWords);
    const from = new Set(r.annotationTitleFrom);
    return r.annotationTitleOnly && (hits.words.some((w) => !known.has(w)) || hits.from.some((k) => !from.has(k))) ? ("merge" as const) : null;
  };
  for await (const r of annotated(where, signal)) {
    await settle(r, decide, names, result, hitsOf);
    if (r.annotationSharedAt || !r.annotationMembersOnly || !r.annotationTitleOnly) continue;
    if (hitsOf(r).from.length || !(await titleWordsArePublic(r.annotationTitleWords, r.annotationTitleFrom, privateWords))) continue;
    // Lifting is the one thing that shows text to strangers, so it asks everything else first — the whole text
    // against every title strangers cannot read (a private collection it passed through and left is not recorded
    // on it), any name the album knows, the notes, anybody tagged.
    const text = textOf(r);
    if ([...spokenWords(text)].some((w) => privateWords.has(w))) continue;
    // (All of its fields run together here, keywords too: judged as a list, where nobody else's full name excuses; at
    // the item's level, name-check.ts.)
    if (r.context?.trim() || named(text, photoNameCheck(r, album)) || (await tagged(r.id)) || (await namesSomebodyRestricted([], [text], photoNameCheck(r, album)))) {
      await db.photo.updateMany({ where: { id: r.id, updatedAt: r.updatedAt, annotationTitleOnly: true }, data: { annotationTitleOnly: false, annotationTitleWords: [], annotationTitleFrom: [] } });
      continue;
    }
    const ai = aiTitleOf(r);
    const back = ai && !titleKey(r.title) && sameTitle(r.membersTitle, ai);
    const lifted = (await db.photo.updateMany({ where: { id: r.id, updatedAt: r.updatedAt, annotationTitleOnly: true }, data: { annotationMembersOnly: false, annotationTitleOnly: false, annotationTitleWords: [], annotationTitleFrom: [], ...(back ? { title: ai, membersTitle: null, titleByHelper: true } : {}) } })).count;
    result.unflagged += lifted;
    // Let out only by a relaxed excuse: marked, to be judged again should that change (`rejudgeNameCheck`).
    if (lifted) await noteRelaxedRelease(r.id);
  }
  if (scope.collectionId || scope.photoIds) return result;
  const activities = await db.activity.findMany({
    where: { ...(scope.tripId ? { tripId: scope.tripId } : {}), description: { not: null }, descriptionSharedAt: null },
    select: { id: true, tripId: true, updatedAt: true, description: true, descriptionMembersOnly: true, descriptionTitleOnly: true, descriptionTitleWords: true, trip: { select: { title: true, visibility: true, nameCheck: true } } },
  });
  for (const a of activities) {
    await pace(signal);
    const words = a.trip.visibility !== "PUBLIC" ? titleHits(a.description!, [{ key: `trip:${a.tripId}`, title: a.trip.title }]).words : [];
    if (words.length && !a.descriptionMembersOnly) {
      result.descriptions += (await db.activity.updateMany({ where: { id: a.id, description: a.description, descriptionMembersOnly: false, descriptionSharedAt: null }, data: { descriptionMembersOnly: true, descriptionTitleOnly: true, descriptionTitleWords: words } })).count;
    } else if (!words.length && a.descriptionTitleOnly && (await titleWordsArePublic(a.descriptionTitleWords, [`trip:${a.tripId}`], privateWords)) && ![...spokenWords(a.description!)].some((w) => privateWords.has(w))) {
      const namesSomebody = named(a.description!, tripNameCheck(a.trip, album));
      const lifted = (await db.activity.updateMany({ where: { id: a.id, updatedAt: a.updatedAt, descriptionTitleOnly: true }, data: namesSomebody ? { descriptionTitleOnly: false, descriptionTitleWords: [] } : { descriptionMembersOnly: false, descriptionTitleOnly: false, descriptionTitleWords: [] } })).count;
      result.descriptions += lifted;
      if (lifted && !namesSomebody) await noteRelaxedDescription("activity", a.id);
    }
  }
  return result;
}

/**
 * Words the relaxed name check let out that the strict check would have held (marked `relaxedReleaseAt`: an item's
 * words, its place guess, the helper's description of a trip, an activity or a collection; relaxed-release.ts), judged
 * again at the level they have now and with who may be named now, as they would be judged if they were written or
 * shown today: by the share guard (strict-names.ts, relaxed for a child alone), and what the album published by
 * itself by the members-only rule's look at names as well (names.ts, `knownNamesLook`). Whatever that holds is taken
 * back for the family: shown to everyone no more (`annotationSharedAt`, `descriptionSharedAt` cleared), the helper's
 * title off the item, and the mark cleared. A mark on words no longer shown, or that no longer need the excuse, is
 * cleared too.
 *
 * Asked for when a level is made stricter, when an item moves to where it is stricter (a trip, a public collection, a
 * collection made public, no trip), when a child stops being restricted for being a child alone (opted out, naming
 * switched off), with every judging of a trip or a collection, and every night. Only ever about marked words:
 * anything the strict check let out is left exactly as it is.
 *
 * This is the one place a member's "show to everyone" is undone by the album: the words were let out by an excuse
 * that no longer applies. Nothing is ever made public here. Writes are guarded on the words and flags as read, and
 * one that misses is read and judged again, as `settle` does.
 */
export async function rejudgeNameCheck(scope: { tripId?: string; collectionId?: string; photoIds?: string[] } = {}, signal?: AbortSignal): Promise<RejudgeResult> {
  const result = empty();
  const inScope: Prisma.PhotoWhereInput = scope.photoIds ? { id: { in: scope.photoIds } } : scope.tripId ? { tripId: scope.tripId } : scope.collectionId ? { collections: { some: { collectionId: scope.collectionId } } } : {};
  const descriptions = !scope.photoIds;
  const [marked, guesses, trips, activities, collections] = await Promise.all([
    db.photo.count({ where: { ...inScope, relaxedReleaseAt: { not: null } } }),
    db.photo.count({ where: { ...inScope, placeRelaxedReleaseAt: { not: null } } }),
    descriptions && !scope.collectionId ? db.trip.count({ where: { relaxedReleaseAt: { not: null }, ...(scope.tripId ? { id: scope.tripId } : {}) } }) : 0,
    descriptions && !scope.collectionId ? db.activity.count({ where: { relaxedReleaseAt: { not: null }, ...(scope.tripId ? { tripId: scope.tripId } : {}) } }) : 0,
    descriptions && !scope.tripId ? db.collection.count({ where: { relaxedReleaseAt: { not: null }, ...(scope.collectionId ? { id: scope.collectionId } : {}) } }) : 0,
  ]);
  // Nothing the relaxed check let out here: nothing to do.
  if (!marked && !guesses && !trips && !activities && !collections) return result;
  const album = await albumNameCheck();
  const holds = await holdsAt();

  if (marked) {
    for await (const first of annotated({ ...inScope, relaxedReleaseAt: { not: null } }, signal)) {
      let r: Row | null = first;
      let settled = false;
      for (let attempt = 0; attempt < ATTEMPTS && r; attempt++) {
        if (!r.relaxedReleaseAt) { settled = true; break; }
        const asRead = { id: r.id, annotationRevision: r.annotationRevision, annotationSharedAt: r.annotationSharedAt, annotationMembersOnly: r.annotationMembersOnly, title: r.title, titleByHelper: r.titleByHelper, membersTitle: r.membersTitle };
        const level = photoNameCheck(r, album);
        const shown = shownOf(r);
        const published = !r.annotationSharedAt;
        let data: Prisma.PhotoUpdateManyMutationInput;
        let pulled = false;
        if (r.annotationMembersOnly) data = { relaxedReleaseAt: null };
        else if (holds(level, shown.texts, shown.lists, published)) {
          data = { annotationMembersOnly: true, annotationTitleOnly: false, annotationTitleWords: [], annotationTitleFrom: [], annotationSharedAt: null, relaxedReleaseAt: null, ...(await titleData(r, (t) => holds(level, [t], [], true))) };
          pulled = true;
        } else if (!holds("STRICT", shown.texts, shown.lists, published)) data = { relaxedReleaseAt: null };
        else { settled = true; break; }
        const landed = await db.photo.updateMany({ where: asRead, data });
        if (landed.count) { if (pulled) result.photos++; settled = true; break; }
        r = await reread(r.id);
      }
      if (r && !settled) miss(result, first.id);
    }
  }

  // Place guesses shown beside the pin, guarded on their words.
  let cursor: string | null = null;
  while (guesses) {
    // Past the last id read (see `annotated`): this clears the very mark it asks about.
    const page: ({ id: string; placeEstimateName: string | null; placeEstimateNote: string | null; placeEstimateMembersOnly: boolean } & Placed)[] = await db.photo.findMany({ where: { AND: [inScope, { placeRelaxedReleaseAt: { not: null } }, ...(cursor ? [{ id: { gt: cursor } }] : [])] }, orderBy: { id: "asc" }, take: BATCH, select: { ...guessSelect, placeEstimateMembersOnly: true } });
    if (!page.length) break;
    for (const g of page) {
      await pace(signal);
      const asRead = { id: g.id, placeEstimateName: g.placeEstimateName, placeEstimateNote: g.placeEstimateNote, placeEstimateMembersOnly: g.placeEstimateMembersOnly };
      const said = guessWords(g);
      const shown = !g.placeEstimateMembersOnly && said.trim() !== "";
      if (shown && holds(photoNameCheck(g, album), [said], [], true)) {
        const n = (await db.photo.updateMany({ where: asRead, data: { placeEstimateMembersOnly: true, placeRelaxedReleaseAt: null } })).count;
        // Rewritten since it was read: counted as missed, so the night's pass is not recorded as done and looks again.
        if (n) result.places += n;
        else miss(result, g.id);
      } else if (!shown || !holds("STRICT", [said], [], true)) await db.photo.updateMany({ where: asRead, data: { placeRelaxedReleaseAt: null } });
    }
    cursor = page[page.length - 1].id;
  }

  // The helper's descriptions, at their own level: a trip's and its activities' by the trip, a collection's by the album.
  type Desc = { id: string; description: string | null; descriptionByHelper: boolean; descriptionMembersOnly: boolean; descriptionSharedAt: Date | null };
  const judgeDescription = async (d: Desc, level: NameCheck, write: (where: object, data: object) => Promise<number>) => {
    await pace(signal);
    const asRead = { id: d.id, description: d.description, descriptionByHelper: d.descriptionByHelper, descriptionMembersOnly: d.descriptionMembersOnly, descriptionSharedAt: d.descriptionSharedAt };
    const shown = d.descriptionByHelper && !d.descriptionMembersOnly && Boolean(d.description?.trim());
    const published = !d.descriptionSharedAt;
    if (shown && holds(level, [d.description!], [], published)) {
      const n = await write(asRead, { descriptionMembersOnly: true, descriptionSharedAt: null, relaxedReleaseAt: null });
      if (n) result.descriptions += n;
      else miss(result, d.id);
    }
    else if (!shown || !holds("STRICT", [d.description!], [], published)) await write(asRead, { relaxedReleaseAt: null });
  };
  const described = { id: true, description: true, descriptionByHelper: true, descriptionMembersOnly: true, descriptionSharedAt: true } as const;
  if (trips) {
    for (const t of await db.trip.findMany({ where: { relaxedReleaseAt: { not: null }, ...(scope.tripId ? { id: scope.tripId } : {}) }, select: { ...described, nameCheck: true } })) {
      await judgeDescription(t, tripNameCheck(t, album), async (where, data) => (await db.trip.updateMany({ where, data })).count);
    }
  }
  if (activities) {
    for (const a of await db.activity.findMany({ where: { relaxedReleaseAt: { not: null }, ...(scope.tripId ? { tripId: scope.tripId } : {}) }, select: { ...described, trip: { select: { nameCheck: true } } } })) {
      await judgeDescription(a, tripNameCheck(a.trip, album), async (where, data) => (await db.activity.updateMany({ where, data: { ...data, ...("descriptionMembersOnly" in data ? { descriptionTitleOnly: false, descriptionTitleWords: [] } : {}) } })).count);
    }
  }
  if (collections) {
    for (const c of await db.collection.findMany({ where: { relaxedReleaseAt: { not: null }, ...(scope.collectionId ? { id: scope.collectionId } : {}) }, select: described })) {
      await judgeDescription(c, album, async (where, data) => (await db.collection.updateMany({ where, data })).count);
    }
  }
  return result;
}

const add = (a: RejudgeResult, b: RejudgeResult): RejudgeResult => ({ photos: a.photos + b.photos, titles: a.titles + b.titles, unflagged: a.unflagged + b.unflagged, places: a.places + b.places, descriptions: a.descriptions + b.descriptions, missed: a.missed + b.missed, missedIds: [...(a.missedIds ?? []), ...(b.missedIds ?? [])] });

/** `person:<id>:<name>` → `person:<id>`, and → `<name>`. */
const keyOwner = (key: string) => key.split(":").slice(0, 2).join(":");
const keyName = (key: string) => key.split(":").slice(2).join(":");

/**
 * Record names as judged: merged with what is recorded now, and only for people and members still in the album. The
 * settings row is locked first, and who is still in the album read after, so a person deleted meanwhile (see
 * `forgetJudgedNames`) is never written back.
 */
async function recordJudged(keys: string[], extra: { membersOnlyMatcher?: string; membersOnlyJudgedAt?: Date } = {}): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.appSetting.upsert({ where: { id: "app" }, create: { id: "app" }, update: {} });
    await tx.$queryRaw`SELECT id FROM "AppSetting" WHERE id = 'app' FOR UPDATE`;
    const current = new Set((await knownNameEntries(tx)).map((e) => e.key));
    const setting = await tx.appSetting.findUnique({ where: { id: "app" }, select: { membersOnlyNames: true } });
    const merged = [...new Set([...(setting?.membersOnlyNames ?? []), ...keys])].filter((k) => current.has(k));
    await tx.appSetting.update({ where: { id: "app" }, data: { membersOnlyNames: merged, ...extra } });
  });
}

/**
 * A person's (`person:<id>`) or a member's (`user:<id>`) record is being deleted: the names recorded as judged for
 * them go in the same transaction, so their name is not left in clear in the settings until the next sweep.
 */
export async function forgetJudgedNames(tx: Prisma.TransactionClient, owner: `person:${string}` | `user:${string}`): Promise<void> {
  await tx.$executeRaw`UPDATE "AppSetting" SET "membersOnlyNames" = ARRAY(SELECT k FROM unnest("membersOnlyNames") k WHERE k NOT LIKE ${`${owner}:%`}) WHERE id = 'app'`;
}

/**
 * Take a person's judging jobs out of the queue: new ones carry only their id, and jobs queued before names were
 * asked for by id carry the names themselves (in their data and their singleton key). Every state, the finished
 * ones kept for days included. Never fails the forget it is part of: an unreadable queue is logged.
 */
export async function dropRejudgeJobs(personId: string, names: string[]): Promise<void> {
  const forms = [...new Set(names.filter((n) => n.trim()))];
  try {
    await db.$executeRaw`
      DELETE FROM ${bossJobs()} WHERE name = ${QUEUES.rejudgeText}
        AND (jsonb_exists(COALESCE(data->'people', '[]'::jsonb), ${personId})
          OR jsonb_exists_any(COALESCE(data->'names', '[]'::jsonb), ${forms}::text[]))`;
  } catch (err) {
    console.error("[rejudge] could not clear queued judging for a forgotten person", err instanceof Error ? err.message : err);
  }
}

/**
 * Delete every judging job that carries names, in any state: nothing queues that form any more, and one left from
 * before (or one a forget could not clear, see `dropRejudgeJobs`; or one for a pet deleted since) would keep a name in
 * clear for days. What they asked about is judged by the sweep anyway. At worker start and with every sweep.
 */
export async function dropLegacyRejudgeJobs(): Promise<number> {
  try {
    return await db.$executeRaw`DELETE FROM ${bossJobs()} WHERE name = ${QUEUES.rejudgeText} AND jsonb_exists(data, 'names')`;
  } catch (err) {
    console.error("[rejudge] could not clear judging jobs that carry names", err instanceof Error ? err.message : err);
    return 0;
  }
}

/**
 * The names a job asks about, read now: each person's name and former names, each member's name, and any older name
 * of theirs recorded as judged (a rename). Somebody deleted since has none.
 */
async function namesOfJob(job: RejudgeJob): Promise<{ names: string[]; owners: Set<string> }> {
  const [people, members, setting] = await Promise.all([
    job.people?.length ? db.person.findMany({ where: { id: { in: job.people } }, select: { id: true, name: true, formerNames: true } }) : [],
    job.members?.length ? db.user.findMany({ where: { id: { in: job.members } }, select: { id: true, name: true } }) : [],
    db.appSetting.findUnique({ where: { id: "app" }, select: { membersOnlyNames: true } }),
  ]);
  const owners = new Set([...people.map((p) => `person:${p.id}`), ...members.map((m) => `user:${m.id}`)]);
  const recorded = (setting?.membersOnlyNames ?? []).filter((k) => owners.has(keyOwner(k))).map(keyName);
  const names = [...people.flatMap((p) => [p.name, ...p.formerNames]), ...members.map((m) => m.name ?? ""), ...recorded].filter((n) => n.trim());
  return { names: [...new Set(names)], owners };
}

/**
 * The sweep, run when the worker starts and every night: the whole album when the rules have changed since the last
 * one, otherwise the names it has not judged (a rename whose job could not be queued included), the trips and
 * collections changed since, and the photographs that joined a trip or collection since. Nothing is recorded while
 * any write missed, so the next sweep tries again.
 *
 * One at a time, whoever runs it: a second one (a retry pg-boss started beside a sweep it had given up on, another
 * worker's) is skipped rather than read the whole album again alongside — the running one records its result.
 */
export async function rejudgeSweep(signal?: AbortSignal): Promise<RejudgeResult> {
  const run = await withTryLock({ space: SWEEP_LOCK }, () => sweepOnce(signal));
  if (run.ran) return run.value;
  console.warn("[rejudge] a sweep is already running; this one is skipped");
  return empty();
}

async function sweepOnce(signal?: AbortSignal): Promise<RejudgeResult> {
  const started = new Date();
  await dropLegacyRejudgeJobs();
  const setting = await db.appSetting.findUnique({ where: { id: "app" }, select: { membersOnlyMatcher: true, membersOnlyNames: true, membersOnlyJudgedAt: true } });
  const entries = await knownNameEntries();
  const judged = new Set(setting?.membersOnlyNames ?? []);
  let result = empty();
  const full = setting?.membersOnlyMatcher !== MATCHER_VERSION;
  if (full) {
    result = add(await rejudgeNames(entries.map((e) => e.name), signal), await rejudgeTitles({}, signal));
  } else {
    const fresh = entries.filter((e) => !judged.has(e.key));
    // Somebody renamed since: their old name is looked for too, in case the rename's own job never ran.
    const current = new Set(entries.map((e) => e.key));
    const previous = [...judged].filter((k) => !current.has(k) && entries.some((e) => keyOwner(e.key) === keyOwner(k))).map(keyName);
    const names = [...new Set([...fresh.map((e) => e.name), ...previous])];
    if (names.length) result = await rejudgeNames(names, signal);
    const since = setting?.membersOnlyJudgedAt ?? new Date(0);
    const [trips, collections, moved] = await Promise.all([
      db.trip.findMany({ where: { updatedAt: { gt: since } }, select: { id: true } }),
      db.collection.findMany({ where: { updatedAt: { gt: since } }, select: { id: true } }),
      db.photo.findMany({ where: { containersChangedAt: { gt: since } }, select: { id: true } }),
    ]);
    for (const t of trips) result = add(result, await rejudgeTitles({ tripId: t.id }, signal));
    for (const c of collections) result = add(result, await rejudgeTitles({ collectionId: c.id }, signal));
    for (let i = 0; i < moved.length; i += BATCH) result = add(result, await rejudgeTitles({ photoIds: moved.slice(i, i + BATCH).map((p) => p.id) }, signal));
  }
  // Everything ever judged relaxed, at the level it has now: whatever a missed job, a deleted trip or a change of who
  // may be named left out.
  result = add(result, await rejudgeNameCheck({}, signal));
  if (!result.missed) await recordJudged(entries.map((e) => e.key), { membersOnlyMatcher: MATCHER_VERSION, membersOnlyJudgedAt: started });
  else console.warn(`[rejudge] ${result.missed} write(s) kept missing (${(result.missedIds ?? []).slice(0, 50).join(", ")}); the next sweep judges them again`);
  return result;
}

/**
 * Ask for a judging, from whatever changed: a name, or a trip's or collection's title, visibility or photographs.
 * One at a time per thing asked about, so pressing save twice is one pass — and a second change inside the same ten
 * seconds is queued for the next slot rather than dropped (a trip made public and private again is judged twice).
 */
export async function enqueueRejudge(job: RejudgeJob): Promise<void> {
  const ids = (xs?: string[]) => [...(xs ?? [])].sort().join("|");
  const key = job.sweep ? "sweep" : job.recheck ? `recheck:${job.recheck.tripId ?? "album"}` : job.tripId ? `trip:${job.tripId}` : job.collectionId ? `collection:${job.collectionId}` : job.people || job.members ? `people:${ids(job.people)}:members:${ids(job.members)}` : "all";
  await enqueue(QUEUES.rejudgeText, job, { singletonKey: `rejudge:${key}`.slice(0, 200), singletonSeconds: 10, singletonNextSlot: true, retryLimit: 3, retryDelay: 30 });
}

/**
 * Queue a judging from an action, without letting a queue that is down fail what the member asked for. Tried a few
 * times; if it still cannot be queued, the nightly sweep picks the change up, and the answer says so.
 */
export async function rejudgeLater(job: RejudgeJob): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await enqueueRejudge(job);
      return true;
    } catch (err) {
      if (attempt === 2) console.error("[rejudge] could not queue", err instanceof Error ? err.message : err);
      else await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  return false;
}

/**
 * The job: the sweep, one trip's or collection's title words, the names of the people and members given, or — with
 * nothing given — all of it. `signal`: the job's (see `pace`).
 */
export async function rejudgeText(job: RejudgeJob, signal?: AbortSignal): Promise<RejudgeResult> {
  if (job.sweep) return rejudgeSweep(signal);
  if (job.recheck) return rejudgeNameCheck(job.recheck.tripId ? { tripId: job.recheck.tripId } : {}, signal);
  if (job.tripId || job.collectionId) return rejudgeTitles({ tripId: job.tripId, collectionId: job.collectionId }, signal);
  if (job.people || job.members) {
    const { names, owners } = await namesOfJob(job);
    // Forgotten, or gone, since it was asked: nothing of theirs is left to look for.
    if (!names.length) return empty();
    const result = await rejudgeNames(names, signal);
    // A name is recorded as judged only once every write for it has landed; otherwise the next sweep tries again.
    if (!result.missed) await recordJudged((await knownNameEntries()).filter((e) => owners.has(keyOwner(e.key))).map((e) => e.key));
    return result;
  }
  if (job.names) {
    const result = await rejudgeNames(job.names, signal);
    if (!result.missed) {
      const asked = new Set(job.names);
      await recordJudged((await knownNameEntries()).filter((e) => asked.has(e.name)).map((e) => e.key));
    }
    return result;
  }
  return add(await rejudgeNames(undefined, signal), await rejudgeTitles({}, signal));
}

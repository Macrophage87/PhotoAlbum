import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import type { StoredAnnotation } from "./schema";
import { helperText, knownNameEntries, knownNames, pastHelperTitles, titleHits, titleIsHelpers, type PrivateContainer } from "./members-only";
import { nameMatcher, namePatterns, spokenWords, titleWords } from "./names";

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
export type RejudgeJob = { names?: string[]; tripId?: string; collectionId?: string; sweep?: boolean };

/** `missed`: writes that could not land after judging again; while there are any, nothing is recorded as judged. */
export type RejudgeResult = { photos: number; titles: number; unflagged: number; places: number; descriptions: number; missed: number; /** Which rows missed, for the log. */ missedIds?: string[] };

const empty = (): RejudgeResult => ({ photos: 0, titles: 0, unflagged: 0, places: 0, descriptions: 0, missed: 0, missedIds: [] });
const miss = (result: RejudgeResult, id: string) => {
  result.missed++;
  result.missedIds = [...(result.missedIds ?? []), id];
};

/** Bump when the rules in names.ts or the ones here change: the next sweep then judges the whole album again. */
export const MATCHER_VERSION = "2026-09-26.6";

const BATCH = 200;
/** How many rows are judged between yields to the event loop. */
const YIELD_EVERY = 50;
/** How many times a missed write is read and judged again. */
const ATTEMPTS = 4;

type Container = { id: string; title: string; visibility: string };
type Row = {
  id: string; updatedAt: Date; kind: string; context: string | null; title: string | null; titleByHelper: boolean | null; membersTitle: string | null; annotation: unknown; annotationRevision: number;
  annotationMembersOnly: boolean; annotationTitleOnly: boolean; annotationTitleWords: string[]; annotationTitleFrom: string[]; annotationSharedAt: Date | null;
  trip: Container | null; collections: { collection: Container }[];
};

const container = { select: { id: true, title: true, visibility: true } } as const;
const rowSelect = {
  id: true, updatedAt: true, kind: true, context: true, title: true, titleByHelper: true, membersTitle: true, annotation: true, annotationRevision: true,
  annotationMembersOnly: true, annotationTitleOnly: true, annotationTitleWords: true, annotationTitleFrom: true, annotationSharedAt: true,
  trip: container, collections: { select: { collection: container } },
} as const;

/** Lets a request in: the worker may share its process with the web server. */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));
let judgedSinceYield = 0;
async function pace(): Promise<void> {
  if (++judgedSinceYield % YIELD_EVERY === 0) await breathe();
}

/** Every annotated photograph matching `where`, a batch at a time; nothing is kept between batches. */
async function* annotated(where: Prisma.PhotoWhereInput = {}): AsyncGenerator<Row> {
  let cursor: string | null = null;
  for (;;) {
    const rows: Row[] = await db.photo.findMany({ where: { NOT: { annotation: { equals: Prisma.DbNull } }, ...where }, orderBy: { id: "asc" }, take: BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: rowSelect });
    if (!rows.length) return;
    for (const r of rows) {
      yield r;
      await pace();
    }
    cursor = rows[rows.length - 1].id;
  }
}

const reread = (id: string) => db.photo.findUnique({ where: { id }, select: rowSelect }) as Promise<Row | null>;
const aiTitleOf = (r: Pick<Row, "annotation" | "kind">) => (r.kind === "EXTERNAL_VIDEO" ? null : ((r.annotation as StoredAnnotation | null)?.title ?? "").trim() || null);
const textOf = (r: Row) => helperText((r.annotation ?? {}) as StoredAnnotation);
const privateContainers = (r: Row): PrivateContainer[] => [
  ...(r.trip && r.trip.visibility !== "PUBLIC" ? [{ key: `trip:${r.trip.id}`, title: r.trip.title }] : []),
  ...r.collections.flatMap(({ collection: c }) => (c.visibility !== "PUBLIC" ? [{ key: `collection:${c.id}`, title: c.title }] : [])),
];

/** The title fields once the item is members-only: the helper's title (see `titleIsHelpers`) comes off it. */
async function titleData(r: Row): Promise<{ title?: null; membersTitle?: string; titleByHelper?: null }> {
  if (r.kind === "EXTERNAL_VIDEO") return {};
  const ai = aiTitleOf(r);
  const own = r.title?.trim() || null;
  const unknown = own && r.titleByHelper === null && own !== ai;
  const helpers = titleIsHelpers({ title: r.title, titleByHelper: r.titleByHelper, aiTitle: ai, ...(unknown ? { pastTitles: await pastHelperTitles(r.id) } : {}) });
  const kept = r.membersTitle?.trim() || null;
  if (helpers) return { title: null, titleByHelper: null, ...(kept ? {} : { membersTitle: ai ?? own! }) };
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
export async function flagPhoto(r: Row, hits: { words: string[]; from: string[] } | null): Promise<boolean> {
  const hardNow = r.annotationMembersOnly && !r.annotationTitleOnly;
  const titleOnly = !hardNow && hits !== null;
  const data = {
    annotationMembersOnly: true,
    annotationTitleOnly: titleOnly,
    annotationTitleWords: titleOnly ? [...new Set([...r.annotationTitleWords, ...hits!.words])] : [],
    annotationTitleFrom: titleOnly ? [...new Set([...r.annotationTitleFrom, ...hits!.from])] : [],
    ...(await titleData(r)),
  };
  return (await db.photo.updateMany({ where: asJudged(r), data })).count > 0;
}

/**
 * Judge one photograph, and write what that decides; when the write misses because the row changed, read it again
 * and judge it again. `decide` returns what to write for a row, or null for nothing.
 */
async function settle(first: Row, decide: (r: Row) => Promise<"flag" | "hits" | "merge" | "title" | null>, result: RejudgeResult, hitsOf?: (r: Row) => { words: string[]; from: string[] }): Promise<void> {
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
      const data = await titleData(r);
      if (!("title" in data)) return;
      landed = (await db.photo.updateMany({ where: asJudged(r), data })).count > 0;
      if (landed) result.titles++;
    } else {
      landed = await flagPhoto(r, what === "hits" ? hitsOf!(r) : null);
      if (landed) result.photos++;
    }
    if (landed) return;
    r = await reread(r.id);
  }
  if (r) miss(result, r.id);
}

/** A guess the album still holds, shown or not: it has a name or evidence to judge. */
const HELD_GUESS = { OR: [{ placeEstimateName: { not: null } }, { placeEstimateNote: { not: null } }] } satisfies Prisma.PhotoWhereInput;

/**
 * Names: flag what mentions them and is not members-only yet (or is only because of a title word, which a name
 * outranks), and take the helper's titles off members-only items. `names` absent means everybody the album knows.
 */
export async function rejudgeNames(names?: string[]): Promise<RejudgeResult> {
  const result = empty();
  const test = nameMatcher((names ?? (await knownNames())).flatMap(namePatterns));
  if (!test) return result;
  const decide = async (r: Row) => {
    if (r.annotationSharedAt) return null;
    const hard = r.annotationMembersOnly && !r.annotationTitleOnly;
    if (!hard && test(textOf(r))) return "flag" as const;
    if (r.annotationMembersOnly && r.title?.trim() && r.titleByHelper !== false) return "title" as const;
    return null;
  };
  for await (const r of annotated()) await settle(r, decide, result);

  // Place guesses, guarded on the words of the guess: every guess the album holds, whether or not it is the item's
  // place right now. One under a place set by hand comes back when that move is undone, with whatever flag it had.
  let cursor: string | null = null;
  for (;;) {
    const guesses: { id: string; placeEstimateName: string | null; placeEstimateNote: string | null }[] = await db.photo.findMany({ where: { ...HELD_GUESS, placeEstimateMembersOnly: false }, orderBy: { id: "asc" }, take: BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, placeEstimateName: true, placeEstimateNote: true } });
    if (!guesses.length) break;
    for (const first of guesses) {
      let g: (typeof guesses)[number] | null = first;
      let settled = false;
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        if (!g || !test([g.placeEstimateName, g.placeEstimateNote].filter(Boolean).join("\n"))) { settled = true; break; }
        const done = await db.photo.updateMany({ where: { id: g.id, ...HELD_GUESS, placeEstimateMembersOnly: false, placeEstimateName: g.placeEstimateName, placeEstimateNote: g.placeEstimateNote }, data: { placeEstimateMembersOnly: true } });
        if (done.count) { result.places++; settled = true; break; }
        g = await db.photo.findFirst({ where: { id: g.id, ...HELD_GUESS, placeEstimateMembersOnly: false }, select: { id: true, placeEstimateName: true, placeEstimateNote: true } });
      }
      if (!settled) miss(result, first.id);
      await pace();
    }
    cursor = guesses[guesses.length - 1].id;
  }

  // Descriptions, guarded on their words and flags as read.
  const judgeAll = async <T extends { id: string; description: string | null; descriptionMembersOnly: boolean }>(load: () => Promise<T[]>, reload: (id: string) => Promise<T | null>, write: (d: T) => Promise<number>) => {
    for (const first of await load()) {
      let d: T | null = first;
      let settled = false;
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        if (!d || !d.description || !test(d.description)) { settled = true; break; }
        if ((await write(d)) > 0) { result.descriptions++; settled = true; break; }
        d = await reload(d.id);
      }
      if (!settled) miss(result, first.id);
      await pace();
    }
  };
  const unshown = { description: { not: null }, descriptionSharedAt: null };
  await judgeAll(
    () => db.trip.findMany({ where: { ...unshown, descriptionMembersOnly: false }, select: { id: true, description: true, descriptionMembersOnly: true } }),
    (id) => db.trip.findFirst({ where: { id, ...unshown, descriptionMembersOnly: false }, select: { id: true, description: true, descriptionMembersOnly: true } }),
    async (t) => (await db.trip.updateMany({ where: { id: t.id, description: t.description, descriptionMembersOnly: false, descriptionSharedAt: null }, data: { descriptionMembersOnly: true } })).count,
  );
  await judgeAll(
    () => db.collection.findMany({ where: { ...unshown, descriptionMembersOnly: false }, select: { id: true, description: true, descriptionMembersOnly: true } }),
    (id) => db.collection.findFirst({ where: { id, ...unshown, descriptionMembersOnly: false }, select: { id: true, description: true, descriptionMembersOnly: true } }),
    async (c) => (await db.collection.updateMany({ where: { id: c.id, description: c.description, descriptionMembersOnly: false, descriptionSharedAt: null }, data: { descriptionMembersOnly: true } })).count,
  );
  const openActivity = { ...unshown, OR: [{ descriptionMembersOnly: false }, { descriptionTitleOnly: true }] };
  const activitySelect = { id: true, description: true, descriptionMembersOnly: true, descriptionTitleOnly: true } as const;
  await judgeAll(
    () => db.activity.findMany({ where: openActivity, select: activitySelect }),
    (id) => db.activity.findFirst({ where: { id, ...openActivity }, select: activitySelect }),
    async (a) => (await db.activity.updateMany({ where: { id: a.id, description: a.description, descriptionMembersOnly: a.descriptionMembersOnly, descriptionTitleOnly: a.descriptionTitleOnly, descriptionSharedAt: null }, data: { descriptionMembersOnly: true, descriptionTitleOnly: false, descriptionTitleWords: [] } })).count,
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
export async function rejudgeTitles(scope: { tripId?: string; collectionId?: string; photoIds?: string[] } = {}): Promise<RejudgeResult> {
  const result = empty();
  const where: Prisma.PhotoWhereInput = scope.photoIds ? { id: { in: scope.photoIds } } : scope.tripId ? { tripId: scope.tripId } : scope.collectionId ? { collections: { some: { collectionId: scope.collectionId } } } : {};
  const privateWords = await privateTitleWords();
  const names = nameMatcher((await knownNames()).flatMap(namePatterns));
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
  for await (const r of annotated(where)) {
    await settle(r, decide, result, hitsOf);
    if (r.annotationSharedAt || !r.annotationMembersOnly || !r.annotationTitleOnly) continue;
    if (hitsOf(r).from.length || !(await titleWordsArePublic(r.annotationTitleWords, r.annotationTitleFrom, privateWords))) continue;
    // Lifting is the one thing that shows text to strangers, so it asks everything else first — the whole text
    // against every title strangers cannot read (a private collection it passed through and left is not recorded
    // on it), any name the album knows, the notes, anybody tagged.
    const text = textOf(r);
    if ([...spokenWords(text)].some((w) => privateWords.has(w))) continue;
    if (r.context?.trim() || names?.(text) || (await tagged(r.id))) {
      await db.photo.updateMany({ where: { id: r.id, updatedAt: r.updatedAt, annotationTitleOnly: true }, data: { annotationTitleOnly: false, annotationTitleWords: [], annotationTitleFrom: [] } });
      continue;
    }
    const ai = aiTitleOf(r);
    const back = ai && !r.title?.trim() && r.membersTitle?.trim() === ai;
    result.unflagged += (await db.photo.updateMany({ where: { id: r.id, updatedAt: r.updatedAt, annotationTitleOnly: true }, data: { annotationMembersOnly: false, annotationTitleOnly: false, annotationTitleWords: [], annotationTitleFrom: [], ...(back ? { title: ai, membersTitle: null, titleByHelper: true } : {}) } })).count;
  }
  if (scope.collectionId || scope.photoIds) return result;
  const activities = await db.activity.findMany({
    where: { ...(scope.tripId ? { tripId: scope.tripId } : {}), description: { not: null }, descriptionSharedAt: null },
    select: { id: true, tripId: true, updatedAt: true, description: true, descriptionMembersOnly: true, descriptionTitleOnly: true, descriptionTitleWords: true, trip: { select: { title: true, visibility: true } } },
  });
  for (const a of activities) {
    await pace();
    const words = a.trip.visibility !== "PUBLIC" ? titleHits(a.description!, [{ key: `trip:${a.tripId}`, title: a.trip.title }]).words : [];
    if (words.length && !a.descriptionMembersOnly) {
      result.descriptions += (await db.activity.updateMany({ where: { id: a.id, description: a.description, descriptionMembersOnly: false, descriptionSharedAt: null }, data: { descriptionMembersOnly: true, descriptionTitleOnly: true, descriptionTitleWords: words } })).count;
    } else if (!words.length && a.descriptionTitleOnly && (await titleWordsArePublic(a.descriptionTitleWords, [`trip:${a.tripId}`], privateWords)) && ![...spokenWords(a.description!)].some((w) => privateWords.has(w))) {
      const named = Boolean(names?.(a.description!));
      result.descriptions += (await db.activity.updateMany({ where: { id: a.id, updatedAt: a.updatedAt, descriptionTitleOnly: true }, data: named ? { descriptionTitleOnly: false, descriptionTitleWords: [] } : { descriptionMembersOnly: false, descriptionTitleOnly: false, descriptionTitleWords: [] } })).count;
    }
  }
  return result;
}

const add = (a: RejudgeResult, b: RejudgeResult): RejudgeResult => ({ photos: a.photos + b.photos, titles: a.titles + b.titles, unflagged: a.unflagged + b.unflagged, places: a.places + b.places, descriptions: a.descriptions + b.descriptions, missed: a.missed + b.missed, missedIds: [...(a.missedIds ?? []), ...(b.missedIds ?? [])] });

/** `person:<id>:<name>` → `person:<id>`, and → `<name>`. */
const keyOwner = (key: string) => key.split(":").slice(0, 2).join(":");
const keyName = (key: string) => key.split(":").slice(2).join(":");

/** Record names as judged: merged with what is recorded now, and only for people and members still in the album. */
async function recordJudged(keys: string[], extra: { membersOnlyMatcher?: string; membersOnlyJudgedAt?: Date } = {}): Promise<void> {
  const current = new Set((await knownNameEntries()).map((e) => e.key));
  const setting = await db.appSetting.findUnique({ where: { id: "app" }, select: { membersOnlyNames: true } });
  const merged = [...new Set([...(setting?.membersOnlyNames ?? []), ...keys])].filter((k) => current.has(k));
  const data = { membersOnlyNames: merged, ...extra };
  await db.appSetting.upsert({ where: { id: "app" }, create: { id: "app", ...data }, update: data });
}

/**
 * The sweep, run when the worker starts and every night: the whole album when the rules have changed since the last
 * one, otherwise the names it has not judged (a rename whose job could not be queued included), the trips and
 * collections changed since, and the photographs that joined a trip or collection since. Nothing is recorded while
 * any write missed, so the next sweep tries again.
 */
export async function rejudgeSweep(): Promise<RejudgeResult> {
  const started = new Date();
  const setting = await db.appSetting.findUnique({ where: { id: "app" }, select: { membersOnlyMatcher: true, membersOnlyNames: true, membersOnlyJudgedAt: true } });
  const entries = await knownNameEntries();
  const judged = new Set(setting?.membersOnlyNames ?? []);
  let result = empty();
  const full = setting?.membersOnlyMatcher !== MATCHER_VERSION;
  if (full) {
    result = add(await rejudgeNames(entries.map((e) => e.name)), await rejudgeTitles());
  } else {
    const fresh = entries.filter((e) => !judged.has(e.key));
    // Somebody renamed since: their old name is looked for too, in case the rename's own job never ran.
    const current = new Set(entries.map((e) => e.key));
    const previous = [...judged].filter((k) => !current.has(k) && entries.some((e) => keyOwner(e.key) === keyOwner(k))).map(keyName);
    const names = [...new Set([...fresh.map((e) => e.name), ...previous])];
    if (names.length) result = await rejudgeNames(names);
    const since = setting?.membersOnlyJudgedAt ?? new Date(0);
    const [trips, collections, moved] = await Promise.all([
      db.trip.findMany({ where: { updatedAt: { gt: since } }, select: { id: true } }),
      db.collection.findMany({ where: { updatedAt: { gt: since } }, select: { id: true } }),
      db.photo.findMany({ where: { containersChangedAt: { gt: since } }, select: { id: true } }),
    ]);
    for (const t of trips) result = add(result, await rejudgeTitles({ tripId: t.id }));
    for (const c of collections) result = add(result, await rejudgeTitles({ collectionId: c.id }));
    for (let i = 0; i < moved.length; i += BATCH) result = add(result, await rejudgeTitles({ photoIds: moved.slice(i, i + BATCH).map((p) => p.id) }));
  }
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
  const key = job.sweep ? "sweep" : job.tripId ? `trip:${job.tripId}` : job.collectionId ? `collection:${job.collectionId}` : job.names ? `names:${[...job.names].sort().join("|")}` : "all";
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

/** The job: the sweep, one trip's or collection's title words, the names given, or — with nothing given — all of it. */
export async function rejudgeText(job: RejudgeJob): Promise<RejudgeResult> {
  if (job.sweep) return rejudgeSweep();
  if (job.tripId || job.collectionId) return rejudgeTitles({ tripId: job.tripId, collectionId: job.collectionId });
  const result = await rejudgeNames(job.names);
  // A name is recorded as judged only once every write for it has landed; otherwise the next sweep tries again.
  if (job.names && !result.missed) {
    const asked = new Set(job.names);
    await recordJudged((await knownNameEntries()).filter((e) => asked.has(e.name)).map((e) => e.key));
  }
  if (job.names) return result;
  return add(result, await rejudgeTitles());
}

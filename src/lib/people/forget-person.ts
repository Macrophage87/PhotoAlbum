import { db } from "@/lib/db";
import { forgetNameInText, forgetQueuedFileNames, forgetRawAnswers, leftoverItems, matcherFor, memberTextCount, memberTextMentioning, photosInContainers, photosMentioning, recleanShared, taggedPhotoIds } from "./forget";
import { containerKey, forgetKeyState, hashPlainScopes, rememberForgotten } from "./tombstone";
import { isKinWord, isListedPlace, nameMatcher, notThePerson, type NameMatcher, type Neighbourhood } from "./scrub";
import { stampForget, withForgetLock } from "./names-changed";
import { dropRejudgeJobs, forgetJudgedNames } from "@/lib/annotation/rejudge";

/**
 * Opt a person out of recognition (see optOutPerson in src/app/people/actions.ts). Deletes their templates, clusters,
 * proposals and negative examples, takes their name out of everything the helper wrote, and, unless `keepName`,
 * deletes their faces and their record, keeping only hashes of their names (tombstone.ts). What members wrote by
 * hand is left as they wrote it, and listed for whoever asked (`byUserId`) or an admin.
 *
 * `later`: forgetting is paused for want of FORGET_KEY. Everything but remembering their names and deleting their
 * record is done now — they are switched off, and their name leaves the helper's text at once — and the rest when
 * the key is set (`completePendingForgets`).
 *
 * In an order that is safe to repeat: they are marked opted out first (so nothing proposes, names or indexes them
 * from that moment), then the text is scrubbed, and only then does anything get deleted — so a run cut short leaves
 * the faces that say where to scrub, and running it again finds the same photographs.
 */
/** Faces deleted per statement when somebody is forgotten. */
const FACE_BATCH = 2000;

export async function forgetPerson(personId: string, opts: { keepName: boolean; byUserId: string | null; later?: boolean; list?: boolean }): Promise<void> {
  const { keepName, later = false } = opts;
  const person = await db.person.findUniqueOrThrow({ where: { id: personId } });
  // One forget at a time, and while it runs no answer from the helper is stored at all (see withForgetLock), so none
  // can bring the name back while the photographs to scrub are still being found. Every step checks the lock is
  // still held: no forget goes on unlocked.
  await withForgetLock(async (held) => {
    await held.assertHeld();
    const now = new Date();
    await stampForget();
    // Switched off before anything is looked up: from here nothing proposes, names, confirms or indexes them (those
    // read this under a lock), so the photographs found below are all there will be.
    await db.person.update({
      where: { id: personId },
      // Pending until the record is gone, whether it waits for the key or not: a forget cut short anywhere (a lost
      // connection, a timeout) is finished by the pending-forget pass rather than left half done with the name on it.
      data: { faceIndexing: false, nameInDescriptions: false, pendingDecision: false, keepNameOnPhotos: keepName, optedOutAt: person.optedOutAt ?? now, faceIndexingSetAt: now, namingWithdrawnAt: null, ...(!keepName ? { forgetPendingAt: person.forgetPendingAt ?? now, forgetPendingById: person.forgetPendingById ?? opts.byUserId } : {}) },
    });
    const m = await matcherFor(person);
    // A first name that is a month is kept apart, with their own photographs only (see below).
    const forms = m.tombstoneForms.filter((f) => !f.month);
    const months = m.tombstoneForms.filter((f) => f.month);
    const tagged = await taggedPhotoIds(personId);
    // Photographs whose members' words name them too — their own, or their trip's, collection's or activity's: what
    // the helper wrote there was written from those words.
    const before = await memberTextMentioning(m, tagged, personId, Infinity);
    // A one-word name that is also a place ("Florence"): the album's Florence trip is no mention of her. Only her
    // own photographs, and those whose notes name her where the words around it do not make it the place.
    const place = isListedPlace(person.name);
    // Notes naming them ("Florence at the pool"): what the helper writes from them is about her. A name that is also
    // a place counts only where nothing says the place is meant (see notesNaming). A first name of a full one ("Sam"
    // of Sam Kent) is looked for only on their own photographs and where notes give the full name.
    const derived = forms.filter((f) => f.derived);
    const wholeOneWords = forms.filter((f) => !f.derived && !/\s/u.test(f.form));
    const placeLike = wholeOneWords.filter((f) => isListedPlace(f.form));
    const notedPlace = await notesNaming(placeLike.map((f) => f.form), true);
    const notedFull = await notesNamingInFull(m);
    // A first name of a full one, not on a photograph whose notes give somebody the album knows by it in full ("Sam
    // Kent and Sam Ortiz at the lake"): there it could be either.
    const derivedNoted = await withoutNamesakes(notedFull, derived.map((f) => f.form), personId);
    const notedOneWord = await notesNaming(wholeOneWords.filter((f) => !isListedPlace(f.form)).map((f) => f.form), false);
    const noted = [...new Set([...notedOneWord, ...notedPlace, ...notedFull])];
    // The photographs the album keeps her names with as hers (see rememberForgotten below): those she is tagged on,
    // and those whose notes plainly name her — in full with nobody of the same first name beside her, or by a
    // one-word name. On them her first name alone is hers, as on the photographs she is tagged on.
    const hers = new Set([...tagged, ...notedOneWord, ...notedPlace, ...derivedNoted]);
    const photoIds = [...new Set([...tagged, ...before.photos.map((p) => p.id), ...noted, ...(place ? [] : [...(await photosMentioning(m)), ...(await photosInContainers(before))])])];
    const containerIds = place ? [] : [...before.trips.map((t) => containerKey("trip", t.id)), ...before.collections.map((c) => containerKey("collection", c.id)), ...before.activities.map((a) => containerKey("activity", a.id))];
    await held.assertHeld();
    // Their names, hashed, outlive their record: see tombstone.ts. A one-word name is kept with the photographs,
    // trips, collections and activities that named them, the only place it is looked for. Stamped again once they
    // are remembered, so names read before are read again.
    if (!keepName && !later) {
      await held.assertHeld();
      // A one-word name that is also a place is kept only with her own photographs and the notes that plainly mean
      // her; any other with everything the forget went through.
      // A first name of a full one only with their own photographs and notes naming them in full.
      const placeForms = new Set(placeLike.map((f) => f.form));
      await rememberForgotten(forms.filter((f) => !f.derived && !placeForms.has(f.form)), { photoIds, taggedPhotoIds: tagged, containerIds });
      if (placeForms.size) await rememberForgotten(placeLike, { photoIds: notedPlace, taggedPhotoIds: tagged });
      if (derived.length) await rememberForgotten(derived, { photoIds: derivedNoted, taggedPhotoIds: tagged });
      // "May" or "June": only on the photographs they were tagged on, and only where it plainly names somebody.
      if (months.length) await rememberForgotten(months, { photoIds: tagged, taggedPhotoIds: tagged });
      await stampForget();
    }
    await held.assertHeld();
    await forgetNameInText(photoIds, m, { tagged: hers, personId, stamp: false });
    await forgetRawAnswers(m);
    await forgetQueuedFileNames(m);
    // What is left mentioning them is what members wrote (or the helper's trip descriptions, where only a name that
    // is also a word is left); it is listed so it can be edited by hand.
    const after = await memberTextMentioning(m, tagged, personId);
    // The list stays until an admin (or whoever forgot them) has seen to it: ids and fields, never the name. Made now,
    // before anything is deleted, and once per forget: one cut short before this makes it when the pending pass
    // finishes it, one cut short after does not make a second.
    if (!keepName && !person.forgetListedAt && opts.list !== false) {
      await db.$transaction([
        ...(memberTextCount(after) ? [db.forgetLeftover.create({ data: { items: leftoverItems(after), createdById: person.forgetPendingById ?? opts.byUserId } })] : []),
        db.person.update({ where: { id: personId }, data: { forgetListedAt: new Date() } }),
      ]);
    }
    await held.assertHeld();
    await db.faceCluster.deleteMany({ where: { personId } });
    await db.face.deleteMany({ where: { proposedPersonId: personId } });
    if (keepName || later) {
      // Waiting for the key, their tags stay (without templates) to say where to look once it is set.
      await db.$executeRaw`UPDATE "Face" SET embedding = NULL, "clusterId" = NULL WHERE "personId" = ${personId}`;
    } else {
      // Forgetting entirely also removes the person page; the record of who is in which photo goes with the faces,
      // a batch at a time (somebody can be on thousands), outside any transaction: a run cut short is finished by the
      // pending pass. Their names recorded as judged go with the record, rather than waiting in clear for the sweep.
      for (;;) {
        const gone = await db.$executeRaw`DELETE FROM "Face" WHERE id IN (SELECT id FROM "Face" WHERE "personId" = ${personId} LIMIT ${FACE_BATCH})`;
        if (gone < FACE_BATCH) break;
      }
      await db.$transaction(async (tx) => {
        await forgetJudgedNames(tx, `person:${personId}`);
        await tx.person.delete({ where: { id: personId } });
      }, { timeout: 30_000, maxWait: 10_000 });
    }
    // Photographs they shared with a namesake forgotten before them: cleaned again with every forgotten entry, now
    // that the record is gone and the name counts as nobody's here (see recleanShared).
    if (!keepName && !later) {
      await held.assertHeld();
      await recleanShared(tagged);
    }
    // Until the record was gone the remembered names still counted as somebody's: an answer asked for before now,
    // about any photograph, is thrown away, and names read before now are read again (see forgetState). No photograph
    // is stamped: which ones this forget covered is nobody's to read from the database.
    await held.assertHeld();
    await stampForget();
  });
  // Nor in the queue: judging jobs asked for them are dropped, finished ones included.
  if (!keepName && !later) await dropRejudgeJobs(personId, [person.name, ...person.formerNames]);
}

/** Forget everybody waiting on FORGET_KEY, once it is set. At start-up and overnight. */
export async function completePendingForgets(): Promise<number> {
  // And forgotten names kept before the photographs they cover were hashed: hashed now, under their own key.
  await hashPlainScopes().catch((err) => console.error("[forget] could not hash the places of forgotten names", err instanceof Error ? err.message : err));
  const waiting = await db.person.findMany({ where: { forgetPendingAt: { not: null } }, select: { id: true, forgetPendingById: true } });
  if (!waiting.length || !(await forgetKeyState()).write) return 0;
  // Their leftovers were listed when they asked, unless that run was cut short first (see forgetListedAt).
  for (const p of waiting) await forgetPerson(p.id, { keepName: false, byUserId: p.forgetPendingById });
  return waiting.length;
}

const TRIP_WORD_AFTER = /^[ \t]+(?:trip|trips|holiday|holidays|vacation|visit|getaway|weekend|skyline|day|days|\d)(?![\p{L}\p{M}])/iu;

/** The time of day, the weather or the light after a place: "Florence at night", "Florence in the rain". */
const SCENE_AFTER = /^[ \t]+(?:(?:at|by)[ \t]+(?:night|dusk|dawn|sunset|sunrise|twilight|midnight|daybreak)|in[ \t]+(?:the[ \t]+)?(?:rain|snow|fog|mist|drizzle|sun|sunshine)(?=[ \t]*(?:$|[\n.,;:!?)]|(?:and|with)(?![\p{L}\p{M}]))))(?![\p{L}\p{M}])/iu;
/**
 * Somebody in the scene after it: "at sunset with Grandpa", "at night with Olivia", "in the rain with her dad", "with
 * two friends", "with the whole family". Then the name before the scene is somebody too, not the city ("Florence at
 * sunset with Grandpa"). A capitalized word is somebody unless it is a place the album knows or a landmark's
 * ("with Santa Croce", "with Ponte Vecchio behind", "with Brunelleschi's dome", "with the Duomo lit up").
 */
const WITH_AFTER = /^[ \t]*,?[ \t]+with[ \t]+/iu;
/** Words before the one that says who or what: "the", "her", "two", "the whole", "all the". */
const DETERMINERS = /^(?:(?:the|a|an|her|his|their|our|my|some|two|three|four|five|several|many|both|all|whole|of|lots|few)[ \t]+)*/iu;
/** People, not things, after "with": "with friends", "with the cousins", "with her kids". */
const PEOPLE_NOUNS = new Set([
  "friends", "friend", "cousins", "cousin", "kids", "kid", "children", "child", "family", "parents", "grandparents", "grandkids", "grandchildren", "siblings",
  "sisters", "brothers", "classmates", "class", "team", "teammates", "neighbors", "neighbours", "girls", "boys", "folks", "relatives", "aunts",
  "uncles", "twins", "baby", "babies", "everyone", "everybody", "us", "them", "him", "her", "me", "gang", "crew", "group",
]);
/** A landmark's words: the first word of one ("Santa Croce", "Ponte Vecchio"), or a word after a name ("St. Mark's Basilica"). */
const LANDMARK_WORDS = new Set([
  "santa", "san", "st", "saint", "ponte", "piazza", "palazzo", "duomo", "basilica", "cathedral", "church", "chapel", "abbey", "tower", "bridge", "dome",
  "palace", "castle", "museum", "gallery", "fountain", "square", "garden", "gardens", "river", "lake", "hill", "hills", "mount", "skyline", "arena", "colosseum",
  "forum", "park", "harbour", "harbor", "bay", "beach", "cliffs", "falls", "valley", "vineyard", "vineyards", "market", "station", "street", "avenue",
]);

/** The time of day, the weather or the light after the place, with nobody in the scene: see SCENE_AFTER. */
function sceneOfThePlace(after: string): boolean {
  const scene = after.match(SCENE_AFTER);
  if (!scene) return false;
  const rest = after.slice(scene[0].length);
  const withWord = rest.match(WITH_AFTER);
  if (!withWord) return true;
  const phrase = rest.slice(withWord[0].length).replace(DETERMINERS, "");
  const [word, next] = (phrase.match(/[\p{L}][\p{L}\p{M}'’.-]*/gu) ?? []).map((w) => w.replace(/\.$/u, ""));
  if (!word) return true;
  const bareWord = word.replace(/['’]s$/u, "").toLowerCase();
  if (PEOPLE_NOUNS.has(bareWord) || isKinWord(word)) return false;
  if (!/^\p{Lu}/u.test(word)) return true;
  // A place or a landmark: "with Siena beyond", "with Santa Croce", "with Brunelleschi's dome", "with Uffizi Gallery".
  if (isListedPlace(word) || LANDMARK_WORDS.has(bareWord) || (next && LANDMARK_WORDS.has(next.toLowerCase()))) return true;
  return false;
}

/** Another place joined to it: "Florence and Siena", "Florence vs Rome", "Pisa to Florence". */
const JOINED_AFTER = /^[ \t]+(?:and|&|vs\.?|versus|or|to)[ \t]+(\p{Lu}[\p{L}\p{M}'’.-]*)/u;
const JOINED_BEFORE = /(\p{Lu}[\p{L}\p{M}'’.-]*)[ \t]+(?:and|&|vs\.?|versus|or|to)[ \t]+$/u;

/** Whether any mention of these words in a text is the place, by the rules given. */
function usedAsPlace(text: string | null | undefined, rx: RegExp, rules: Neighbourhood): boolean {
  if (!text) return false;
  return [...text.matchAll(rx)].some((m) => {
    const end = m.index! + m[0].length;
    const after = text.slice(end);
    const before = text.slice(0, m.index!);
    const joined = [after.match(JOINED_AFTER)?.[1], before.match(JOINED_BEFORE)?.[1]].some((w) => w && isListedPlace(w));
    return joined || sceneOfThePlace(after) || TRIP_WORD_AFTER.test(after) || notThePerson(text, m.index!, end, rules);
  });
}

/**
 * Photographs whose notes have one of these one-word names in them, written as a name. `places`: names that are also
 * places, where a photograph counts only if nothing says the place is meant:
 * - its trip's, activity's or collections' title or description uses it as one ("Florence 2019", "Trip to
 *   Florence", "Charlotte, NC 2020");
 * - its own place ("Florence, Tuscany") has it;
 * - the note itself uses it as one anywhere ("Arrived in Florence. Florence is hot.").
 * "Florence at the pool" on a photograph with none of these counts. ("Florence vs Rome" on a photograph with no
 * place in an "Italy 2019" trip still does.)
 */
async function notesNaming(words: string[], places: boolean): Promise<string[]> {
  if (!words.length) return [];
  const rows = await db.photo.findMany({
    where: { OR: words.map((w) => ({ context: { contains: w } })) },
    select: {
      id: true,
      context: true,
      placeName: true,
      placeEstimateName: true,
      trip: { select: { title: true, description: true } },
      activity: { select: { title: true, description: true } },
      collections: { select: { collection: { select: { title: true, description: true } } } },
    },
  });
  const alternatives = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const rx = new RegExp(`(?<![\\p{L}\\p{M}])(?:${alternatives})(?![\\p{L}\\p{M}])`, "gu");
  const anyCase = new RegExp(`(?<![\\p{L}\\p{M}])(?:${alternatives})(?![\\p{L}\\p{M}])`, "iu");
  return rows
    .filter((r) => {
      if (!r.context || ![...r.context.matchAll(rx)].length) return false;
      // Beside another capitalized word it is somebody else's name or a place's ("Santa Barbara Pier"), as in the
      // helper's text away from their photographs.
      if (!places) return [...r.context.matchAll(rx)].some((x) => !notThePerson(r.context!, x.index!, x.index! + x[0].length, {}));
      if ([r.placeName, r.placeEstimateName].some((t) => t && anyCase.test(t))) return false;
      const around = [r.trip, r.activity, ...r.collections.map((c) => c.collection)].flatMap((c) => (c ? [c.title, c.description] : []));
      if (around.some((t) => usedAsPlace(t, rx, { place: "wide", number: true }))) return false;
      return !usedAsPlace(r.context, rx, { place: "near", opening: "clear", number: true });
    })
    .map((r) => r.id);
}

/** Photographs whose notes give one of their full names ("Sam Kent"). */
async function notesNamingInFull(m: NameMatcher): Promise<string[]> {
  const fulls = m.tombstoneForms.filter((f) => !f.derived && /\s/u.test(f.form)).map((f) => f.form);
  if (!fulls.length) return [];
  const probe = (f: string) => [...f.split(/\s+/)].sort((a, b) => b.length - a.length)[0];
  const rows = await db.photo.findMany({ where: { OR: fulls.map((f) => ({ context: { contains: probe(f), mode: "insensitive" as const } })) }, select: { id: true, context: true } });
  return rows.filter((r) => m.mentions(r.context, { fullOnly: true })).map((r) => r.id);
}

/** Of these photographs, those whose notes name nobody else the album knows who shares one of these first names. */
async function withoutNamesakes(photoIds: string[], firstNames: string[], personId: string): Promise<string[]> {
  if (!photoIds.length || !firstNames.length) return photoIds;
  const words = new Set(firstNames.flatMap((f) => f.toLowerCase().split(/\s+/)));
  const namesakes = (await db.person.findMany({ where: { id: { not: personId } }, select: { name: true } })).map((p) => p.name).filter((n) => n.toLowerCase().split(/[\s-]+/).some((w) => words.has(w)));
  if (!namesakes.length) return photoIds;
  const rows = await db.photo.findMany({ where: { id: { in: photoIds } }, select: { id: true, context: true } });
  const mentions = (context: string | null) => namesakes.some((n) => nameMatcher([n]).mentions(context, { fullOnly: true }));
  return rows.filter((r) => !mentions(r.context)).map((r) => r.id);
}

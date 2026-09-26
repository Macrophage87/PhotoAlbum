import { db } from "@/lib/db";
import { forgetNameInText, matcherFor, memberTextMentioning, photosInContainers, photosMentioning, taggedPhotoIds } from "./forget";
import { containerKey, forgetKeyState, rememberForgotten } from "./tombstone";
import { isListedPlace } from "./scrub";
import { withForgetLock } from "./names-changed";

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
export async function forgetPerson(personId: string, opts: { keepName: boolean; byUserId: string | null; later?: boolean; list?: boolean }): Promise<void> {
  const { keepName, later = false } = opts;
  const person = await db.person.findUniqueOrThrow({ where: { id: personId } });
  // One forget at a time, and while it runs no answer from the helper is stored at all (see withForgetLock), so none
  // can bring the name back while the photographs to scrub are still being found. Every step checks the lock is
  // still held: no forget goes on unlocked.
  const left = await withForgetLock(async (held) => {
    await held.assertHeld();
    const now = new Date();
    await db.appSetting.upsert({ where: { id: "app" }, create: { id: "app", lastForgetAt: now }, update: { lastForgetAt: now } });
    const m = await matcherFor(person);
    const tagged = await taggedPhotoIds(personId);
    // Photographs whose members' words name them too — their own, or their trip's, collection's or activity's: what
    // the helper wrote there was written from those words.
    const before = await memberTextMentioning(m, tagged, personId, Infinity);
    // A one-word name that is also a place ("Florence"): the album's Florence trip is no mention of her. Only her
    // own photographs, and those whose notes name her where the words around it do not make it the place.
    const place = isListedPlace(person.name);
    // Notes naming them at all ("Florence at the pool"), whatever the words around it: what the helper writes from
    // them is about her.
    const noted = await notesNaming(m.tombstoneForms.map((f) => f.form).filter((f) => !/\s/u.test(f)));
    const photoIds = [...new Set([...tagged, ...before.photos.map((p) => p.id), ...noted, ...(place ? [] : [...(await photosMentioning(m)), ...(await photosInContainers(before))])])];
    const containerIds = place ? [] : [...before.trips.map((t) => containerKey("trip", t.id)), ...before.collections.map((c) => containerKey("collection", c.id)), ...before.activities.map((a) => containerKey("activity", a.id))];
    await held.assertHeld();
    await db.person.update({
      where: { id: personId },
      data: { faceIndexing: false, nameInDescriptions: false, pendingDecision: false, keepNameOnPhotos: keepName, optedOutAt: person.optedOutAt ?? now, faceIndexingSetAt: now, namingWithdrawnAt: null, ...(later ? { forgetPendingAt: person.forgetPendingAt ?? now, forgetPendingById: person.forgetPendingById ?? opts.byUserId } : {}) },
    });
    // Their names, hashed, outlive their record: see tombstone.ts. A one-word name is kept with the photographs,
    // trips, collections and activities that named them, the only place it is looked for. Stamped again once they
    // are remembered, so names read before are read again.
    if (!keepName && !later) {
      await held.assertHeld();
      await rememberForgotten(m.tombstoneForms, { photoIds, containerIds });
      await db.appSetting.update({ where: { id: "app" }, data: { lastForgetAt: new Date() } });
    }
    await held.assertHeld();
    await forgetNameInText(photoIds, m, { tagged, personId });
    // What is left mentioning them is what members wrote (or the helper's trip descriptions, where only a name that
    // is also a word is left); it is listed so it can be edited by hand.
    const after = await memberTextMentioning(m, tagged, personId);
    await held.assertHeld();
    await db.faceCluster.deleteMany({ where: { personId } });
    await db.face.deleteMany({ where: { proposedPersonId: personId } });
    if (keepName || later) {
      // Waiting for the key, their tags stay (without templates) to say where to look once it is set.
      await db.$executeRaw`UPDATE "Face" SET embedding = NULL, "clusterId" = NULL WHERE "personId" = ${personId}`;
    } else {
      await db.face.deleteMany({ where: { personId } });
      // Forgetting entirely also removes the person page; the record of who is in which photo went with the faces.
      await db.person.delete({ where: { id: personId } });
    }
    // Until the record was gone the remembered names still counted as somebody's: an answer asked for before now
    // about any of these photographs is thrown away, and names read before now are read again.
    await held.assertHeld();
    const settled = new Date();
    await db.photo.updateMany({ where: { id: { in: photoIds } }, data: { namesScrubbedAt: settled } });
    await db.appSetting.update({ where: { id: "app" }, data: { lastForgetAt: settled } });
    return after;
  });
  // The list stays until an admin (or whoever forgot them) has seen to it: ids and fields, never the name.
  const count = left.photos.length + left.trips.length + left.collections.length + left.activities.length;
  if (!keepName && count && opts.list !== false) {
    const items = { photos: left.photos.map((p) => ({ id: p.id, fields: p.fields })), trips: left.trips.map((t) => ({ slug: t.slug })), collections: left.collections.map((c) => ({ slug: c.slug })), activities: left.activities.map((x) => ({ id: x.id })) };
    await db.forgetLeftover.create({ data: { items, createdById: opts.byUserId } });
  }
}

/** Forget everybody waiting on FORGET_KEY, once it is set. At start-up and overnight. */
export async function completePendingForgets(): Promise<number> {
  const waiting = await db.person.findMany({ where: { forgetPendingAt: { not: null } }, select: { id: true, forgetPendingById: true } });
  if (!waiting.length || !(await forgetKeyState()).write) return 0;
  // Their leftovers were listed when they asked.
  for (const p of waiting) await forgetPerson(p.id, { keepName: false, byUserId: p.forgetPendingById, list: false });
  return waiting.length;
}

/** Photographs whose notes have one of these one-word names in them, written as a name. */
async function notesNaming(words: string[]): Promise<string[]> {
  if (!words.length) return [];
  const rows = await db.photo.findMany({ where: { OR: words.map((w) => ({ context: { contains: w } })) }, select: { id: true, context: true } });
  const rx = new RegExp(`(?<![\\p{L}\\p{M}])(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{M}])`, "u");
  return rows.filter((r) => r.context && rx.test(r.context)).map((r) => r.id);
}

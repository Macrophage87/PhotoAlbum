import { db } from "@/lib/db";
import { forgetNameInText, matcherFor, memberTextMentioning, photosInContainers, photosMentioning, taggedPhotoIds } from "./forget";
import { forgetKeyState, rememberForgotten } from "./tombstone";
import { withForgetLock } from "./names-changed";

/**
 * Opt a person out of recognition (see optOutPerson in src/app/people/actions.ts). Deletes their templates, clusters,
 * proposals and negative examples, takes their name out of everything the helper wrote, and, unless `keepName`,
 * deletes their faces and their record, keeping only hashes of their names (tombstone.ts). What members wrote by
 * hand is left as they wrote it, and listed for whoever asked (`byUserId`) or an admin.
 *
 * In an order that is safe to repeat: they are marked opted out first (so nothing proposes, names or indexes them
 * from that moment), then the text is scrubbed, and only then does anything get deleted — so a run cut short leaves
 * the faces that say where to scrub, and running it again finds the same photographs.
 */
export async function forgetPerson(personId: string, opts: { keepName: boolean; byUserId: string }): Promise<void> {
  const { keepName } = opts;
  const person = await db.person.findUniqueOrThrow({ where: { id: personId } });
  // One forget at a time, and while it runs no answer from the helper is stored at all (see withForgetLock), so none
  // can bring the name back while the photographs to scrub are still being found.
  const left = await withForgetLock(async (held) => {
    const now = new Date();
    await db.appSetting.upsert({ where: { id: "app" }, create: { id: "app", lastForgetAt: now }, update: { lastForgetAt: now } });
    const m = await matcherFor(person);
    const tagged = await taggedPhotoIds(personId);
    // Photographs whose members' words name them too — their own, or their trip's, collection's or activity's: what
    // the helper wrote there was written from those words.
    const before = await memberTextMentioning(m, tagged, personId, Infinity);
    const photoIds = [...new Set([...tagged, ...(await photosMentioning(m)), ...before.photos.map((p) => p.id), ...(await photosInContainers(before))])];
    await db.person.update({ where: { id: personId }, data: { faceIndexing: false, nameInDescriptions: false, pendingDecision: false, keepNameOnPhotos: keepName, optedOutAt: person.optedOutAt ?? now, faceIndexingSetAt: now, namingWithdrawnAt: null } });
    // Their names, hashed, outlive their record: see tombstone.ts. A one-word name is kept with the photographs they
    // were on, the only place it is looked for. Stamped again once they are remembered, so names read before are
    // read again.
    if (!keepName) await rememberForgotten(m.tombstoneForms, tagged);
    await db.appSetting.update({ where: { id: "app" }, data: { lastForgetAt: new Date() } });
    await forgetNameInText(photoIds, m, { tagged, personId });
    // What is left mentioning them is what members wrote (or the helper's trip descriptions, where only a name that
    // is also a word is left); it is listed so it can be edited by hand.
    const after = await memberTextMentioning(m, tagged, personId);
    await db.faceCluster.deleteMany({ where: { personId } });
    await db.face.deleteMany({ where: { proposedPersonId: personId } });
    if (keepName) {
      await db.$executeRaw`UPDATE "Face" SET embedding = NULL, "clusterId" = NULL WHERE "personId" = ${personId}`;
    } else {
      await db.face.deleteMany({ where: { personId } });
      // Forgetting entirely also removes the person page; the record of who is in which photo went with the faces.
      await db.person.delete({ where: { id: personId } });
    }
    // Until the record was gone the remembered names still counted as somebody's: an answer asked for before now
    // about any of these photographs is thrown away, and names read before now are read again. Only while the lock
    // is still held: no forget finishes unlocked.
    await held.assertHeld();
    const settled = new Date();
    await db.photo.updateMany({ where: { id: { in: photoIds } }, data: { namesScrubbedAt: settled } });
    await db.appSetting.update({ where: { id: "app" }, data: { lastForgetAt: settled } });
    return after;
  });
  // The list stays until an admin (or whoever forgot them) has seen to it: ids and fields, never the name.
  const count = left.photos.length + left.trips.length + left.collections.length + left.activities.length;
  if (!keepName && count) {
    const items = { photos: left.photos.map((p) => ({ id: p.id, fields: p.fields })), trips: left.trips.map((t) => ({ slug: t.slug })), collections: left.collections.map((c) => ({ slug: c.slug })), activities: left.activities.map((x) => ({ id: x.id })) };
    await db.forgetLeftover.create({ data: { items, createdById: opts.byUserId } });
  }
}

/**
 * Somebody asked to be forgotten while forgetting was paused for want of FORGET_KEY: nothing is recognised, proposed
 * or named of them from now on, and they are forgotten as soon as the key is set (`completePendingForgets`).
 */
export async function forgetLater(personId: string, byUserId: string): Promise<void> {
  const now = new Date();
  const person = await db.person.findUniqueOrThrow({ where: { id: personId }, select: { optedOutAt: true } });
  await db.person.update({ where: { id: personId }, data: { faceIndexing: false, nameInDescriptions: false, pendingDecision: false, optedOutAt: person.optedOutAt ?? now, faceIndexingSetAt: now, forgetPendingAt: now, forgetPendingById: byUserId } });
  await db.faceCluster.deleteMany({ where: { personId } });
  await db.face.deleteMany({ where: { proposedPersonId: personId } });
  await db.$executeRaw`UPDATE "Face" SET embedding = NULL, "clusterId" = NULL WHERE "personId" = ${personId}`;
}

/** Forget everybody waiting on FORGET_KEY, once it is set. At start-up and overnight. */
export async function completePendingForgets(): Promise<number> {
  const waiting = await db.person.findMany({ where: { forgetPendingAt: { not: null } }, select: { id: true, forgetPendingById: true } });
  if (!waiting.length || !(await forgetKeyState()).write) return 0;
  for (const p of waiting) await forgetPerson(p.id, { keepName: false, byUserId: p.forgetPendingById ?? "" });
  return waiting.length;
}

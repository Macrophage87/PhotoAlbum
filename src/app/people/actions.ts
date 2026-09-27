"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { claimAnimalsForPet, confirmAnimalAs, rejectAnimal, releaseAnimalsForPet } from "@/lib/pets/proposals";
import { enqueueAnimalMatchAllOpen } from "@/lib/jobs/handlers/detect-animals";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { canChangePerson, canEditMedia, NOT_YOUR_PERSON, NOT_YOURS } from "@/lib/auth/ownership";
import { knownAdult, nameMayLeaveServer, namingOutcome } from "@/lib/people/consent";
import { forgetNameEverywhere, forgetOnPhoto } from "@/lib/people/forget";
import { forgetKeyState, forgottenHashesOf } from "@/lib/people/tombstone";
import { forgetPerson } from "@/lib/people/forget-person";
import { ForgetBusyError, stampScrubbed } from "@/lib/people/names-changed";
import { enqueueFaceDetection, rebuildUnnamedCentroids } from "@/lib/jobs/handlers/detect-faces";
import { confirmFaceAs, rejectProposal } from "@/lib/people/matching";
import { rejudgeFromAction } from "@/lib/annotation/rejudge-notice";
import { forgetJudgedNames } from "@/lib/annotation/rejudge";

async function requireAdmin() {
  const user = await requireUserOrThrow();
  if (user.role !== "ADMIN") throw new Error("Admins only");
  return user;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().transform((v) => (v ? new Date(`${v}T00:00:00Z`) : null));

/** Set the templates of a person's faces and clusters to NULL, keeping rows, boxes and confirmations. */
async function nullTemplatesFor(personId: string, client: Prisma.TransactionClient = db) {
  // Groups (in id order) before faces, as leaveCluster and naming take them. Confirming a face and detection's
  // restore take a face before its era group, but only after the person's row FOR SHARE, which decideIndexing holds
  // FOR UPDATE before it gets here: they wait for it rather than cross it.
  await client.$executeRaw`UPDATE "FaceCluster" SET centroid = NULL WHERE id IN (SELECT id FROM "FaceCluster" WHERE "personId" = ${personId} ORDER BY id FOR UPDATE)`;
  await client.$executeRaw`UPDATE "Face" SET embedding = NULL WHERE "personId" = ${personId}`;
}

const nameSchema = z
  .object({
    // Optional, because joining these faces to somebody already named needs no name typed in — and requiring one
    // meant that choosing a known person threw instead of joining them, which is the whole of "link it to them".
    name: z.string().trim().max(80).optional().transform((v) => v || null),
    relationship: z.string().trim().max(80).optional().transform((v) => v || null),
    birthday: day,
    personId: z.string().optional().transform((v) => v || null),
  })
  .refine((v) => Boolean(v.personId || v.name), { message: "A name, or somebody already named", path: ["name"] });

/**
 * Name an unnamed cluster. Admins record the birthday and the indexing decision in the same step; members create the
 * person with indexing off and the cluster waits for an admin, unless they flag a child, which nulls it at once.
 *
 * Naming a face says who is in somebody's photograph, so it follows the photograph, as a hand tag does: a group
 * spread over several members' uploads is named only on this member's own, which leave it as a group of their own,
 * and the rest wait together for whoever uploaded them (or an admin). The group is locked while that is decided and
 * done, so a member carving their faces out, an admin naming the whole group and detection adding a face to it take
 * turns rather than each acting on what the group held before the others changed it.
 */
export async function nameCluster(clusterId: string, fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const byAdmin = user.role === "ADMIN";
  const v = nameSchema.parse({ name: fd.get("name") ?? undefined, relationship: fd.get("relationship") ?? undefined, birthday: fd.get("birthday") || undefined, personId: fd.get("personId") ?? undefined });
  const existing = v.personId ? await db.person.findUniqueOrThrow({ where: { id: v.personId } }) : null;
  if (existing?.optedOutAt) throw new Error("This person asked to be forgotten");
  const outcome = namingOutcome({
    byAdmin,
    wantIndexing: byAdmin && fd.get("faceIndexing") === "on",
    parentInstruction: byAdmin && fd.get("parentInstruction") === "on",
    birthday: v.birthday,
    attest: byAdmin && fd.get("attest") === "on",
    isChildFlag: !byAdmin && fd.get("isChild") === "on",
  });
  const now = new Date();

  const person = await retryOnDeadlock(() => db.$transaction(async (tx) => {
    // Somebody already named is read again, held until this commits: an admin switching their recognition off
    // meanwhile either comes first and is seen here, or waits and nulls what this attaches.
    const [known] = existing ? await tx.$queryRaw<{ faceIndexing: boolean; kind: string; forgetting: boolean }[]>`SELECT "faceIndexing", kind::text AS kind, ("optedOutAt" IS NOT NULL OR "forgetPendingAt" IS NOT NULL) AS forgetting FROM "Person" WHERE id = ${existing.id} FOR SHARE` : [];
    if (existing && !known) throw new Error("That person is no longer in the album");
    // Asked to be forgotten since the page was drawn: their faces are being taken away, not added to.
    if (known?.forgetting) throw new Error("This person asked to be forgotten");
    const cluster = await lockCluster(tx, clusterId);
    if (!cluster || cluster.personId) throw new Error("Cluster not found or already named");
    // Read under the lock: exactly the faces the group holds now, none of them named.
    const faces = await tx.face.findMany({ where: { clusterId, personId: null }, select: { id: true, photo: { select: { uploaderId: true } } } });
    const own = faces.filter((f) => canEditMedia(user, f.photo)).map((f) => f.id);
    if (!own.length) throw new Error(NOT_YOURS);
    // Locks are taken group, then faces, then photographs, the order every other writer of faces takes them in
    // (their writes reach the photograph through face_search_trigger); the faces in id order, so two namings of
    // groups that share none still never hold one each of a pair.
    await tx.$queryRaw`SELECT id FROM "Face" WHERE id = ANY(${own}) ORDER BY id FOR UPDATE`;
    const named = own.length === faces.length ? clusterId : await carveOut(tx, clusterId, own);
    const who =
      existing ??
      (await tx.person.create({
        data: {
          name: v.name!,
          relationship: v.relationship,
          birthday: v.birthday,
          faceIndexing: outcome.faceIndexing,
          faceIndexingSetById: byAdmin ? user.id : null,
          faceIndexingSetAt: byAdmin ? now : null,
          adultAttestedById: outcome.attested ? user.id : null,
          adultAttestedAt: outcome.attested ? now : null,
          pendingDecision: outcome.pendingDecision,
          createdById: user.id,
        },
      }));
    await tx.faceCluster.update({ where: { id: named }, data: { personId: who.id, label: who.name } });
    // Naming a face refreshes its photograph's search text (face_search_trigger), one photo at a time in whatever
    // order the faces come. Two groups named at once whose faces share photographs would each hold one the other
    // wants; taking the photographs first, in one order, makes the second wait instead.
    await tx.$queryRaw`SELECT p.id FROM "Photo" p WHERE p.id IN (SELECT "photoId" FROM "Face" WHERE id = ANY(${own})) ORDER BY p.id FOR NO KEY UPDATE`;
    // A face the album had proposed as somebody is now this person, and no longer proposed as anybody.
    await tx.face.updateMany({ where: { id: { in: own }, clusterId: named, personId: null }, data: { personId: who.id, status: "CONFIRMED", proposedPersonId: null } });
    // Templates nobody may match against go in the same commit as the name (a pet's always: it is spotted by the
    // animal detector), so a failure after it can never leave them: only the faces and the group just named, which
    // are locked already. The rest of somebody already named lost theirs when their recognition went off.
    const nullTemplates = known ? known.kind === "PET" || !known.faceIndexing : outcome.nullTemplates;
    if (nullTemplates) {
      await tx.$executeRaw`UPDATE "Face" SET embedding = NULL WHERE id = ANY(${own}) AND "personId" = ${who.id}`;
      await tx.$executeRaw`UPDATE "FaceCluster" SET centroid = NULL WHERE id = ${named}`;
    }
    return { ...who, nullTemplates };
  }));

  /**
   * A group of dogs is a group the detector was wrong about in a gentler way: those are faces, and they are the
   * family's dog, so the family should be able to say so. A pet has no consent to record and is never recognised by
   * face template (spotting works from the animal detector), so the templates go and the boxes stay — which is what
   * makes the chips on those photographs point at the pet.
   */
  if (existing?.kind === "PET") {
    // And, as before, anything of theirs a failed naming left behind.
    await nullTemplatesFor(existing.id);
    revalidatePath("/people", "layout");
    revalidatePath("/admin");
    return;
  }

  // Merging a group into somebody already named (another decade of the same face) follows that person's setting.
  // What the naming attached was nulled with it (by their setting as it stood then); this sweeps up anything of
  // theirs an earlier failure left.
  if (person.nullTemplates) await nullTemplatesFor(person.id);
  // A new name: what was written before it was known is judged again, in the background.
  if (!existing) await rejudgeFromAction({ people: [person.id] });
  revalidatePath("/people", "layout");
  revalidatePath("/admin");
}

/**
 * Run a transaction again, once, when the database chose it to break a deadlock: the other party has finished by
 * then. Should it happen twice, the member is told plainly rather than shown a database error.
 */
async function retryOnDeadlock<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isDeadlock(err)) throw err;
      if (attempt >= 2) throw new Error("Somebody else was naming faces on the same photos just then. Try again in a moment.");
    }
  }
}

function isDeadlock(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string } | null;
  return e?.code === "P2034" || e?.meta?.code === "40P01" || /\b40P01\b|deadlock detected/i.test(e?.message ?? "");
}

/**
 * Hold a group still for the rest of the transaction: naming it, taking faces out of it and detection adding to it
 * (see detectFacesJob) each wait for the others. Null when it is gone.
 */
async function lockCluster(tx: Prisma.TransactionClient, clusterId: string): Promise<{ personId: string | null } | null> {
  const [row] = await tx.$queryRaw<{ personId: string | null }[]>`SELECT "personId" FROM "FaceCluster" WHERE id = ${clusterId} FOR UPDATE`;
  return row ?? null;
}

/**
 * Move some of a locked group's faces into a group of their own and return it. Both centres are made again from the
 * faces each now holds, as the matcher's are: a copy of the old centre would carry the faces left behind, and the
 * first of them to be looked at would be proposed as whoever this group is named, as a perfect match.
 */
async function carveOut(tx: Prisma.TransactionClient, clusterId: string, faceIds: string[]): Promise<string> {
  const part = await tx.faceCluster.create({ data: { faceCount: faceIds.length }, select: { id: true } });
  await tx.face.updateMany({ where: { id: { in: faceIds }, clusterId }, data: { clusterId: part.id } });
  await rebuildUnnamedCentroids([part.id, clusterId], tx);
  return part.id;
}

/**
 * Whether this member may say who (or what) a face is: the photograph's uploader, and admins, as for a hand tag.
 * Throws otherwise.
 */
async function requireFaceEditor(faceId: string) {
  const user = await requireUserOrThrow();
  const face = await db.face.findUnique({ where: { id: faceId }, select: { id: true, clusterId: true, personId: true, proposedPersonId: true, photoId: true, photo: { select: { uploaderId: true } } } });
  // A re-scan of the photograph can remove a face between the page drawing it and the press.
  if (!face) throw new Error("That face has changed since the page was drawn");
  if (!canEditMedia(user, face.photo)) throw new Error(NOT_YOURS);
  return face;
}

/** The one-press version of naming: these faces are somebody already named, with nothing to fill in. */
export async function nameClusterAs(clusterId: string, personId: string): Promise<void> {
  const fd = new FormData();
  fd.set("personId", personId);
  await nameCluster(clusterId, fd);
}

/**
 * "That one is not them." One face leaves the group and becomes a group of its own, so naming the rest no longer
 * names it, and it can be named separately — or joined to whoever it really is.
 *
 * Relatives look alike, which is exactly when the album is most confident and most wrong, so this has to be one
 * press beside the face rather than a page of its own.
 */
export async function splitFaceFromCluster(faceId: string): Promise<void> {
  const face = await requireFaceEditor(faceId);
  if (face.personId) throw new Error("That face is already named");
  if (!face.clusterId) return;
  const from = face.clusterId;
  await db.$transaction(async (tx) => {
    // Named in the meantime, the face went with its group: it is taken off the person's page instead.
    if ((await lockCluster(tx, from))?.personId !== null) throw new Error("That face is already named");
    const alone = await tx.faceCluster.create({ data: { faceCount: 1 }, select: { id: true } });
    // The new group keeps this face's own template as its centre, so the matcher can still recognise it later.
    await tx.$executeRaw`UPDATE "FaceCluster" SET centroid = (SELECT embedding FROM "Face" WHERE id = ${faceId}) WHERE id = ${alone.id}`;
    const moved = await tx.face.updateMany({ where: { id: faceId, clusterId: from, personId: null }, data: { clusterId: alone.id } });
    if (!moved.count) throw new Error("That face has changed since the page was drawn; reload and try again");
    await settleCluster(tx, from);
  });
  revalidatePath("/people", "layout");
  revalidatePath(`/photos/${face.photoId}`);
}

/**
 * "That is not a face at all." Statues, portraits on the wall, the face on a cereal box: the detector finds them
 * and there is nobody there to name.
 *
 * The row stays, with its template dropped, because a re-scan of the photograph recognises the same spot and leaves
 * it alone — delete it and the statue is found again on the next pass, forever.
 */
export async function markNotAFace(faceId: string): Promise<void> {
  const face = await requireFaceEditor(faceId);
  if (face.personId) throw new Error("That face is named; remove the name first");
  await db.$transaction(async (tx) => {
    if (face.clusterId && (await lockCluster(tx, face.clusterId))?.personId) throw new Error("That face is named; remove the name first");
    const marked = await tx.face.updateMany({ where: { id: faceId, personId: null, clusterId: face.clusterId }, data: { status: "NOT_A_FACE", clusterId: null, proposedPersonId: null } });
    if (!marked.count) throw new Error("That face has changed since the page was drawn");
    await tx.$executeRaw`UPDATE "Face" SET embedding = NULL WHERE id = ${faceId}`;
    if (face.clusterId) await settleCluster(tx, face.clusterId);
  });
  revalidatePath("/people", "layout");
  revalidatePath(`/photos/${face.photoId}`);
}

/**
 * After a face has left a locked unnamed group: clear the group away when nothing is left in it, or make its count
 * and centre again from what is.
 */
async function settleCluster(tx: Prisma.TransactionClient, clusterId: string): Promise<void> {
  const left = await tx.face.count({ where: { clusterId } });
  if (left === 0) await tx.faceCluster.deleteMany({ where: { id: clusterId, personId: null } });
  else await rebuildUnnamedCentroids([clusterId], tx);
}

/** An admin's decision on a member-named cluster, or a change of a person's indexing switch. */
export async function decideIndexing(personId: string, fd: FormData): Promise<void> {
  const admin = await requireAdmin();
  const person = await db.person.findUniqueOrThrow({ where: { id: personId } });
  const birthday = day.parse(fd.get("birthday") || undefined) ?? person.birthday;
  const attest = fd.get("attest") === "on";
  // Someone who asked to be forgotten stays off unless the admin records that they have agreed again.
  const agreedAgain = fd.get("agreedAgain") === "on";
  const now = new Date();
  const named = nameMayLeaveServer(person);
  // Recognition off and the templates gone in one commit: never a person switched off who keeps them. Whether they
  // asked to be forgotten is read under the lock, so a switch-on racing a forget never turns them back on.
  const { after, outcome } = await db.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ optedOut: boolean; forgetting: boolean }[]>`SELECT "optedOutAt" IS NOT NULL AS "optedOut", "forgetPendingAt" IS NOT NULL AS forgetting FROM "Person" WHERE id = ${personId} FOR UPDATE`;
    if (!locked) throw new Error("That person is no longer in the album");
    const wantIndexing = fd.get("faceIndexing") === "on" && !locked.forgetting && (!locked.optedOut || agreedAgain);
    const outcome = namingOutcome({ byAdmin: true, wantIndexing, parentInstruction: fd.get("parentInstruction") === "on", birthday, attest, isChildFlag: false });
    const updated = await tx.person.update({
      where: { id: personId },
      data: {
        birthday,
        faceIndexing: outcome.faceIndexing,
        faceIndexingSetById: admin.id,
        faceIndexingSetAt: now,
        adultAttestedById: outcome.attested ? admin.id : person.adultAttestedById,
        adultAttestedAt: outcome.attested ? now : person.adultAttestedAt,
        pendingDecision: false,
        // Agreed again, and so no longer opted out: in the same commit as turning them on.
        ...(!outcome.nullTemplates && agreedAgain ? { optedOutAt: null } : {}),
      },
    });
    if (outcome.nullTemplates) await nullTemplatesFor(personId, tx);
    return { after: updated, outcome };
  });
  // No longer to be named (recognition off, or a birthday showing a child): what the helper wrote with the name goes.
  if (named && !nameMayLeaveServer(after)) await forgetNameEverywhere(after);
  // Evidence they are an adult, however it was recorded: a withdrawal the album made by itself for want of it no
  // longer needs to scrub anything. Naming stays off until an admin turns it back on.
  // Only evidence that was missing counts: a Recognition save for somebody whose naming was turned off before, with
  // evidence already on record, is no decision about naming, which only turning it back on is.
  if (!knownAdult(person) && knownAdult(after) && after.namingWithdrawnAt) await db.person.update({ where: { id: personId }, data: { namingWithdrawnAt: null } });
  if (!outcome.nullTemplates) {
    // Enabling later: templates of confirmed faces are recomputed by re-scanning their photos, then open faces are re-matched.
    const photos = await db.face.findMany({ where: { personId, status: "CONFIRMED" }, select: { photoId: true }, distinct: ["photoId"] });
    await db.photo.updateMany({ where: { id: { in: photos.map((p) => p.photoId) } }, data: { facesDetectedAt: null } });
    // The re-scan restores the templates and rebuilds this person's centroids, then proposes for open faces (detect-faces.ts).
    await enqueueFaceDetection(...photos.map((p) => p.photoId));
  }
  revalidatePath("/people", "layout");
  revalidatePath("/admin");
}

/**
 * Opt a person out of recognition. Deletes their templates, clusters, proposals and negative examples, takes their
 * name out of everything the helper wrote and out of the members' name index, and stops names reaching the helper.
 * By default their confirmed appearances go too; "keep my name on photos" keeps the non-biometric record only.
 * What members wrote by hand is left as they wrote it, and listed for them.
 *
 * Whoever added the person, or an admin: either way it rewrites text on other members' photographs, and the default
 * takes every tag of them off the album for good.
 *
 * In an order that is safe to repeat: they are marked opted out first (so nothing proposes, names or indexes them
 * from that moment), then the text is scrubbed, and only then does anything get deleted — so a run cut short leaves
 * the faces that say where to scrub, and running it again finds the same photographs.
 */
export async function optOutPerson(personId: string, fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const keepName = fd.get("mode") === "keep-name";
  const person = await db.person.findUniqueOrThrow({ where: { id: personId } });
  if (!canChangePerson(user, person)) throw new Error(NOT_YOUR_PERSON);
  // A pet has no face data to forget; it is removed with deletePerson, which gives its detections back.
  if (person.kind === "PET") throw new Error("A pet is removed, not forgotten");
  // Without a key to remember their names under, forgetting them would let the names come straight back: they are
  // switched off at once, and forgotten as soon as the key is set.
  const later = !keepName && !(await forgetKeyState()).write;
  try {
    await forgetPerson(personId, { keepName, byUserId: user.id, later });
  } catch (err) {
    // Another forget held the lock for too long: said plainly on the page, not as an error.
    if (err instanceof ForgetBusyError) redirect(`/people/${personId}?busy=1`);
    throw err;
  }
  revalidatePath("/people", "layout");
  revalidatePath("/admin");
  // Either way the page after it says what was done: the person page is gone after a full forget, so that goes to
  // the list of what is left to edit by hand.
  if (!keepName && !later) redirect("/people/forgotten?done=1");
  if (keepName) redirect(`/people/${personId}?forgot=face`);
}

/**
 * Allow a forgotten name again: one entry by its place in the list (nothing shown says what it is), or whichever
 * entry a name an admin types would be. For a name that turned out to be somebody else's too, or an everyday word.
 */
export async function allowForgottenName(hash: string): Promise<void> {
  await requireAdmin();
  await db.forgottenName.deleteMany({ where: { hash } });
  revalidatePath("/admin");
}

export async function allowForgottenNameTyped(fd: FormData): Promise<void> {
  await requireAdmin();
  const name = String(fd.get("name") ?? "").trim();
  const hashes = name ? await forgottenHashesOf(name) : [];
  if (hashes.length) await db.forgottenName.deleteMany({ where: { hash: { in: hashes } } });
  revalidatePath("/admin");
}

/** An admin has seen to a forget's leftovers list. */
export async function dismissForgetLeftover(id: string): Promise<void> {
  const user = await requireUserOrThrow();
  // Admins, or the member who forgot them: the list is theirs.
  const mine = user.role === "ADMIN" ? {} : { createdById: user.id };
  // What it listed goes with it: ids and fields only, but nothing is kept about a forgotten person that is not needed.
  await db.forgetLeftover.updateMany({ where: { id, dismissedAt: null, ...mine }, data: { dismissedAt: new Date(), dismissedById: user.id, items: {} } });
  revalidatePath("/people/forgotten");
  revalidatePath("/admin");
}

/** A rename keeps the old name on record: text the helper wrote under it still names them, and forgetting finds it. */
function withFormerName(person: { name: string; formerNames: string[] }, next: string): string[] {
  if (person.name === next) return person.formerNames;
  return [...new Set([...person.formerNames, person.name])].filter((n) => n !== next);
}

export async function updatePerson(personId: string, fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const person = await db.person.findUniqueOrThrow({ where: { id: personId }, select: { createdById: true, name: true, formerNames: true } });
  if (!canChangePerson(user, person)) throw new Error(NOT_YOUR_PERSON);
  const v = z.object({ name: z.string().trim().min(1).max(80), relationship: z.string().trim().max(80).transform((x) => x || null) }).parse({ name: fd.get("name"), relationship: fd.get("relationship") ?? "" });
  await db.person.update({ where: { id: personId }, data: { name: v.name, relationship: v.relationship, formerNames: withFormerName(person, v.name) } });
  // The old name as well: text written with it is still about them.
  if (person.name !== v.name) await rejudgeFromAction({ people: [personId] });
  revalidatePath("/people", "layout");
}

/** The admin's half of the detection gate, with who and when. */
export async function setFaceDetectionOptIn(on: boolean): Promise<void> {
  const admin = await requireAdmin();
  await db.appSetting.upsert({
    where: { id: "app" },
    create: { id: "app", faceDetectionOptInAt: on ? new Date() : null, faceDetectionOptInById: on ? admin.id : null },
    update: { faceDetectionOptInAt: on ? new Date() : null, faceDetectionOptInById: on ? admin.id : null },
  });
  revalidatePath("/admin");
  revalidatePath("/privacy");
}

/** Delete every face template, cluster and proposal; people and their names stay. */
export async function deleteAllFaceData(): Promise<void> {
  await requireAdmin();
  await db.face.deleteMany({});
  await db.faceCluster.deleteMany({});
  await db.photo.updateMany({ data: { facesDetectedAt: null } });
  await db.appSetting.upsert({ where: { id: "app" }, create: { id: "app", faceDataDeletedAt: new Date() }, update: { faceDataDeletedAt: new Date() } });
  revalidatePath("/people", "layout");
  revalidatePath("/admin");
}

/** A member confirms a proposal ("Probably Grandma Jo?"). */
export async function confirmProposal(faceId: string): Promise<void> {
  const user = await requireUserOrThrow();
  // Animal proposals share the list with face proposals under an `animal:` id.
  if (faceId.startsWith("animal:")) {
    const a = await db.animalDetection.findUniqueOrThrow({ where: { id: faceId.slice(7) }, select: { proposedPersonId: true, photoId: true, photo: { select: { uploaderId: true } } } });
    // Saying yes tags the pet on the photograph, which is its uploader's (or an admin's) to do, as tagPet is.
    if (!canEditMedia(user, a.photo)) throw new Error(NOT_YOURS);
    if (!a.proposedPersonId) throw new Error("Nothing proposed for this animal");
    await confirmAnimalAs(faceId.slice(7), a.proposedPersonId);
    await enqueueAnimalMatchAllOpen();
    revalidatePath(`/photos/${a.photoId}`);
    revalidatePath("/review");
    revalidatePath("/people", "layout");
    return;
  }
  const face = await requireFaceEditor(faceId);
  if (!face.proposedPersonId) throw new Error("Nothing proposed for this face");
  await confirmFaceAs(faceId, face.proposedPersonId);
  // Saying yes to a pet named in the notes also claims that photo's detected animals of its kind.
  const who = await db.person.findUnique({ where: { id: face.proposedPersonId }, select: { kind: true } });
  if (who?.kind === "PET" && (await claimAnimalsForPet(face.photoId, face.proposedPersonId)) > 0) await enqueueAnimalMatchAllOpen();
  revalidatePath(`/photos/${face.photoId}`);
  revalidatePath("/review");
  revalidatePath("/people", "layout");
}

/** A member rejects a proposal; the face stays unnamed and counts against that person from now on. */
export async function rejectProposalAction(faceId: string): Promise<void> {
  const user = await requireUserOrThrow();
  // "No" is as much an answer about who is in the photograph as "yes", so it is the same people's to give.
  if (faceId.startsWith("animal:")) {
    const a = await db.animalDetection.findUniqueOrThrow({ where: { id: faceId.slice(7) }, select: { photoId: true, photo: { select: { uploaderId: true } } } });
    if (!canEditMedia(user, a.photo)) throw new Error(NOT_YOURS);
    await rejectAnimal(faceId.slice(7));
    revalidatePath(`/photos/${a.photoId}`);
    revalidatePath("/review");
    return;
  }
  const face = await requireFaceEditor(faceId);
  await rejectProposal(faceId);
  revalidatePath(`/photos/${face.photoId}`);
  revalidatePath("/review");
}

/** Name one unnamed face by hand (a person with no era cluster near enough, or a face the matcher missed). */
export async function nameFace(faceId: string, personId: string): Promise<void> {
  // Tagging by hand and naming a found face say the same thing about the photograph, so the same people may.
  const face = await requireFaceEditor(faceId);
  if (face.personId) throw new Error("Already named");
  const target = await db.person.findUniqueOrThrow({ where: { id: personId }, select: { optedOutAt: true } });
  if (target.optedOutAt) throw new Error("This person asked to be forgotten");
  await confirmFaceAs(faceId, personId);
  revalidatePath(`/photos/${face.photoId}`);
  revalidatePath("/people", "layout");
}

const boxSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0.01).max(1), z.number().min(0.01).max(1)]);

/**
 * Tag somebody on a photograph by hand, where they are in it.
 *
 * This is a note about who is in a picture, not a biometric record: the row carries the box the member drew, no
 * template and no confidence, exactly as a pet tag does. The album's face detector misses people in profile, in
 * the dark, at the back, and turns of the century before it existed at all; the family knows anyway.
 *
 * Naming somebody new this way creates them with nothing switched on — no recognition, no naming in descriptions —
 * because those are an admin's decisions and this is a caption.
 */
export async function tagPersonAt(photoId: string, fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  // Tagging is done on an item's own page, so it follows the item: its uploader, and admins.
  const owner = await db.photo.findUnique({ where: { id: photoId }, select: { uploaderId: true } });
  if (!owner) throw new Error("No such item");
  if (!canEditMedia(user, owner)) throw new Error(NOT_YOURS);
  const v = z
    .object({ personId: z.string().optional().transform((x) => x || null), name: z.string().trim().max(80).optional().transform((x) => x || null), box: z.string() })
    .refine((x) => Boolean(x.personId || x.name), { message: "Somebody to tag", path: ["name"] })
    .parse({ personId: fd.get("personId") ?? undefined, name: fd.get("name") ?? undefined, box: fd.get("box") ?? "" });
  const box = boxSchema.parse(JSON.parse(v.box));

  const person = v.personId
    ? await db.person.findUniqueOrThrow({ where: { id: v.personId } })
    : await db.person.create({ data: { name: v.name!, kind: "HUMAN", createdById: user.id } });
  if (!v.personId) await rejudgeFromAction({ people: [person.id] });
  // Whether they asked to be forgotten is read under a lock until the tag is written, as confirming a face reads it:
  // a forget that has begun is not tagged onto a photograph it never looked at.
  await db.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ forgetting: boolean }[]>`SELECT ("optedOutAt" IS NOT NULL OR "forgetPendingAt" IS NOT NULL) AS forgetting FROM "Person" WHERE id = ${person.id} FOR SHARE`;
    if (!locked) throw new Error("That person is no longer in the album");
    if (locked.forgetting) throw new Error("This person asked to be forgotten");
    // One tag per person per photograph: tagging somebody twice moves their box rather than stacking another.
    const already = await tx.face.findFirst({ where: { photoId, personId: person.id, confidence: 0 }, select: { id: true } });
    if (already) await tx.face.update({ where: { id: already.id }, data: { box } });
    else await tx.face.create({ data: { photoId, personId: person.id, status: "CONFIRMED", box, confidence: 0 } });
  });
  if (person.kind === "PET" && (await claimAnimalsForPet(photoId, person.id)) > 0) await enqueueAnimalMatchAllOpen();
  revalidatePath(`/photos/${photoId}`);
  revalidatePath("/people", "layout");
}

/** Take a hand tag off a photograph, leaving anything the detector found alone. */
export async function untagPersonAt(faceId: string): Promise<void> {
  const user = await requireUserOrThrow();
  const face = await db.face.findUniqueOrThrow({ where: { id: faceId }, select: { photoId: true, personId: true, confidence: true, photo: { select: { uploaderId: true } } } });
  if (!canEditMedia(user, face.photo)) throw new Error(NOT_YOURS);
  if (face.confidence !== 0) throw new Error("That one was found by the album; remove the name from the chip instead");
  await db.face.delete({ where: { id: faceId } });
  if (face.personId) await forgetIfNoLongerOn(face.photoId, face.personId);
  revalidatePath(`/photos/${face.photoId}`);
  revalidatePath("/people", "layout");
}

/**
 * An admin records that this person is happy to be named in the descriptions the helper writes.
 *
 * Only for somebody the album knows to be an adult — a birthday showing 18 or older, or the adult attestation —
 * because a child is never named, and a person with no birthday on record may well be one: tagging a six-year-old
 * by hand records no birthday at all.
 */
export async function setNameInDescriptions(personId: string, on: boolean): Promise<void> {
  const admin = await requireAdmin();
  const person = await db.person.findUniqueOrThrow({ where: { id: personId } });
  if (on && person.optedOutAt) throw new Error("This person asked to be forgotten");
  if (on && !knownAdult(person)) throw new Error("Record a birthday showing an adult, or the adult attestation, before naming them");
  const after = await db.person.update({ where: { id: personId }, data: { nameInDescriptions: on, nameInDescriptionsSetById: admin.id, nameInDescriptionsSetAt: new Date(), ...(on ? { namingWithdrawnAt: null } : {}) } });
  // Withdrawn: what the helper already wrote with the name goes too, not only what it will write.
  if (nameMayLeaveServer(person) && !nameMayLeaveServer(after)) await forgetNameEverywhere(after);
  revalidatePath("/people", "layout");
  revalidatePath("/privacy");
}

/**
 * The evidence naming needs, recorded where naming is decided: a birthday, or an admin's word that this person is
 * an adult. Separate from recognition, whose own switch is still an admin's separate decision; this only says how
 * old they are. With it in place, naming is turned on in the same step.
 */
export async function recordAdultAndName(personId: string, fd: FormData): Promise<void> {
  const admin = await requireAdmin();
  const person = await db.person.findUniqueOrThrow({ where: { id: personId } });
  if (person.optedOutAt) throw new Error("This person asked to be forgotten");
  const birthday = day.parse(fd.get("birthday") || undefined) ?? person.birthday;
  const attest = !birthday && fd.get("attestAdult") === "on";
  const now = new Date();
  const evidence = { birthday, adultAttestedAt: person.adultAttestedAt, adultConfirmedAt: attest ? now : person.adultConfirmedAt };
  if (!knownAdult(evidence)) throw new Error("A birthday showing 18 or older, or the confirmation that they are an adult, is needed to name them");
  await db.person.update({
    where: { id: personId },
    data: { birthday, ...(attest ? { adultConfirmedAt: now, adultConfirmedById: admin.id } : {}), nameInDescriptions: true, nameInDescriptionsSetById: admin.id, nameInDescriptionsSetAt: now, namingWithdrawnAt: null },
  });
  revalidatePath("/people", "layout");
  revalidatePath("/privacy");
}

/**
 * An admin's answer to a naming the album switched off by itself: take the names out of the helper's text now
 * rather than at the end of the fortnight. (The other answer is to record a birthday or an adult confirmation.)
 */
export async function scrubWithdrawnNow(personId: string): Promise<void> {
  await requireAdmin();
  const person = await db.person.findUniqueOrThrow({ where: { id: personId }, select: { id: true, name: true, formerNames: true, namingWithdrawnAt: true } });
  if (!person.namingWithdrawnAt) return;
  await forgetNameEverywhere(person);
  await db.person.update({ where: { id: personId }, data: { namingWithdrawnAt: null } });
  revalidatePath("/people", "layout");
  revalidatePath("/admin");
}

/**
 * Somebody taken off a photograph was named in what the helper wrote about it because they were on it; the name
 * goes from that one item's machine-written text, unless they are still on it some other way.
 */
async function forgetIfNoLongerOn(photoId: string, personId: string): Promise<void> {
  const [face, animal] = await Promise.all([
    db.face.findFirst({ where: { photoId, personId, status: "CONFIRMED" }, select: { id: true } }),
    db.animalDetection.findFirst({ where: { photoId, personId, status: "CONFIRMED" }, select: { id: true } }),
  ]);
  if (face || animal) return;
  const person = await db.person.findUnique({ where: { id: personId }, select: { id: true, name: true, formerNames: true } });
  if (person) await forgetOnPhoto(photoId, person);
  else await stampScrubbed([photoId]);
}

const petSchema = z.object({
  name: z.string().trim().min(1).max(80),
  species: z.enum(["DOG", "CAT", "CHICKEN", "HORSE", "OTHER"]),
  livedFrom: day,
  livedTo: day,
  isFlock: z.boolean(),
  descriptors: z.string().trim().max(200).optional().transform((v) => v || null),
});

/** Pets have no consent settings: a record with species and lifespan, or a flock record for a species nobody tells apart. */
export async function createPet(fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const v = petSchema.parse({ name: fd.get("name"), species: fd.get("species"), livedFrom: fd.get("livedFrom") || undefined, livedTo: fd.get("livedTo") || undefined, isFlock: fd.get("isFlock") === "on", descriptors: fd.get("descriptors") ?? undefined });
  const pet = await db.person.create({ data: { kind: "PET", name: v.name, species: v.species, livedFrom: v.livedFrom, livedTo: v.livedTo, isFlock: v.isFlock, descriptors: v.descriptors, createdById: user.id } });
  await rejudgeFromAction({ people: [pet.id] });
  revalidatePath("/people", "layout");
}

export async function updatePet(personId: string, fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const pet = await db.person.findUniqueOrThrow({ where: { id: personId }, select: { createdById: true, name: true, formerNames: true } });
  if (!canChangePerson(user, pet)) throw new Error(NOT_YOUR_PERSON);
  const v = petSchema.parse({ name: fd.get("name"), species: fd.get("species"), livedFrom: fd.get("livedFrom") || undefined, livedTo: fd.get("livedTo") || undefined, isFlock: fd.get("isFlock") === "on", descriptors: fd.get("descriptors") ?? undefined });
  await db.person.update({ where: { id: personId, kind: "PET" }, data: { name: v.name, formerNames: withFormerName(pet, v.name), species: v.species, livedFrom: v.livedFrom, livedTo: v.livedTo, isFlock: v.isFlock, descriptors: v.descriptors } });
  // The old name as well: text written with it is still about them.
  if (pet.name !== v.name) await rejudgeFromAction({ people: [personId] });
  revalidatePath("/people", "layout");
}

/**
 * Tag a pet on a photo by hand (from the lightbox or the photo page). Pets are not detected, so the appearance is a
 * whole-image record: a Face row with a full box, no confidence and no template.
 */
export async function tagPet(photoId: string, personId: string): Promise<void> {
  const user = await requireUserOrThrow();
  // Tagging is done on an item's own page, so it follows the item: its uploader, and admins.
  const owner = await db.photo.findUnique({ where: { id: photoId }, select: { uploaderId: true } });
  if (!owner) return;
  if (!canEditMedia(user, owner)) throw new Error(NOT_YOURS);
  const pet = await db.person.findUniqueOrThrow({ where: { id: personId }, select: { kind: true } });
  if (pet.kind !== "PET") throw new Error("Not a pet");
  const existing = await db.face.findFirst({ where: { photoId, personId, status: "CONFIRMED" }, select: { id: true } });
  if (!existing) await db.face.create({ data: { photoId, personId, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
  // The tag also claims this photo's detected animals of the pet's kind, which is what teaches the matcher its look.
  if ((await claimAnimalsForPet(photoId, personId)) > 0) await enqueueAnimalMatchAllOpen();
  revalidatePath(`/photos/${photoId}`);
  revalidatePath("/people", "layout");
}

export async function untagPerson(photoId: string, personId: string): Promise<void> {
  const user = await requireUserOrThrow();
  // Tagging is done on an item's own page, so it follows the item: its uploader, and admins.
  const owner = await db.photo.findUnique({ where: { id: photoId }, select: { uploaderId: true } });
  if (!owner) return;
  if (!canEditMedia(user, owner)) throw new Error(NOT_YOURS);
  await db.face.deleteMany({ where: { photoId, personId, confidence: 0 } });
  await db.face.updateMany({ where: { photoId, personId, confidence: { gt: 0 } }, data: { personId: null, status: "REJECTED", proposedPersonId: personId, clusterId: null } });
  await releaseAnimalsForPet(photoId, personId);
  await forgetIfNoLongerOn(photoId, personId);
  revalidatePath(`/photos/${photoId}`);
  revalidatePath("/people", "layout");
}

/** Remove a pet record and its tags. People go through optOutPerson, which handles their templates. */
export async function deletePerson(personId: string): Promise<void> {
  await requireAdmin();
  // Its detections go back to being unclaimed animals rather than confirmed rows pointing at nobody.
  await db.animalDetection.updateMany({ where: { OR: [{ personId }, { proposedPersonId: personId }] }, data: { personId: null, proposedPersonId: null, status: "DETECTED" } });
  // Its judged names go with the record. Judging jobs queued for it carry only its id, which finds nothing once it
  // is gone; one queued before jobs carried ids holds the name until the next sweep clears it (dropLegacyRejudgeJobs).
  await db.$transaction(async (tx) => {
    await forgetJudgedNames(tx, `person:${personId}`);
    await tx.person.delete({ where: { id: personId, kind: "PET" } });
  });
  revalidatePath("/people", "layout");
  redirect("/people");
}

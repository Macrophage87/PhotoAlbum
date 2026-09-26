"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { claimAnimalsForPet, confirmAnimalAs, rejectAnimal, releaseAnimalsForPet } from "@/lib/pets/proposals";
import { enqueueAnimalMatchAllOpen } from "@/lib/jobs/handlers/detect-animals";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { canChangePerson, canEditMedia, NOT_YOUR_PERSON, NOT_YOURS } from "@/lib/auth/ownership";
import { knownAdult, nameMayLeaveServer, namingOutcome } from "@/lib/people/consent";
import { forgetNameEverywhere, forgetNameInText, forgetOnPhoto, matcherFor, memberTextMentioning, photosMentioning, taggedPhotoIds } from "@/lib/people/forget";
import { rememberForgotten } from "@/lib/people/tombstone";
import { enqueueFaceDetection } from "@/lib/jobs/handlers/detect-faces";
import { confirmFaceAs, rejectProposal } from "@/lib/people/matching";
import { rejudgeFromAction } from "@/lib/annotation/rejudge-notice";

async function requireAdmin() {
  const user = await requireUserOrThrow();
  if (user.role !== "ADMIN") throw new Error("Admins only");
  return user;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().transform((v) => (v ? new Date(`${v}T00:00:00Z`) : null));

/** Set the templates of a person's faces and clusters to NULL, keeping rows, boxes and confirmations. */
async function nullTemplatesFor(personId: string) {
  await db.$executeRaw`UPDATE "Face" SET embedding = NULL WHERE "personId" = ${personId}`;
  await db.$executeRaw`UPDATE "FaceCluster" SET centroid = NULL WHERE "personId" = ${personId}`;
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
 */
export async function nameCluster(clusterId: string, fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const byAdmin = user.role === "ADMIN";
  const v = nameSchema.parse({ name: fd.get("name") ?? undefined, relationship: fd.get("relationship") ?? undefined, birthday: fd.get("birthday") || undefined, personId: fd.get("personId") ?? undefined });
  const cluster = await db.faceCluster.findUnique({ where: { id: clusterId }, select: { id: true, personId: true } });
  if (!cluster || cluster.personId) throw new Error("Cluster not found or already named");
  const existing = v.personId ? await db.person.findUniqueOrThrow({ where: { id: v.personId } }) : null;
  if (existing?.optedOutAt) throw new Error("This person asked to be forgotten");

  /**
   * A group of dogs is a group the detector was wrong about in a gentler way: those are faces, and they are the
   * family's dog, so the family should be able to say so. A pet has no consent to record and is never recognised by
   * face template (spotting works from the animal detector), so the templates go and the boxes stay — which is what
   * makes the chips on those photographs point at the pet.
   */
  if (existing?.kind === "PET") {
    await db.faceCluster.update({ where: { id: clusterId }, data: { personId: existing.id, label: existing.name } });
    await db.face.updateMany({ where: { clusterId }, data: { personId: existing.id, status: "CONFIRMED" } });
    await nullTemplatesFor(existing.id);
    revalidatePath("/people", "layout");
    revalidatePath("/admin");
    return;
  }

  const outcome = namingOutcome({
    byAdmin,
    wantIndexing: byAdmin && fd.get("faceIndexing") === "on",
    parentInstruction: byAdmin && fd.get("parentInstruction") === "on",
    birthday: v.birthday,
    attest: byAdmin && fd.get("attest") === "on",
    isChildFlag: !byAdmin && fd.get("isChild") === "on",
  });
  const now = new Date();
  const person =
    existing ??
    (await db.person.create({
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
  // Merging a group into somebody already named (another decade of the same face) follows that person's setting.
  const effective = existing ? { faceIndexing: existing.faceIndexing, nullTemplates: !existing.faceIndexing, pendingDecision: existing.pendingDecision } : outcome;
  await db.faceCluster.update({ where: { id: clusterId }, data: { personId: person.id, label: person.name } });
  await db.face.updateMany({ where: { clusterId }, data: { personId: person.id, status: "CONFIRMED" } });
  if (effective.nullTemplates) await nullTemplatesFor(person.id);
  // A new name: what was written before it was known is judged again, in the background.
  if (!existing) await rejudgeFromAction({ names: [person.name] });
  revalidatePath("/people", "layout");
  revalidatePath("/admin");
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
  await requireUserOrThrow();
  const face = await db.face.findUniqueOrThrow({ where: { id: faceId }, select: { id: true, clusterId: true, personId: true, photoId: true } });
  if (face.personId) throw new Error("That face is already named");
  if (!face.clusterId) return;
  const alone = await db.faceCluster.create({ data: { faceCount: 1 }, select: { id: true } });
  // The new group keeps this face's own template as its centre, so the matcher can still recognise it later.
  await db.$executeRaw`UPDATE "FaceCluster" SET centroid = (SELECT embedding FROM "Face" WHERE id = ${faceId}) WHERE id = ${alone.id}`;
  const from = face.clusterId;
  await db.face.update({ where: { id: faceId }, data: { clusterId: alone.id } });
  await recountCluster(from);
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
  await requireUserOrThrow();
  const face = await db.face.findUniqueOrThrow({ where: { id: faceId }, select: { id: true, clusterId: true, personId: true, photoId: true } });
  if (face.personId) throw new Error("That face is named; remove the name first");
  await db.face.update({ where: { id: faceId }, data: { status: "NOT_A_FACE", clusterId: null, proposedPersonId: null } });
  await db.$executeRaw`UPDATE "Face" SET embedding = NULL WHERE id = ${faceId}`;
  if (face.clusterId) await recountCluster(face.clusterId);
  revalidatePath("/people", "layout");
  revalidatePath(`/photos/${face.photoId}`);
}

/** Keep a group's count honest after a face leaves it, and clear away a group with nothing left in it. */
async function recountCluster(clusterId: string): Promise<void> {
  const left = await db.face.count({ where: { clusterId } });
  if (left === 0) await db.faceCluster.deleteMany({ where: { id: clusterId, personId: null } });
  else await db.faceCluster.update({ where: { id: clusterId }, data: { faceCount: left } });
}

/** An admin's decision on a member-named cluster, or a change of a person's indexing switch. */
export async function decideIndexing(personId: string, fd: FormData): Promise<void> {
  const admin = await requireAdmin();
  const person = await db.person.findUniqueOrThrow({ where: { id: personId } });
  const birthday = day.parse(fd.get("birthday") || undefined) ?? person.birthday;
  const attest = fd.get("attest") === "on";
  // Someone who asked to be forgotten stays off unless the admin records that they have agreed again.
  const agreedAgain = fd.get("agreedAgain") === "on";
  const wantIndexing = fd.get("faceIndexing") === "on" && (!person.optedOutAt || agreedAgain);
  const outcome = namingOutcome({ byAdmin: true, wantIndexing, parentInstruction: fd.get("parentInstruction") === "on", birthday, attest, isChildFlag: false });
  const now = new Date();
  const named = nameMayLeaveServer(person);
  const after = await db.person.update({
    where: { id: personId },
    data: {
      birthday,
      faceIndexing: outcome.faceIndexing,
      faceIndexingSetById: admin.id,
      faceIndexingSetAt: now,
      adultAttestedById: outcome.attested ? admin.id : person.adultAttestedById,
      adultAttestedAt: outcome.attested ? now : person.adultAttestedAt,
      pendingDecision: false,
    },
  });
  // No longer to be named (recognition off, or a birthday showing a child): what the helper wrote with the name goes.
  if (named && !nameMayLeaveServer(after)) await forgetNameEverywhere(after);
  // Evidence they are an adult, however it was recorded: a withdrawal the album made by itself for want of it no
  // longer needs to scrub anything. Naming stays off until an admin turns it back on.
  if (knownAdult(after) && after.namingWithdrawnAt) await db.person.update({ where: { id: personId }, data: { namingWithdrawnAt: null } });
  if (outcome.nullTemplates) await nullTemplatesFor(personId);
  else {
    // Enabling later: templates of confirmed faces are recomputed by re-scanning their photos, then open faces are re-matched.
    const photos = await db.face.findMany({ where: { personId, status: "CONFIRMED" }, select: { photoId: true }, distinct: ["photoId"] });
    await db.photo.updateMany({ where: { id: { in: photos.map((p) => p.photoId) } }, data: { facesDetectedAt: null } });
    if (agreedAgain) await db.person.update({ where: { id: personId }, data: { optedOutAt: null } });
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
  const m = await matcherFor(person);
  const tagged = await taggedPhotoIds(personId);
  const photoIds = [...new Set([...tagged, ...(await photosMentioning(m))])];
  const now = new Date();
  // First, so every answer from the helper to a request built before now is thrown away, whoever it is about.
  await db.appSetting.upsert({ where: { id: "app" }, create: { id: "app", lastForgetAt: now }, update: { lastForgetAt: now } });
  await db.person.update({ where: { id: personId }, data: { faceIndexing: false, nameInDescriptions: false, pendingDecision: false, keepNameOnPhotos: keepName, optedOutAt: person.optedOutAt ?? now, faceIndexingSetAt: now, namingWithdrawnAt: null } });
  await forgetNameInText(photoIds, m, { tagged, personId });
  // What is left mentioning them is what members wrote (or the helper's trip descriptions, where only a name that
  // is also a word is left); it is listed so it can be edited by hand, and stamped so no answer is written over it.
  const left = await memberTextMentioning(m, tagged, personId);
  if (left.photos.length) await db.photo.updateMany({ where: { id: { in: left.photos.map((p) => p.id) } }, data: { namesScrubbedAt: now } });
  // Their names, hashed, outlive their record: see tombstone.ts.
  if (!keepName) await rememberForgotten(m.tombstoneForms);
  await db.faceCluster.deleteMany({ where: { personId } });
  await db.face.deleteMany({ where: { proposedPersonId: personId } });
  if (keepName) {
    await db.$executeRaw`UPDATE "Face" SET embedding = NULL, "clusterId" = NULL WHERE "personId" = ${personId}`;
  } else {
    await db.face.deleteMany({ where: { personId } });
    // Forgetting entirely also removes the person page; the record of who is in which photo went with the faces.
    await db.person.delete({ where: { id: personId } });
  }
  // The list stays until an admin has seen to it: ids and fields, never the name.
  const count = left.photos.length + left.trips.length + left.collections.length + left.activities.length;
  if (!keepName && count) {
    const items = { photos: left.photos.map((p) => ({ id: p.id, fields: p.fields })), trips: left.trips.map((t) => ({ slug: t.slug })), collections: left.collections.map((c) => ({ slug: c.slug })), activities: left.activities.map((x) => ({ id: x.id })) };
    await db.forgetLeftover.create({ data: { items } });
  }
  revalidatePath("/people", "layout");
  revalidatePath("/admin");
  if (!keepName) redirect("/people/forgotten");
}

/** An admin has seen to a forget's leftovers list. */
export async function dismissForgetLeftover(id: string): Promise<void> {
  const admin = await requireAdmin();
  await db.forgetLeftover.updateMany({ where: { id, dismissedAt: null }, data: { dismissedAt: new Date(), dismissedById: admin.id } });
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
  if (person.name !== v.name) await rejudgeFromAction({ names: [v.name] });
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
  await requireUserOrThrow();
  // Animal proposals share the list with face proposals under an `animal:` id.
  if (faceId.startsWith("animal:")) {
    const a = await db.animalDetection.findUniqueOrThrow({ where: { id: faceId.slice(7) }, select: { proposedPersonId: true, photoId: true } });
    if (!a.proposedPersonId) throw new Error("Nothing proposed for this animal");
    await confirmAnimalAs(faceId.slice(7), a.proposedPersonId);
    await enqueueAnimalMatchAllOpen();
    revalidatePath(`/photos/${a.photoId}`);
    revalidatePath("/review");
    revalidatePath("/people", "layout");
    return;
  }
  const face = await db.face.findUniqueOrThrow({ where: { id: faceId }, select: { proposedPersonId: true, photoId: true } });
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
  await requireUserOrThrow();
  if (faceId.startsWith("animal:")) {
    const a = await db.animalDetection.findUniqueOrThrow({ where: { id: faceId.slice(7) }, select: { photoId: true } });
    await rejectAnimal(faceId.slice(7));
    revalidatePath(`/photos/${a.photoId}`);
    revalidatePath("/review");
    return;
  }
  const face = await db.face.findUniqueOrThrow({ where: { id: faceId }, select: { photoId: true } });
  await rejectProposal(faceId);
  revalidatePath(`/photos/${face.photoId}`);
  revalidatePath("/review");
}

/** Name one unnamed face by hand (a person with no era cluster near enough, or a face the matcher missed). */
export async function nameFace(faceId: string, personId: string): Promise<void> {
  await requireUserOrThrow();
  const face = await db.face.findUniqueOrThrow({ where: { id: faceId }, select: { photoId: true, personId: true } });
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
  if (!v.personId) await rejudgeFromAction({ names: [person.name] });
  if (person.optedOutAt) throw new Error("This person asked to be forgotten");
  // One tag per person per photograph: tagging somebody twice moves their box rather than stacking another.
  const already = await db.face.findFirst({ where: { photoId, personId: person.id, confidence: 0 }, select: { id: true } });
  if (already) await db.face.update({ where: { id: already.id }, data: { box } });
  else await db.face.create({ data: { photoId, personId: person.id, status: "CONFIRMED", box, confidence: 0 } });
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
  else await db.photo.update({ where: { id: photoId }, data: { namesScrubbedAt: new Date() } });
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
  await db.person.create({ data: { kind: "PET", name: v.name, species: v.species, livedFrom: v.livedFrom, livedTo: v.livedTo, isFlock: v.isFlock, descriptors: v.descriptors, createdById: user.id } });
  await rejudgeFromAction({ names: [v.name] });
  revalidatePath("/people", "layout");
}

export async function updatePet(personId: string, fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const pet = await db.person.findUniqueOrThrow({ where: { id: personId }, select: { createdById: true, name: true, formerNames: true } });
  if (!canChangePerson(user, pet)) throw new Error(NOT_YOUR_PERSON);
  const v = petSchema.parse({ name: fd.get("name"), species: fd.get("species"), livedFrom: fd.get("livedFrom") || undefined, livedTo: fd.get("livedTo") || undefined, isFlock: fd.get("isFlock") === "on", descriptors: fd.get("descriptors") ?? undefined });
  await db.person.update({ where: { id: personId, kind: "PET" }, data: { name: v.name, formerNames: withFormerName(pet, v.name), species: v.species, livedFrom: v.livedFrom, livedTo: v.livedTo, isFlock: v.isFlock, descriptors: v.descriptors } });
  if (pet.name !== v.name) await rejudgeFromAction({ names: [v.name] });
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
  await db.person.delete({ where: { id: personId, kind: "PET" } });
  revalidatePath("/people", "layout");
  redirect("/people");
}

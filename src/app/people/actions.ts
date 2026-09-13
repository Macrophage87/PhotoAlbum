"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { claimAnimalsForPet, confirmAnimalAs, rejectAnimal, releaseAnimalsForPet } from "@/lib/pets/proposals";
import { enqueueAnimalMatchAllOpen } from "@/lib/jobs/handlers/detect-animals";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { canEditMedia, NOT_YOURS } from "@/lib/auth/ownership";
import { namingOutcome } from "@/lib/people/consent";
import { enqueueEmbedding } from "@/lib/jobs/handlers/embed-photo";
import { enqueueFaceDetection } from "@/lib/jobs/handlers/detect-faces";
import { confirmFaceAs, rejectProposal } from "@/lib/people/matching";
import type { StoredAnnotation } from "@/lib/annotation/schema";

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

const nameSchema = z.object({
  name: z.string().trim().min(1).max(80),
  relationship: z.string().trim().max(80).optional().transform((v) => v || null),
  birthday: day,
  personId: z.string().optional().transform((v) => v || null),
});

/**
 * Name an unnamed cluster. Admins record the birthday and the indexing decision in the same step; members create the
 * person with indexing off and the cluster waits for an admin, unless they flag a child, which nulls it at once.
 */
export async function nameCluster(clusterId: string, fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const byAdmin = user.role === "ADMIN";
  const v = nameSchema.parse({ name: fd.get("name"), relationship: fd.get("relationship") ?? undefined, birthday: fd.get("birthday") || undefined, personId: fd.get("personId") ?? undefined });
  const cluster = await db.faceCluster.findUnique({ where: { id: clusterId }, select: { id: true, personId: true } });
  if (!cluster || cluster.personId) throw new Error("Cluster not found or already named");
  const outcome = namingOutcome({
    byAdmin,
    wantIndexing: byAdmin && fd.get("faceIndexing") === "on",
    parentInstruction: byAdmin && fd.get("parentInstruction") === "on",
    birthday: v.birthday,
    attest: byAdmin && fd.get("attest") === "on",
    isChildFlag: !byAdmin && fd.get("isChild") === "on",
  });
  const now = new Date();
  const person = v.personId
    ? await db.person.findUniqueOrThrow({ where: { id: v.personId } })
    : await db.person.create({
        data: {
          name: v.name,
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
      });
  if (v.personId && person.optedOutAt) throw new Error("This person asked to be forgotten");
  // Merging a cluster into an existing person (a childhood cluster named after a known adult) follows that person's setting.
  const effective = v.personId ? { faceIndexing: person.faceIndexing, nullTemplates: !person.faceIndexing, pendingDecision: person.pendingDecision } : outcome;
  await db.faceCluster.update({ where: { id: clusterId }, data: { personId: person.id, label: v.name } });
  await db.face.updateMany({ where: { clusterId }, data: { personId: person.id, status: "CONFIRMED" } });
  if (effective.nullTemplates) await nullTemplatesFor(person.id);
  revalidatePath("/people", "layout");
  revalidatePath("/admin");
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
  await db.person.update({
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
 * Opt a person out of recognition. Deletes their templates, clusters, proposals and negative examples, removes their
 * name from descriptions and the search index, and stops names reaching the helper. By default their confirmed
 * appearances go too; "keep my name on photos" keeps the non-biometric record only.
 */
export async function optOutPerson(personId: string, fd: FormData): Promise<void> {
  await requireUserOrThrow();
  const keepName = fd.get("mode") === "keep-name";
  const person = await db.person.findUniqueOrThrow({ where: { id: personId } });
  const photos = await db.face.findMany({ where: { OR: [{ personId }, { proposedPersonId: personId }] }, select: { photoId: true }, distinct: ["photoId"] });
  await db.faceCluster.deleteMany({ where: { personId } });
  await db.face.deleteMany({ where: { proposedPersonId: personId } });
  if (keepName) {
    await db.$executeRaw`UPDATE "Face" SET embedding = NULL, "clusterId" = NULL WHERE "personId" = ${personId}`;
    await db.person.update({ where: { id: personId }, data: { faceIndexing: false, pendingDecision: false, keepNameOnPhotos: true, optedOutAt: new Date(), faceIndexingSetAt: new Date() } });
  } else {
    await db.face.deleteMany({ where: { personId } });
  }
  // Scrub the name from the helper's text on affected items so neither the keyword nor the semantic index carries it.
  // Two regexes: a global one for replacing, and a non-global one for testing (a global regex's lastIndex would skip tags).
  const escaped = person.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const replaceAll = new RegExp(escaped, "gi");
  const mentions = new RegExp(escaped, "i");
  const scrub = (v: string | null | undefined) => (v ? v.replace(replaceAll, "a family member") : v ?? null);
  for (const { photoId } of photos) {
    const p = await db.photo.findUnique({ where: { id: photoId }, select: { annotation: true } });
    const a = p?.annotation as StoredAnnotation | null;
    if (a) {
      const next: StoredAnnotation = {
        ...a,
        caption: scrub(a.caption) ?? "",
        description: scrub(a.description) ?? "",
        searchSummary: scrub(a.searchSummary) ?? "",
        place: scrub(a.place),
        activity: scrub(a.activity),
        visibleText: scrub(a.visibleText),
        mood: scrub(a.mood),
        tags: a.tags.filter((t) => !mentions.test(t)),
        objects: a.objects.filter((t) => !mentions.test(t)),
      };
      await db.photo.update({ where: { id: photoId }, data: { annotation: next } });
    } else {
      await db.photo.update({ where: { id: photoId }, data: { updatedAt: new Date() } });
    }
    await enqueueEmbedding(photoId, true);
  }
  // Forgetting entirely also removes the person page; the record of who is in which photo went with the faces.
  if (!keepName) await db.person.delete({ where: { id: personId } });
  revalidatePath("/people", "layout");
  revalidatePath("/admin");
  if (!keepName) redirect("/people");
}

export async function updatePerson(personId: string, fd: FormData): Promise<void> {
  await requireUserOrThrow();
  const v = z.object({ name: z.string().trim().min(1).max(80), relationship: z.string().trim().max(80).transform((x) => x || null) }).parse({ name: fd.get("name"), relationship: fd.get("relationship") ?? "" });
  await db.person.update({ where: { id: personId }, data: { name: v.name, relationship: v.relationship } });
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
  revalidatePath("/people", "layout");
}

export async function updatePet(personId: string, fd: FormData): Promise<void> {
  await requireUserOrThrow();
  const v = petSchema.parse({ name: fd.get("name"), species: fd.get("species"), livedFrom: fd.get("livedFrom") || undefined, livedTo: fd.get("livedTo") || undefined, isFlock: fd.get("isFlock") === "on", descriptors: fd.get("descriptors") ?? undefined });
  await db.person.update({ where: { id: personId, kind: "PET" }, data: { name: v.name, species: v.species, livedFrom: v.livedFrom, livedTo: v.livedTo, isFlock: v.isFlock, descriptors: v.descriptors } });
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

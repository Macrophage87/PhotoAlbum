"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { namingOutcome } from "@/lib/people/consent";
import { enqueueEmbedding } from "@/lib/jobs/handlers/embed-photo";
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
  const outcome = namingOutcome({ byAdmin: true, wantIndexing: fd.get("faceIndexing") === "on", parentInstruction: fd.get("parentInstruction") === "on", birthday, attest, isChildFlag: false });
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
    // Enabling later: templates of confirmed faces are recomputed by re-scanning their photos.
    const photos = await db.face.findMany({ where: { personId, status: "CONFIRMED" }, select: { photoId: true }, distinct: ["photoId"] });
    await db.photo.updateMany({ where: { id: { in: photos.map((p) => p.photoId) } }, data: { facesDetectedAt: null } });
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
  if (keepName) await db.$executeRaw`UPDATE "Face" SET embedding = NULL, "clusterId" = NULL WHERE "personId" = ${personId}`;
  else await db.face.deleteMany({ where: { personId } });
  await db.person.update({ where: { id: personId }, data: { faceIndexing: false, pendingDecision: false, keepNameOnPhotos: keepName, faceIndexingSetAt: new Date() } });
  // Scrub the name from the helper's text on affected items so neither the keyword nor the semantic index carries it.
  const pattern = new RegExp(person.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const scrub = (v: string | null | undefined) => (v ? v.replace(pattern, "a family member") : v ?? null);
  for (const { photoId } of photos) {
    const p = await db.photo.findUnique({ where: { id: photoId }, select: { annotation: true } });
    const a = p?.annotation as StoredAnnotation | null;
    if (a) {
      const next: StoredAnnotation = { ...a, caption: scrub(a.caption) ?? "", description: scrub(a.description) ?? "", searchSummary: scrub(a.searchSummary) ?? "", tags: a.tags.filter((t) => !pattern.test(t)) };
      await db.photo.update({ where: { id: photoId }, data: { annotation: next } });
    } else {
      await db.photo.update({ where: { id: photoId }, data: { updatedAt: new Date() } });
    }
    await enqueueEmbedding(photoId, true);
  }
  revalidatePath("/people", "layout");
  revalidatePath("/admin");
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

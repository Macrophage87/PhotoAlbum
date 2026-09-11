import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { visibleMediaWhere } from "@/lib/auth/access";
import { photoCardSelect } from "@/lib/photos/queries";
import { isMinor, minorsCheckPasses } from "./consent";

export type PersonCard = { id: string; name: string; kind: "HUMAN" | "PET"; relationship: string | null; faceIndexing: boolean; pendingDecision: boolean; basis: "birthday" | "attestation" | "none"; minor: boolean; photoCount: number; sample: { id: string; updatedAt: Date } | null };

export async function listPeople(): Promise<PersonCard[]> {
  const people = await db.person.findMany({ orderBy: { name: "asc" }, include: { faces: { where: { status: "CONFIRMED" }, select: { photoId: true, photo: { select: { id: true, updatedAt: true, status: true } } } } } });
  return people.map((p) => {
    const photoIds = new Set(p.faces.map((f) => f.photoId));
    const sample = p.faces.find((f) => f.photo.status === "READY")?.photo ?? null;
    return { id: p.id, name: p.name, kind: p.kind, relationship: p.relationship, faceIndexing: p.faceIndexing, pendingDecision: p.pendingDecision, basis: p.adultAttestedAt ? "attestation" : p.birthday && minorsCheckPasses(p) ? "birthday" : "none", minor: isMinor(p), photoCount: photoIds.size, sample: sample ? { id: sample.id, updatedAt: sample.updatedAt } : null };
  });
}

export type UnnamedCluster = { id: string; faceCount: number; samples: { faceId: string; photoId: string; updatedAt: Date; box: [number, number, number, number] }[]; oldest: Date };

/** Unnamed clusters with a few sample faces, largest first. */
export async function listUnnamedClusters(): Promise<UnnamedCluster[]> {
  const clusters = await db.faceCluster.findMany({ where: { personId: null }, orderBy: { faceCount: "desc" }, include: { faces: { take: 4, orderBy: { confidence: "desc" }, select: { id: true, photoId: true, box: true, createdAt: true, photo: { select: { updatedAt: true, status: true } } } } } });
  return clusters
    .filter((c) => c.faces.length)
    .map((c) => ({ id: c.id, faceCount: c.faceCount, oldest: c.faces.reduce((m, f) => (f.createdAt < m ? f.createdAt : m), c.faces[0].createdAt), samples: c.faces.filter((f) => f.photo.status === "READY").map((f) => ({ faceId: f.id, photoId: f.photoId, updatedAt: f.photo.updatedAt, box: f.box as [number, number, number, number] })) }));
}

/** Media a person appears in, over time, restricted to what the viewer may see. */
export async function personMedia(viewer: Viewer, personId: string) {
  return db.photo.findMany({ where: { ...visibleMediaWhere(viewer), faces: { some: { personId, status: "CONFIRMED" } } }, orderBy: [{ takenAt: "asc" }], select: photoCardSelect });
}

export type FaceCounts = { templates: number; unnamed: number; people: number; nextPurge: Date | null };

export async function faceCounts(retentionDays: number): Promise<FaceCounts> {
  const [templates, unnamed, people, oldest] = await Promise.all([
    db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Face" WHERE embedding IS NOT NULL`.then((r) => r[0]?.n ?? 0),
    db.face.count({ where: { personId: null } }),
    db.person.count(),
    db.face.findFirst({ where: { personId: null }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  return { templates, unnamed, people, nextPurge: oldest ? new Date(oldest.createdAt.getTime() + retentionDays * 86_400_000) : null };
}

/** Who needs an admin's decision: member-named clusters, and people who turned 18 without a decision since. */
export async function needsDecision() {
  const people = await db.person.findMany({ where: { kind: "HUMAN", OR: [{ pendingDecision: true }, { faceIndexing: false, birthday: { not: null }, adultAttestedAt: null }] }, orderBy: { name: "asc" } });
  const now = new Date();
  return people.filter((p) => p.pendingDecision || (p.birthday && !isMinor(p, now) && (now.getTime() - new Date(Date.UTC(p.birthday.getUTCFullYear() + 18, p.birthday.getUTCMonth(), p.birthday.getUTCDate())).getTime()) < 400 * 86_400_000));
}

/** Confirmed people on one photo, for members-only chips. */
export async function peopleOnPhoto(photoId: string) {
  const faces = await db.face.findMany({ where: { photoId }, select: { id: true, box: true, status: true, person: { select: { id: true, name: true, kind: true } }, cluster: { select: { id: true } } }, orderBy: { confidence: "desc" } });
  return faces.map((f) => ({ id: f.id, box: f.box as [number, number, number, number], status: f.status, person: f.person, clusterId: f.cluster?.id ?? null }));
}

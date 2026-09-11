import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { visibleMediaWhere } from "@/lib/auth/access";
import { photoCardSelect } from "@/lib/photos/queries";
import { isMinor, minorsCheckPasses } from "./consent";

export type PersonCard = { id: string; name: string; kind: "HUMAN" | "PET"; species: string | null; isFlock: boolean; relationship: string | null; faceIndexing: boolean; pendingDecision: boolean; optedOut: boolean; basis: "birthday" | "attestation" | "none"; minor: boolean; photoCount: number; sample: { id: string; updatedAt: Date } | null };

export async function listPeople(): Promise<PersonCard[]> {
  const people = await db.person.findMany({ orderBy: { name: "asc" }, include: { faces: { where: { status: "CONFIRMED" }, select: { photoId: true, photo: { select: { id: true, updatedAt: true, status: true } } } } } });
  return people.map((p) => {
    const photoIds = new Set(p.faces.map((f) => f.photoId));
    const sample = p.faces.find((f) => f.photo.status === "READY")?.photo ?? null;
    return { id: p.id, name: p.name, kind: p.kind, species: p.species, isFlock: p.isFlock, relationship: p.relationship, faceIndexing: p.faceIndexing, pendingDecision: p.pendingDecision, optedOut: Boolean(p.optedOutAt), basis: p.adultAttestedAt ? "attestation" : p.birthday && minorsCheckPasses(p) ? "birthday" : "none", minor: isMinor(p), photoCount: photoIds.size, sample: sample ? { id: sample.id, updatedAt: sample.updatedAt } : null };
  });
}

export type UnnamedCluster = { id: string; faceCount: number; samples: { faceId: string; photoId: string; updatedAt: Date; box: [number, number, number, number] }[]; oldest: Date };

/** Unnamed clusters with a few sample faces, largest first. */
export async function listUnnamedClusters(): Promise<UnnamedCluster[]> {
  const clusters = await db.faceCluster.findMany({ where: { personId: null }, orderBy: { faceCount: "desc" }, include: { faces: { where: { status: { in: ["DETECTED", "REJECTED"] } }, take: 4, orderBy: { confidence: "desc" }, select: { id: true, photoId: true, box: true, createdAt: true, photo: { select: { updatedAt: true, status: true } } } } } });
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

/** Who needs an admin's decision: member-named clusters, and people the nightly job found have turned 18. */
export async function needsDecision() {
  return db.person.findMany({ where: { kind: "HUMAN", pendingDecision: true }, orderBy: { name: "asc" } });
}

/** Confirmed people on one photo, for members-only chips. */
export async function peopleOnPhoto(photoId: string) {
  const faces = await db.face.findMany({ where: { photoId }, select: { id: true, box: true, status: true, confidence: true, person: { select: { id: true, name: true, kind: true } }, proposedPerson: { select: { id: true, name: true } }, cluster: { select: { id: true } } }, orderBy: { confidence: "desc" } });
  return faces.map((f) => ({ id: f.id, box: f.box as [number, number, number, number], status: f.status, hand: f.confidence === 0, person: f.person, proposedPerson: f.proposedPerson, clusterId: f.cluster?.id ?? null }));
}

export type ProposalRow = { faceId: string; photo: { id: string; updatedAt: Date }; box: [number, number, number, number]; person: { id: string; name: string; kind: "HUMAN" | "PET" }; label: string; childhood: boolean };

/** Open proposals for some photos (or all), oldest first. */
export async function proposalsFor(photoIds?: string[]): Promise<ProposalRow[]> {
  const faces = await db.face.findMany({
    where: { status: "PROPOSED", proposedPersonId: { not: null }, ...(photoIds ? { photoId: { in: photoIds } } : {}) },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { id: true, box: true, confidence: true, ageAtCaptureYears: true, photo: { select: { id: true, updatedAt: true, caption: true, title: true, originalName: true, takenAt: true, estimatedDate: true } }, proposedPerson: { select: { id: true, name: true, kind: true, birthday: true } } },
  });
  const rows: ProposalRow[] = faces.map((f) => {
    const p = f.proposedPerson!;
    const date = f.photo.takenAt ?? f.photo.estimatedDate;
    const age = p.birthday && date ? Math.floor((date.getTime() - p.birthday.getTime()) / (365.25 * 86_400_000)) : null;
    const label = f.confidence === 0 ? `named in the notes on ${f.photo.caption ?? f.photo.title ?? f.photo.originalName}` : age !== null ? `about ${age} years old in ${f.photo.caption ?? f.photo.title ?? f.photo.originalName}` : (f.photo.caption ?? f.photo.title ?? f.photo.originalName);
    return { faceId: f.id, photo: { id: f.photo.id, updatedAt: f.photo.updatedAt }, box: f.box as [number, number, number, number], person: { id: p.id, name: p.name, kind: p.kind }, label, childhood: age !== null && age < 13 };
  });
  // Animal proposals ride in the same list under an `animal:` id; the actions tell the two apart by the prefix.
  const animals = await db.animalDetection.findMany({
    where: { status: "PROPOSED", proposedPersonId: { not: null }, ...(photoIds ? { photoId: { in: photoIds } } : {}) },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { id: true, box: true, species: true, createdAt: true, photo: { select: { id: true, updatedAt: true, caption: true, title: true, originalName: true } }, proposedPerson: { select: { id: true, name: true, kind: true } } },
  });
  for (const a of animals) {
    const p = a.proposedPerson!;
    rows.push({ faceId: `animal:${a.id}`, photo: { id: a.photo.id, updatedAt: a.photo.updatedAt }, box: a.box as [number, number, number, number], person: { id: p.id, name: p.name, kind: p.kind }, label: `a ${a.species.toLowerCase()} spotted in ${a.photo.caption ?? a.photo.title ?? a.photo.originalName}`, childhood: false });
  }
  return rows;
}

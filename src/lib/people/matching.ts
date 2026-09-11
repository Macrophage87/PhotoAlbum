import { db } from "@/lib/db";
import { vectorLiteral } from "@/lib/ml/client";
import { ageAtCapture, chooseEraCluster, pickMatch, vetoes, widenedBand, type AgeAtCapture, type CandidateCluster } from "./match";
import { namesMentioned } from "./text";
import { updatedCentroid } from "./cluster";

type FaceRow = { id: string; embedding: string | null; box: [number, number, number, number]; ageAtCaptureYears: number | null; status: string };

async function facesOf(photoId: string): Promise<FaceRow[]> {
  const rows = await db.$queryRaw<{ id: string; embedding: string | null; box: unknown; ageAtCaptureYears: number | null; status: string }[]>`SELECT id, embedding::text AS embedding, box, "ageAtCaptureYears", status FROM "Face" WHERE "photoId" = ${photoId} ORDER BY confidence DESC`;
  return rows.map((r) => ({ ...r, box: r.box as [number, number, number, number] }));
}

/**
 * Propose people for the unnamed faces on one photo: by similarity against the era clusters of consented people
 * (age band from the person's birthday and the photo's real or estimated date), then by names in the notes.
 * Every result is a PROPOSED face waiting for a member.
 */
const inFlight = new Map<string, Promise<number>>();

export function proposeForPhoto(photoId: string): Promise<number> {
  // Detection and a notes change can both ask for proposals on the same photo; run them one after the other.
  const prev = inFlight.get(photoId) ?? Promise.resolve(0);
  const run = prev.catch(() => 0).then(() => proposeNow(photoId)).finally(() => { if (inFlight.get(photoId) === run) inFlight.delete(photoId); });
  inFlight.set(photoId, run);
  return run;
}

async function proposeNow(photoId: string): Promise<number> {
  const photo = await db.photo.findUnique({ where: { id: photoId }, select: { takenAt: true, takenAtSource: true, estimatedDate: true, context: true } });
  if (!photo) return 0;
  const realDate = photo.takenAt && photo.takenAtSource !== "FILE_MTIME" && photo.takenAtSource !== "UPLOAD_TIME" ? photo.takenAt : null;
  const faces = await facesOf(photoId);
  const open = faces.filter((f) => f.status === "DETECTED");
  const people = await db.person.findMany({ where: { kind: "HUMAN" }, select: { id: true, name: true, birthday: true, faceIndexing: true } });
  const onPhoto = new Set((await db.face.findMany({ where: { photoId, status: { in: ["CONFIRMED", "PROPOSED"] } }, select: { personId: true, proposedPersonId: true } })).flatMap((f) => [f.personId, f.proposedPersonId]).filter(Boolean) as string[]);
  let proposed = 0;

  for (const face of open) {
    if (!face.embedding) continue;
    const embedding = JSON.parse(face.embedding) as number[];
    const vec = vectorLiteral(embedding);
    const near = await db.$queryRaw<{ id: string; personId: string; ageBandMin: number | null; ageBandMax: number | null; similarity: number; birthday: Date | null }[]>`
      SELECT fc.id, fc."personId", fc."ageBandMin", fc."ageBandMax", 1 - (fc.centroid <=> ${vec}::vector) AS similarity, p.birthday
      FROM "FaceCluster" fc JOIN "Person" p ON p.id = fc."personId"
      WHERE p."faceIndexing" AND p.kind = 'HUMAN' AND fc.centroid IS NOT NULL
      ORDER BY fc.centroid <=> ${vec}::vector LIMIT 12`;
    const rejected = await db.$queryRaw<{ proposedPersonId: string; embedding: string }[]>`SELECT "proposedPersonId", embedding::text AS embedding FROM "Face" WHERE status = 'REJECTED' AND "proposedPersonId" IS NOT NULL AND embedding IS NOT NULL AND 1 - (embedding <=> ${vec}::vector) >= 0.5`;
    const veto = vetoes(embedding, rejected.map((r) => ({ proposedPersonId: r.proposedPersonId, embedding: JSON.parse(r.embedding) as number[] })));
    // The age band is per person: the same photo date gives each candidate person a different age.
    const candidates: CandidateCluster[] = near.filter((n) => !onPhoto.has(n.personId)).map((n) => ({ id: n.id, personId: n.personId, ageBandMin: n.ageBandMin, ageBandMax: n.ageBandMax, similarity: Number(n.similarity) }));
    let best: ReturnType<typeof pickMatch> = null;
    for (const c of candidates) {
      const person = near.find((n) => n.id === c.id)!;
      const m = pickMatch([c], ageAtCapture(person.birthday, realDate, photo.estimatedDate, face.ageAtCaptureYears), veto);
      if (m && (!best || m.similarity > best.similarity)) best = m;
    }
    if (best) {
      await db.face.update({ where: { id: face.id }, data: { status: "PROPOSED", proposedPersonId: best.personId } });
      onPhoto.add(best.personId);
      proposed += 1;
    }
  }

  // Text-to-name: one person named in the notes and not yet on the photo goes to the largest still-open face.
  const mentioned = namesMentioned(photo.context, people).filter((p) => !onPhoto.has(p.id));
  const stillOpen = (await facesOf(photoId)).filter((f) => f.status === "DETECTED").sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
  for (const [i, p] of mentioned.entries()) {
    const face = stillOpen[i];
    if (!face) break;
    await db.face.update({ where: { id: face.id }, data: { status: "PROPOSED", proposedPersonId: p.id } });
    proposed += 1;
  }
  // Pets named in the notes are proposed as whole-image appearances (there is no pet detector).
  const pets = await db.person.findMany({ where: { kind: "PET" }, select: { id: true, name: true } });
  const tagged = new Set((await db.face.findMany({ where: { photoId, OR: [{ personId: { in: pets.map((p) => p.id) } }, { proposedPersonId: { in: pets.map((p) => p.id) } }] }, select: { personId: true, proposedPersonId: true } })).flatMap((f) => [f.personId, f.proposedPersonId]));
  for (const pet of namesMentioned(photo.context, pets)) {
    if (tagged.has(pet.id)) continue;
    if (await db.face.findFirst({ where: { photoId, OR: [{ personId: pet.id }, { proposedPersonId: pet.id }] }, select: { id: true } })) continue;
    await db.face.create({ data: { photoId, proposedPersonId: pet.id, status: "PROPOSED", box: [0, 0, 1, 1], confidence: 0 } });
    proposed += 1;
  }
  return proposed;
}

/** Ages for a face joining a person: from the person's birthday and the photo's date. */
async function ageFor(faceId: string, personId: string): Promise<AgeAtCapture> {
  const face = await db.face.findUniqueOrThrow({ where: { id: faceId }, select: { ageAtCaptureYears: true, photo: { select: { takenAt: true, takenAtSource: true, estimatedDate: true } } } });
  const person = await db.person.findUniqueOrThrow({ where: { id: personId }, select: { birthday: true } });
  const realDate = face.photo.takenAt && face.photo.takenAtSource !== "FILE_MTIME" && face.photo.takenAtSource !== "UPLOAD_TIME" ? face.photo.takenAt : null;
  return ageAtCapture(person.birthday, realDate, face.photo.estimatedDate, face.ageAtCaptureYears);
}

/**
 * Confirm a face as a person. Leaves its unnamed cluster, joins the person's era cluster for that age (or starts one),
 * and keeps its template only when the person's recognition is on.
 */
export async function confirmFaceAs(faceId: string, personId: string): Promise<void> {
  const face = await db.face.findUniqueOrThrow({ where: { id: faceId }, select: { id: true, clusterId: true, cluster: { select: { personId: true } } } });
  const person = await db.person.findUniqueOrThrow({ where: { id: personId }, select: { faceIndexing: true, kind: true } });
  const age = person.kind === "HUMAN" ? await ageFor(faceId, personId) : null;
  if (face.clusterId && !face.cluster?.personId) await leaveCluster(face.id, face.clusterId);
  await db.face.update({ where: { id: faceId }, data: { personId, proposedPersonId: null, status: "CONFIRMED", clusterId: null, ageAtCaptureYears: age ? Math.round(age.years * 10) / 10 : undefined } });
  if (!person.faceIndexing) {
    await db.$executeRaw`UPDATE "Face" SET embedding = NULL WHERE id = ${faceId}`;
    return;
  }
  const row = await db.$queryRaw<{ embedding: string | null }[]>`SELECT embedding::text AS embedding FROM "Face" WHERE id = ${faceId}`;
  const embedding = row[0]?.embedding ? (JSON.parse(row[0].embedding) as number[]) : null;
  if (!embedding) return;
  const eras = await db.$queryRaw<{ id: string; ageBandMin: number | null; ageBandMax: number | null; centroid: string | null; faceCount: number }[]>`SELECT id, "ageBandMin", "ageBandMax", centroid::text AS centroid, "faceCount" FROM "FaceCluster" WHERE "personId" = ${personId}`;
  const era = chooseEraCluster(eras, age);
  const band = widenedBand(era ?? { ageBandMin: null, ageBandMax: null }, age);
  if (era) {
    const centroid = era.centroid ? updatedCentroid(JSON.parse(era.centroid) as number[], era.faceCount, embedding) : embedding;
    await db.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(centroid)}::vector, "faceCount" = "faceCount" + 1, "ageBandMin" = ${band.ageBandMin}, "ageBandMax" = ${band.ageBandMax}, "updatedAt" = now() WHERE id = ${era.id}`;
    await db.face.update({ where: { id: faceId }, data: { clusterId: era.id } });
  } else {
    const created = await db.faceCluster.create({ data: { personId, faceCount: 1, ageBandMin: band.ageBandMin, ageBandMax: band.ageBandMax }, select: { id: true } });
    await db.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(embedding)}::vector WHERE id = ${created.id}`;
    await db.face.update({ where: { id: faceId }, data: { clusterId: created.id } });
  }
}

async function leaveCluster(faceId: string, clusterId: string) {
  await db.face.update({ where: { id: faceId }, data: { clusterId: null } });
  const left = await db.face.count({ where: { clusterId } });
  if (left === 0) await db.faceCluster.delete({ where: { id: clusterId } }).catch(() => undefined);
  else await db.faceCluster.update({ where: { id: clusterId }, data: { faceCount: left } });
}

/** A rejected proposal becomes a negative example for that person and returns to the unnamed pool. */
export async function rejectProposal(faceId: string): Promise<void> {
  await db.face.update({ where: { id: faceId }, data: { status: "REJECTED" } });
}

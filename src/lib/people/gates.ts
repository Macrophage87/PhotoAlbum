import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { mlConfigured } from "@/lib/ml/client";

export type FaceGates = { sidecar: boolean; envEnabled: boolean; optedInAt: Date | null; active: boolean; retentionDays: number };

/** Detection runs only with the sidecar configured, the operator flag on, and an admin's opt-in recorded. */
export async function faceGates(): Promise<FaceGates> {
  const e = env();
  const setting = await db.appSetting.findUnique({ where: { id: "app" }, select: { faceDetectionOptInAt: true } });
  const optedInAt = setting?.faceDetectionOptInAt ?? null;
  const sidecar = mlConfigured();
  return { sidecar, envEnabled: e.FACE_INDEXING_ENABLED, optedInAt, active: sidecar && e.FACE_INDEXING_ENABLED && Boolean(optedInAt), retentionDays: e.FACE_UNNAMED_RETENTION_DAYS };
}

/** Names the AI helper may be given for an item: confirmed people whose indexing is on and who are not minors. */
export async function permittedNames(photoId: string): Promise<string[]> {
  const { nameMayLeaveServer } = await import("./consent");
  const faces = await db.face.findMany({ where: { photoId, status: "CONFIRMED", personId: { not: null } }, select: { person: { select: { name: true, birthday: true, adultAttestedAt: true, faceIndexing: true, kind: true, optedOutAt: true } } } });
  const names = new Set<string>();
  for (const f of faces) {
    const p = f.person;
    if (!p || p.optedOutAt) continue;
    if (p.kind === "PET" || nameMayLeaveServer(p)) names.add(p.name);
  }
  return [...names];
}

import { db } from "@/lib/db";
import { nameMatcher } from "./scrub";
import { nameMayLeaveServer } from "./consent";

export type NameScrub = (text: string | null | undefined) => string | null;

/**
 * Words the helper is handed again — a title, a description written before — can carry the name of somebody it may
 * no longer be told: forgotten, not known to be an adult, or whose naming was switched off. Those names are taken out
 * of such words before they go, so the helper is never told a name by way of its own old text, or a member's.
 *
 * `photoIds` are the photographs the words are about: a short name that is also an everyday word ("Grace") is only
 * taken out where its owner is, or was, tagged on one of them.
 */
export async function unpermittedNameScrub(photoIds: string[]): Promise<NameScrub> {
  const [people, users, tagged] = await Promise.all([
    db.person.findMany({ select: { id: true, kind: true, name: true, formerNames: true, birthday: true, adultAttestedAt: true, faceIndexing: true, nameInDescriptions: true, optedOutAt: true } }),
    db.user.findMany({ where: { name: { not: null } }, select: { name: true } }),
    photoIds.length
      ? Promise.all([
          db.face.findMany({ where: { photoId: { in: photoIds } }, select: { personId: true, proposedPersonId: true } }),
          db.animalDetection.findMany({ where: { photoId: { in: photoIds } }, select: { personId: true, proposedPersonId: true } }),
        ]).then(([f, a]) => new Set([...f, ...a].flatMap((r) => [r.personId, r.proposedPersonId]).filter((x): x is string => Boolean(x))))
      : Promise.resolve(new Set<string>()),
  ]);
  const matchers = people
    .filter((p) => p.kind === "HUMAN" && (p.optedOutAt || !nameMayLeaveServer(p)))
    .map((p) => {
      const others = [...people.filter((o) => o.id !== p.id).flatMap((o) => [o.name, ...(o.formerNames ?? [])]), ...users.map((u) => u.name ?? "")];
      return { m: nameMatcher([p.name, ...(p.formerNames ?? [])], others), where: { tagged: tagged.has(p.id) } };
    });
  return (text) => {
    if (typeof text !== "string" || !text) return text ?? null;
    return matchers.reduce((t, { m, where }) => m.scrub(t, where), text);
  };
}

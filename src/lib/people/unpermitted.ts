import { db } from "@/lib/db";
import { nameMatcher, type NameMatcher } from "./scrub";
import { nameMayLeaveServer } from "./consent";
import { loadTombstone, type Tombstone } from "./tombstone";

export type NameScrub = (text: string | null | undefined) => string | null;

/**
 * Everything members wrote that goes to the helper — titles, captions, notes, a trip's or an activity's title and
 * description, the note typed beside the describe button — can carry the name of somebody it may not be told:
 * forgotten (see tombstone.ts), not known to be an adult, or whose naming is switched off. Those names are taken
 * out before it goes.
 *
 * Built once for a run of requests (loading everybody and preparing their matchers is the costly part), then asked
 * for the photographs each request is about: a short name that is also an everyday word ("Grace") is only taken out
 * where its owner is, or was, tagged on one of them.
 */
export type NameScrubber = { forPhotos(photoIds: string[]): Promise<NameScrub> };

export async function nameScrubber(): Promise<NameScrubber> {
  const [people, users, tombstone] = await Promise.all([
    db.person.findMany({ select: { id: true, kind: true, name: true, formerNames: true, birthday: true, adultAttestedAt: true, adultConfirmedAt: true, faceIndexing: true, nameInDescriptions: true, optedOutAt: true } }),
    db.user.findMany({ where: { name: { not: null } }, select: { name: true } }),
    loadTombstone(),
  ]);
  const everybody = [...people.flatMap((o) => [o.name, ...(o.formerNames ?? [])]), ...users.map((u) => u.name ?? "")];
  const matchers: { id: string; m: NameMatcher }[] = people
    .filter((p) => p.kind === "HUMAN" && (p.optedOutAt || !nameMayLeaveServer(p)))
    .map((p) => {
      const own = new Set([p.name, ...(p.formerNames ?? [])]);
      return { id: p.id, m: nameMatcher([...own], everybody.filter((n) => !own.has(n))) };
    });
  return {
    async forPhotos(photoIds) {
      const tagged = photoIds.length && matchers.length ? await taggedOn(photoIds) : new Set<string>();
      return scrubWith(matchers, tagged, tombstone);
    },
  };
}

async function taggedOn(photoIds: string[]): Promise<Set<string>> {
  const [f, a] = await Promise.all([
    db.face.findMany({ where: { photoId: { in: photoIds } }, select: { personId: true, proposedPersonId: true } }),
    db.animalDetection.findMany({ where: { photoId: { in: photoIds } }, select: { personId: true, proposedPersonId: true } }),
  ]);
  return new Set([...f, ...a].flatMap((r) => [r.personId, r.proposedPersonId]).filter((x): x is string => Boolean(x)));
}

function scrubWith(matchers: { id: string; m: NameMatcher }[], tagged: Set<string>, tombstone: Tombstone): NameScrub {
  return (text) => {
    if (typeof text !== "string" || !text) return text ?? null;
    const named = matchers.reduce((t, { id, m }) => m.scrub(t, { tagged: tagged.has(id), fullOnly: true }), text);
    return tombstone.scrub(named);
  };
}

/** For a single request: build, and ask about these photographs. */
export async function unpermittedNameScrub(photoIds: string[], scrubber?: NameScrubber): Promise<NameScrub> {
  return (scrubber ?? (await nameScrubber())).forPhotos(photoIds);
}

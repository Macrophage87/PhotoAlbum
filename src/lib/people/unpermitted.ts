import { db } from "@/lib/db";
import { nameMatcher, scrubAnnotation, type NameMatcher } from "./scrub";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { nameMayLeaveServer } from "./consent";
import { forgottenScope, loadTombstone, NO_SCOPE, type Scope, type Tombstone } from "./tombstone";

export type NameScrub = (text: string | null | undefined) => string | null;

/**
 * Everything members wrote that goes to the helper — titles, captions, notes, a trip's or an activity's title and
 * description, the note typed beside the describe button — can carry the name of somebody it may not be told:
 * forgotten (see tombstone.ts), not known to be an adult, or whose naming is switched off. Those names are taken
 * out before it goes.
 *
 * Built once for a run of requests (loading everybody and preparing their matchers is the costly part), then asked
 * for the photographs each request is about: a short name that is also an everyday word ("Grace") is only taken out
 * where its owner is, or was, tagged on one of them. Elsewhere only their full names go: a first name alone on
 * somebody else's photograph identifies nobody, and is as often a place in a member's title.
 */
/** `containers`: a trip, collection or activity the request is about as a whole (all its photographs count). */
export type NameScrubber = { forPhotos(photoIds: string[], containers?: Containers): Promise<NameScrub> };
type Containers = { kind: "trip" | "collection" | "activity"; id: string }[];

export async function nameScrubber(): Promise<NameScrubber> {
  const [people, users, tombstone] = await Promise.all([
    db.person.findMany({ select: { id: true, kind: true, name: true, formerNames: true, birthday: true, adultAttestedAt: true, adultConfirmedAt: true, faceIndexing: true, nameInDescriptions: true, optedOutAt: true, forgetPendingAt: true } }),
    db.user.findMany({ where: { name: { not: null } }, select: { name: true } }),
    loadTombstone(),
  ]);
  const everybody = [...people.flatMap((o) => [o.name, ...(o.formerNames ?? [])]), ...users.map((u) => u.name ?? "")];
  const matchers: Matcher[] = people
    .filter((p) => p.kind === "HUMAN" && (p.optedOutAt || !nameMayLeaveServer(p)))
    .map((p) => {
      const own = new Set([p.name, ...(p.formerNames ?? [])]);
      // Waiting to be forgotten: their first name goes too, anywhere, until the forget is done.
      return { id: p.id, m: nameMatcher([...own], everybody.filter((n) => !own.has(n))), pending: Boolean(p.forgetPendingAt) };
    });
  return {
    async forPhotos(photoIds, containers = []) {
      // Tagged on any of the photographs, or anywhere in a trip, collection or activity the request is about.
      // A photograph's own trip, activity and collections count too: tagged on one of the birthday's photographs,
      // "Sam's 5th birthday" is about them on all of them.
      const tagged = (photoIds.length || containers.length) && matchers.length ? await taggedOn(photoIds, [...containers, ...(await containersOf(photoIds))]) : new Set<string>();
      // Only a photograph they are on themselves reads a place-like name as theirs wherever a place is not plainly
      // meant; a request about a whole trip, collection or activity never does.
      const onPhoto = !containers.length && photoIds.length && tagged.size ? await taggedOn(photoIds) : new Set<string>();
      const scope = tombstone.empty ? NO_SCOPE : await forgottenScope({ photoIds, containers }, tombstone);
      return scrubWith(matchers, tagged, onPhoto, tombstone, scope);
    },
  };
}

async function containersOf(photoIds: string[]): Promise<Containers> {
  if (!photoIds.length) return [];
  const photos = await db.photo.findMany({ where: { id: { in: photoIds } }, select: { tripId: true, activityId: true, collections: { select: { collectionId: true } } } });
  return photos.flatMap((p) => [
    ...(p.tripId ? [{ kind: "trip" as const, id: p.tripId }] : []),
    ...(p.activityId ? [{ kind: "activity" as const, id: p.activityId }] : []),
    ...p.collections.map((c) => ({ kind: "collection" as const, id: c.collectionId })),
  ]);
}

async function taggedOn(photoIds: string[], containers: Containers = []): Promise<Set<string>> {
  const of = (kind: string) => containers.filter((c) => c.kind === kind).map((c) => c.id);
  const photo = {
    OR: [
      { photoId: { in: photoIds } },
      ...(containers.length ? [{ photo: { OR: [{ tripId: { in: of("trip") } }, { activityId: { in: of("activity") } }, { collections: { some: { collectionId: { in: of("collection") } } } }] } }] : []),
    ],
  };
  const [f, a] = await Promise.all([
    db.face.findMany({ where: photo, select: { personId: true, proposedPersonId: true } }),
    db.animalDetection.findMany({ where: photo, select: { personId: true, proposedPersonId: true } }),
  ]);
  return new Set([...f, ...a].flatMap((r) => [r.personId, r.proposedPersonId]).filter((x): x is string => Boolean(x)));
}

type Matcher = { id: string; m: NameMatcher; pending: boolean };

function scrubWith(matchers: Matcher[], tagged: Set<string>, onPhoto: Set<string>, tombstone: Tombstone, scope: Scope): NameScrub {
  return (text) => {
    if (typeof text !== "string" || !text) return text ?? null;
    const named = matchers.reduce((t, { id, m, pending }) => m.scrub(t, { tagged: tagged.has(id), onPhoto: onPhoto.has(id), fullOnly: !pending }), text);
    // A one-word forgotten name only where its owner was tagged (see tombstone.ts).
    return tombstone.scrub(named, scope);
  };
}

/** For a single request: build, and ask about these photographs. */
export async function unpermittedNameScrub(photoIds: string[], scrubber?: NameScrubber, containers?: Containers): Promise<NameScrub> {
  return (scrubber ?? (await nameScrubber())).forPhotos(photoIds, containers);
}

/**
 * An answer about a photograph without the names of anybody opted out or waiting to be forgotten whose record is
 * still there: the helper was never told them, but may have read them in a sign or guessed, and storing them would
 * write back what the forget is about to take out.
 */
export async function withoutOptedOutNames(record: StoredAnnotation, photoId: string): Promise<StoredAnnotation> {
  const gone = await db.person.findMany({ where: { kind: "HUMAN", OR: [{ optedOutAt: { not: null } }, { forgetPendingAt: { not: null } }] }, select: { id: true, name: true, formerNames: true } });
  if (!gone.length) return record;
  const [others, tagged] = await Promise.all([
    db.person.findMany({ where: { id: { notIn: gone.map((p) => p.id) } }, select: { name: true, formerNames: true } }),
    taggedOn([photoId]),
  ]);
  const everybody = [...others.flatMap((o) => [o.name, ...(o.formerNames ?? [])]), ...gone.flatMap((g) => [g.name, ...(g.formerNames ?? [])])];
  let out = record;
  for (const p of gone) {
    const own = new Set([p.name, ...(p.formerNames ?? [])]);
    out = scrubAnnotation(out, nameMatcher([...own], everybody.filter((n) => !own.has(n))), { tagged: tagged.has(p.id) });
  }
  return out;
}

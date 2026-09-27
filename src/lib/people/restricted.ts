import { db } from "@/lib/db";
import { isMinor, nameMayLeaveServer } from "./consent";
import { strictMatcher, type StrictOptions } from "./strict-names";

/**
 * Everybody who said no, had their naming taken back, or cannot agree: opted out, waiting to be forgotten, a naming
 * withdrawn (or taken back once its fortnight passed, or switched off by an admin — naming decided and not allowed
 * now), and anybody whose birthday says they are a child. Not somebody nobody has asked: there the member who shows
 * the helper's words decides, as they always did.
 */
async function restrictedPeople(): Promise<{ names: string[] }[]> {
  const people = await db.person.findMany({ where: { kind: "HUMAN" }, select: { name: true, formerNames: true, birthday: true, adultAttestedAt: true, adultConfirmedAt: true, faceIndexing: true, nameInDescriptions: true, nameInDescriptionsSetAt: true, optedOutAt: true, forgetPendingAt: true, namingWithdrawnAt: true } });
  return people
    .filter((p) => p.optedOutAt || p.forgetPendingAt || p.namingWithdrawnAt || (p.nameInDescriptionsSetAt && !nameMayLeaveServer(p)) || isMinor(p))
    .map((p) => ({ names: [p.name, ...(p.formerNames ?? [])] }));
}

/** Everybody's names, and a strict test for each restricted person's (see strict-names.ts). */
export async function restrictedMatchers(): Promise<((text: unknown, opts?: StrictOptions) => boolean)[]> {
  const people = await restrictedPeople();
  if (!people.length) return [];
  const [everybody, members] = await Promise.all([db.person.findMany({ select: { name: true, formerNames: true } }), db.user.findMany({ where: { name: { not: null } }, select: { name: true } })]);
  const all = [...everybody.flatMap((p) => [p.name, ...(p.formerNames ?? [])]), ...members.map((u) => u.name ?? "")];
  return people.map(({ names }) => {
    const own = new Set(names);
    return strictMatcher(names, all.filter((n) => !own.has(n)));
  });
}

/**
 * Whether the helper's words about to be shown to everyone name somebody who may not be named there (see
 * `restrictedPeople`), by the strict matcher (strict-names.ts): any full name, first name, nickname or former name,
 * or a surname only they have, in any case and through any invisible character or accent. Only a month used as a
 * date ("May 2019", "May 5, 2019"), "Lake" or "Mount" with a listed place ("Lake Geneva at dawn") and somebody
 * else's full name written in prose ("Grace Kelly") are excused; everything else it finds stays with the family until a member edits it (#147 item 8 is declined). The
 * same test keeps the helper's words members-only whenever they are judged (annotation/members-only.ts), so words
 * naming such somebody are never published by themselves either. `lists`: keywords, tags and objects, where words
 * run together, so that nobody else's full name excuses a match there ("picnic tom jordan swing").
 */
export async function namesSomebodyRestricted(texts: (string | null | undefined)[], lists: (string | null | undefined)[] = []): Promise<boolean> {
  const present = (l: (string | null | undefined)[]) => l.filter((t): t is string => typeof t === "string" && t.trim() !== "");
  const words = present(texts);
  const listed = present(lists);
  if (!words.length && !listed.length) return false;
  const tests = await restrictedMatchers();
  if (!tests.length) return false;
  return tests.some((finds) => words.some((w) => finds(w)) || listed.some((w) => finds(w, { list: true })));
}

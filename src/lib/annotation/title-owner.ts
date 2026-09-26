import { db } from "@/lib/db";
import { mentionsAnyName } from "./names";

/**
 * The one pass that finishes what the forget_guards migration started: an item described by the helper, whose
 * description no member has edited, and whose title names somebody the album knows, goes by a title the helper most
 * likely wrote — it was told the names — so the title is marked as the helper's. Forgetting then rewrites it rather
 * than leaving it for a member to edit, and it is never handed back to the helper as the family's own words.
 *
 * Done once (AppSetting.helperTitlesMarkedAt), not on every start: a title a member types afterwards is theirs, and
 * running this again would take it from them.
 */
export async function markHelperTitlesOnce(): Promise<number> {
  const setting = await db.appSetting.findUnique({ where: { id: "app" }, select: { helperTitlesMarkedAt: true } });
  if (setting?.helperTitlesMarkedAt) return 0;
  const [people, candidates] = await Promise.all([
    db.person.findMany({ select: { name: true, formerNames: true } }),
    db.photo.findMany({
      where: { titleByHelper: false, annotationSource: "MACHINE", annotatedAt: { not: null }, OR: [{ title: { not: null } }, { membersTitle: { not: null } }] },
      select: { id: true, title: true, membersTitle: true },
    }),
  ]);
  const names = people.flatMap((p) => [p.name, ...(p.formerNames ?? [])]);
  const ids = names.length ? candidates.filter((p) => mentionsAnyName(p.title?.trim() || p.membersTitle || "", names)).map((p) => p.id) : [];
  for (let i = 0; i < ids.length; i += 500) await db.photo.updateMany({ where: { id: { in: ids.slice(i, i + 500) } }, data: { titleByHelper: true } });
  await db.appSetting.upsert({ where: { id: "app" }, create: { id: "app", helperTitlesMarkedAt: new Date() }, update: { helperTitlesMarkedAt: new Date() } });
  return ids.length;
}

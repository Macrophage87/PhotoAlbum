/**
 * The text-to-name proposal: the uploader's notes are the strongest signal for who is in a photo, so known names
 * mentioned there become proposals ("Sam at age 4"). Pure.
 */
export type Named = { id: string; name: string };

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** People whose full name, or distinctive first word (3+ letters), appears as a whole word in the text. */
export function namesMentioned(text: string | null | undefined, people: Named[]): Named[] {
  if (!text) return [];
  const hits: Named[] = [];
  for (const p of people) {
    const full = p.name.trim();
    if (!full) continue;
    const first = full.split(/\s+/)[0];
    const patterns = [full];
    if (first.length >= 3 && first !== full) patterns.push(first);
    if (patterns.some((n) => new RegExp(`(^|[^\\p{L}])${escape(n)}(?=$|[^\\p{L}])`, "iu").test(text))) hits.push(p);
  }
  // A first name shared by two people is no signal at all.
  const byFirst = new Map<string, number>();
  for (const h of hits) byFirst.set(h.name.split(/\s+/)[0].toLowerCase(), (byFirst.get(h.name.split(/\s+/)[0].toLowerCase()) ?? 0) + 1);
  return hits.filter((h) => text.toLowerCase().includes(h.name.toLowerCase()) || (byFirst.get(h.name.split(/\s+/)[0].toLowerCase()) ?? 0) === 1);
}

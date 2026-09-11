import Link from "next/link";

/** Members-only name chips for a photo. Never rendered for anonymous or share-link viewers. */
export function PersonChips({ faces }: { faces: { id: string; status: string; person: { id: string; name: string; kind: string } | null }[] }) {
  const named = faces.filter((f) => f.person && f.status === "CONFIRMED");
  const unnamed = faces.filter((f) => !f.person).length;
  if (!named.length && !unnamed) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {named.map((f) => (
        <Link key={f.id} href={`/people/${f.person!.id}`} className="rounded-full bg-primary/10 text-primary px-2.5 py-0.5 hover:bg-primary/20">{f.person!.name}</Link>
      ))}
      {unnamed > 0 && <Link href="/people" className="rounded-full bg-surface-alt text-muted px-2.5 py-0.5 hover:bg-border">{unnamed} unnamed face{unnamed === 1 ? "" : "s"}</Link>}
    </div>
  );
}

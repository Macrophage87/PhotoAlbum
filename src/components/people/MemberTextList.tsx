import Link from "next/link";
import type { MemberText } from "@/lib/people/forget";

const fieldsOf = (fields: readonly string[], fallback: string) => (fields.length ? fields.join(", ") : fallback);

/**
 * Where words forgetting leaves alone still mention somebody: a title, caption, notes or description written by a
 * member, or before the album kept track of who wrote it; and the other things members type that can hold a name —
 * a file name, a note, a web address, what the album knows about somebody else, a track's name, an import's report.
 * For their author (or an admin) to edit by hand.
 */
export function MemberTextList({ text }: { text: MemberText }) {
  if (!Object.values(text).some((list) => list.length)) return null;
  return (
    <ul className="space-y-1 text-sm" data-testid="member-text">
      {text.photos.map((p) => (
        <li key={`p${p.id}`}>
          {/* One in the trash is seen to from the trash. */}
          <Link className="underline" href={p.trashed ? "/admin/trash" : `/photos/${p.id}`}>{p.label}</Link>
          {p.fields.length > 0 && <span className="text-muted"> ({p.fields.join(", ")}{p.trashed ? ", in the trash" : ""})</span>}
        </li>
      ))}
      {text.trips.map((t) => (
        <li key={`t${t.id}`}>
          <Link className="underline" href={`/trips/${t.slug}/settings`}>{t.title}</Link> <span className="text-muted">(trip {fieldsOf(t.fields, "description")})</span>
        </li>
      ))}
      {text.collections.map((c) => (
        <li key={`c${c.id}`}>
          <Link className="underline" href={`/collections/${c.slug}/settings`}>{c.title}</Link> <span className="text-muted">(collection {fieldsOf(c.fields, "description")})</span>
        </li>
      ))}
      {text.activities.map((a) => (
        <li key={`a${a.id}`}>
          <Link className="underline" href={`/trips/${a.tripSlug}/activities/${a.id}`}>{a.title}</Link> <span className="text-muted">(activity description)</span>
        </li>
      ))}
      {text.people.map((x) => (
        <li key={`s${x.id}`}>
          <Link className="underline" href={`/people/${x.id}`}>{x.label}</Link> <span className="text-muted">({x.fields.join(", ")})</span>
        </li>
      ))}
      {text.tracks.map((t) => (
        <li key={`k${t.id}`}>
          <Link className="underline" href={t.href}>{t.label}</Link> <span className="text-muted">(track {t.fields.join(", ")})</span>
        </li>
      ))}
      {text.imports.map((i) => (
        <li key={`i${i.id}`}>
          <Link className="underline" href="/admin">{i.label}</Link> <span className="text-muted">(Google Photos import report)</span>
        </li>
      ))}
    </ul>
  );
}

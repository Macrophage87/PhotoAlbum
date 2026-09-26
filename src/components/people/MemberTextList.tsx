import Link from "next/link";
import type { MemberText } from "@/lib/people/forget";

const FIELD_LABEL = { title: "title", caption: "caption", notes: "notes" } as const;

/**
 * Where words forgetting leaves alone still mention somebody: a title, caption, notes or description written by a
 * member, or before the album kept track of who wrote it. For their author (or an admin) to edit by hand.
 */
export function MemberTextList({ text }: { text: MemberText }) {
  const count = text.photos.length + text.trips.length + text.collections.length + text.activities.length;
  if (!count) return null;
  return (
    <ul className="space-y-1 text-sm" data-testid="member-text">
      {text.photos.map((p) => (
        <li key={`p${p.id}`}>
          <Link className="underline" href={`/photos/${p.id}`}>{p.label}</Link>
          {p.fields.length > 0 && <span className="text-muted"> ({p.fields.map((f) => FIELD_LABEL[f]).join(", ")})</span>}
        </li>
      ))}
      {text.trips.map((t) => (
        <li key={`t${t.slug}`}>
          <Link className="underline" href={`/trips/${t.slug}/settings`}>{t.title}</Link> <span className="text-muted">(trip description)</span>
        </li>
      ))}
      {text.collections.map((c) => (
        <li key={`c${c.slug}`}>
          <Link className="underline" href={`/collections/${c.slug}/settings`}>{c.title}</Link> <span className="text-muted">(collection description)</span>
        </li>
      ))}
      {text.activities.map((a) => (
        <li key={`a${a.id}`}>
          <Link className="underline" href={`/trips/${a.tripSlug}/activities/${a.id}`}>{a.title}</Link> <span className="text-muted">(activity description)</span>
        </li>
      ))}
    </ul>
  );
}

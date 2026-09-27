import Link from "next/link";
import type { MemberText } from "@/lib/people/forget";
import { clearTakeoutReport } from "@/app/admin/actions";

/**
 * What can be done about each field, said plainly: some are edited where they are shown, and some cannot be edited
 * at all, only removed with what holds them.
 */
const REMEDY: Record<string, string> = {
  title: "edit it on the photo's page",
  caption: "edit it on the photo's page",
  notes: "edit them on the photo's page",
  place: "set the place again on the photo's page",
  "file name": "a file name can't be changed; delete the photo to remove it",
  "trash note": "delete it from the trash for good, or restore it",
  "link note": "remove the link on the photo's page",
  description: "edit it in settings",
  "web address": "change it under Web address in settings",
  relationship: "edit it on their page",
  descriptors: "edit them on their page",
  "former names": "can't be edited; kept so text written under an old name is still found",
  name: "a track can't be renamed; delete its activity with its track to remove it",
};

function Fields({ what, fields, extra }: { what?: string; fields: readonly string[]; extra?: string }) {
  if (!fields.length) return null;
  return (
    <span className="text-muted">
      {" "}
      ({[what, ...fields.map((f) => `${f}: ${f === "file name" && what === "track" ? REMEDY.name : (REMEDY[f] ?? "edit it by hand")}`)].filter(Boolean).join("; ")}
      {extra ? `; ${extra}` : ""})
    </span>
  );
}

/**
 * Where words forgetting leaves alone still mention somebody: a title, caption, notes or description written by a
 * member, or before the album kept track of who wrote it; and the other things members type that can hold a name —
 * a file name, a place, a note, a web address, what the album knows about somebody else, a track's name, an import's
 * report. Each says what can be done about it, by its author (or an admin).
 */
export function MemberTextList({ text }: { text: MemberText }) {
  if (!Object.values(text).some((list) => list.length)) return null;
  return (
    <ul className="space-y-1 text-sm" data-testid="member-text">
      {text.photos.map((p) => (
        <li key={`p${p.id}`}>
          {/* One in the trash is seen to from the trash. */}
          <Link className="underline" href={p.trashed ? "/admin/trash" : `/photos/${p.id}`}>{p.label}</Link>
          <Fields fields={p.fields} extra={p.trashed ? "in the trash" : undefined} />
        </li>
      ))}
      {text.trips.map((t) => (
        <li key={`t${t.id}`}>
          <Link className="underline" href={`/trips/${t.slug}/settings`}>{t.title}</Link>
          <Fields what="trip" fields={t.fields.length ? t.fields : ["description"]} />
        </li>
      ))}
      {text.collections.map((c) => (
        <li key={`c${c.id}`}>
          <Link className="underline" href={`/collections/${c.slug}/settings`}>{c.title}</Link>
          <Fields what="collection" fields={c.fields.length ? c.fields : ["description"]} />
        </li>
      ))}
      {text.activities.map((a) => (
        <li key={`a${a.id}`}>
          <Link className="underline" href={`/trips/${a.tripSlug}/activities/${a.id}`}>{a.title}</Link>
          <span className="text-muted"> (activity description: edit it on the activity&apos;s page)</span>
        </li>
      ))}
      {text.people.map((x) => (
        <li key={`s${x.id}`}>
          <Link className="underline" href={`/people/${x.id}`}>{x.label}</Link>
          <Fields fields={x.fields} />
        </li>
      ))}
      {text.tracks.map((t) => (
        <li key={`k${t.id}`}>
          <Link className="underline" href={t.href}>{t.label}</Link>
          <Fields what="track" fields={t.fields} />
        </li>
      ))}
      {text.imports.map((i) => (
        <li key={`i${i.id}`} className="flex flex-wrap items-center gap-2">
          <span>{i.label}</span>
          <span className="text-muted">(Google Photos import report: an admin can clear it)</span>
          <form action={clearTakeoutReport.bind(null, i.id)}>
            <button type="submit" className="underline">Clear the report</button>
          </form>
        </li>
      ))}
    </ul>
  );
}

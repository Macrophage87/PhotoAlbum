import Link from "next/link";
import { db } from "@/lib/db";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { Button } from "@/components/ui";
import { MemberTextList } from "@/components/people/MemberTextList";
import { memberTextCount, type LeftoverItems, type MemberText } from "@/lib/people/forget";
import { dismissForgetLeftover } from "../actions";

export const metadata = { title: "Forgotten", robots: { index: false, follow: false } };

const day = (d: Date | null) => (d ? d.toLocaleDateString("en-US") : "no date");

/**
 * What is left after somebody was forgotten, for admins and the member who forgot them, until one of them is done
 * with it. The helper's words no longer say their name; these are words that do — a member's, or written before the
 * album kept track of who wrote them — linked so they can be edited. Nothing here, stored or shown, is the name
 * itself: each place is labelled by its date and its trip, never by words that may carry the name (a file name or a
 * web address can).
 */
export default async function ForgottenPage({ searchParams }: PageProps<"/people/forgotten">) {
  const user = await requireUser("/people/forgotten");
  // Straight after a forget: say it happened, since the person page it was done from no longer exists.
  const justDone = (await searchParams).done === "1";
  const viewer = await getViewer();
  const isAdmin = user.role === "ADMIN";
  const lists = await db.forgetLeftover.findMany({ where: { dismissedAt: null, ...(isAdmin ? {} : { createdById: user.id }) }, orderBy: { createdAt: "desc" } });
  const shown = await Promise.all(
    lists.map(async (l) => {
      // Ids and fields only: the name was never stored, and labels are made afresh from neutral facts. Lists made
      // before trips and collections were kept by id name them by address.
      const items = l.items as Partial<LeftoverItems>;
      const byKey = (xs: { id?: string; slug?: string }[] = []) => ({ OR: [{ id: { in: xs.flatMap((x) => (x.id ? [x.id] : [])) } }, { slug: { in: xs.flatMap((x) => (x.slug ? [x.slug] : [])) } }] });
      const fieldsBy = <F,>(xs: { id?: string; slug?: string; fields?: F[] }[] = []) => (row: { id: string; slug?: string }) => xs.find((x) => x.id === row.id || (x.slug && x.slug === row.slug))?.fields ?? [];
      const [photos, trips, collections, activities, people, tracks, imports] = await Promise.all([
        db.photo.findMany({ where: { id: { in: (items.photos ?? []).map((p) => p.id) } }, select: { id: true, takenAt: true, trashedAt: true, trip: { select: { startDate: true } } } }),
        db.trip.findMany({ where: byKey(items.trips), select: { id: true, slug: true, startDate: true } }),
        db.collection.findMany({ where: byKey(items.collections), select: { id: true, slug: true, createdAt: true } }),
        db.activity.findMany({ where: { id: { in: (items.activities ?? []).map((a) => a.id) } }, select: { id: true, startTime: true, trip: { select: { slug: true } } } }),
        db.person.findMany({ where: { id: { in: (items.people ?? []).map((x) => x.id) } }, select: { id: true, name: true } }),
        db.track.findMany({ where: { id: { in: (items.tracks ?? []).map((x) => x.id) } }, select: { id: true, startTime: true, trip: { select: { slug: true } }, activity: { select: { id: true } } } }),
        isAdmin ? db.takeoutImport.findMany({ where: { id: { in: (items.imports ?? []).map((x) => x.id) } }, select: { id: true, startedAt: true } }) : [],
      ]);
      const photoFields = new Map((items.photos ?? []).map((p) => [p.id, p.fields]));
      const text: MemberText = {
        // A photograph since deleted for good is not listed; one in the trash is, for its file name or trash note.
        photos: photos.map((p) => ({ id: p.id, label: `A photo from ${day(p.takenAt)}${p.trip ? `, on the trip of ${day(p.trip.startDate)}` : ""}`, fields: (photoFields.get(p.id) ?? []).filter((f) => !p.trashedAt || f === "file name" || f === "trash note"), ...(p.trashedAt ? { trashed: true } : {}) })).filter((p) => !p.trashed || p.fields.length),
        trips: trips.map((t) => ({ id: t.id, slug: t.slug, title: `The trip of ${day(t.startDate)}`, fields: fieldsBy(items.trips)(t) })),
        collections: collections.map((c) => ({ id: c.id, slug: c.slug, title: `A collection made ${day(c.createdAt)}`, fields: fieldsBy(items.collections)(c) })),
        activities: activities.map((a) => ({ id: a.id, title: `An outing on ${day(a.startTime)}`, tripSlug: a.trip.slug })),
        // Somebody else's name is not the forgotten one.
        people: people.map((x) => ({ id: x.id, label: x.name, fields: fieldsBy(items.people)(x) })),
        tracks: tracks.map((t) => ({ id: t.id, label: `A track from ${day(t.startTime)}`, href: t.activity ? `/trips/${t.trip.slug}/activities/${t.activity.id}` : `/trips/${t.trip.slug}`, fields: fieldsBy(items.tracks)(t) })),
        imports: imports.map((i) => ({ id: i.id, label: `The import of ${day(i.startedAt)}` })),
      };
      return { id: l.id, createdAt: l.createdAt, text, count: memberTextCount(text) };
    }),
  );
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 space-y-6 max-w-3xl">
        <div>
          <h1 className="font-display text-3xl font-semibold">Forgotten</h1>
          <p className="text-muted mt-1">When somebody is forgotten, their face data, their tags and their person page go, and their name is taken out of everything the AI helper wrote and out of the name search. Words members wrote themselves are left as they wrote them; these still mention a forgotten name. From then on the album keeps their full names out of what goes to and comes back from the AI helper, and a one-word name only on the photos they were tagged on: a first name alone, anywhere else, is not taken out. First names that are also months, like May or June, are never looked for, even on their own photos.</p>
        </div>
        {justDone && (
          <p className="rounded-theme border border-border bg-surface-alt p-3 text-sm" role="status" data-testid="forget-done">
            Done: they are forgotten. Their person page, their tags and their face data are deleted, and their name is out of everything the AI helper wrote.
            {shown.length > 0 ? " Anything members wrote that still mentions them is listed below." : ""}
          </p>
        )}
        {shown.length === 0 && <p>Nothing to edit: nothing members wrote still mentions anyone who has been forgotten.</p>}
        {shown.map((l) => (
          <section key={l.id} className="space-y-2 rounded-theme border border-border p-4" data-testid="forget-leftover">
            <p className="text-sm text-muted">Forgotten on {day(l.createdAt)}. Written by members, or before the album kept track of who wrote them. Each says what can be done about it; some things, like a file name, can&apos;t be edited, only removed. Ask whoever wrote it if it isn&apos;t yours to change.</p>
            {l.count ? <MemberTextList text={l.text} /> : <p className="text-sm">Everything listed has since been removed.</p>}
            <form action={dismissForgetLeftover.bind(null, l.id)}>
              <Button type="submit" size="sm" variant="secondary">Done with this list</Button>
            </form>
          </section>
        ))}
        <p><Link className="underline" href="/people">Back to People</Link></p>
      </Container>
    </AppShell>
  );
}

import Link from "next/link";
import { db } from "@/lib/db";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { Button } from "@/components/ui";
import { MemberTextList } from "@/components/people/MemberTextList";
import type { MemberText, MemberTextField } from "@/lib/people/forget";
import { dismissForgetLeftover } from "../actions";

export const metadata = { title: "Forgotten", robots: { index: false, follow: false } };

const day = (d: Date | null) => (d ? d.toLocaleDateString("en-US") : "no date");

/**
 * What is left after somebody was forgotten, for admins and the member who forgot them, until one of them is done
 * with it. The helper's words no longer say their name; these are words that do — a member's, or written before the
 * album kept track of who wrote them — linked so they can be edited. Nothing here, stored or shown, is the name
 * itself: each place is labelled by its file name, its date and its trip, never by words that may carry the name.
 */
export default async function ForgottenPage() {
  const user = await requireUser("/people/forgotten");
  const viewer = await getViewer();
  const isAdmin = user.role === "ADMIN";
  const lists = await db.forgetLeftover.findMany({ where: { dismissedAt: null, ...(isAdmin ? {} : { createdById: user.id }) }, orderBy: { createdAt: "desc" } });
  const shown = await Promise.all(
    lists.map(async (l) => {
      // Ids and fields only: the name was never stored, and labels are made afresh from neutral facts.
      const items = l.items as { photos: { id: string; fields: MemberTextField[] }[]; trips: { slug: string }[]; collections: { slug: string }[]; activities: { id: string }[] };
      const [photos, trips, collections, activities] = await Promise.all([
        db.photo.findMany({ where: { id: { in: items.photos.map((p) => p.id) }, trashedAt: null }, select: { id: true, originalName: true, takenAt: true, trip: { select: { startDate: true } } } }),
        db.trip.findMany({ where: { slug: { in: items.trips.map((t) => t.slug) } }, select: { id: true, slug: true, startDate: true } }),
        db.collection.findMany({ where: { slug: { in: items.collections.map((c) => c.slug) } }, select: { id: true, slug: true, createdAt: true } }),
        db.activity.findMany({ where: { id: { in: items.activities.map((a) => a.id) } }, select: { id: true, startTime: true, trip: { select: { slug: true } } } }),
      ]);
      const fields = new Map(items.photos.map((p) => [p.id, p.fields]));
      const text: MemberText = {
        photos: photos.map((p) => ({ id: p.id, label: `${p.originalName}, ${day(p.takenAt)}${p.trip ? `, on the trip of ${day(p.trip.startDate)}` : ""}`, fields: fields.get(p.id) ?? [] })),
        trips: trips.map((t) => ({ id: t.id, slug: t.slug, title: `The trip of ${day(t.startDate)}` })),
        collections: collections.map((c) => ({ id: c.id, slug: c.slug, title: `A collection made ${day(c.createdAt)}` })),
        activities: activities.map((a) => ({ id: a.id, title: `An outing on ${day(a.startTime)}`, tripSlug: a.trip.slug })),
      };
      return { id: l.id, createdAt: l.createdAt, text, count: photos.length + trips.length + collections.length + activities.length };
    }),
  );
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 space-y-6 max-w-3xl">
        <div>
          <h1 className="font-display text-3xl font-semibold">Forgotten</h1>
          <p className="text-muted mt-1">When somebody is forgotten, their face data, their tags and their person page go, and their name is taken out of everything the AI helper wrote and out of the name search. Words members wrote themselves are left as they wrote them; these still mention a forgotten name. From then on the album keeps their full names out of what goes to and comes back from the AI helper, and a one-word name only on the photos they were tagged on: a first name alone, anywhere else, is not taken out.</p>
        </div>
        {shown.length === 0 && <p>Nothing left to see to.</p>}
        {shown.map((l) => (
          <section key={l.id} className="space-y-2 rounded-theme border border-border p-4" data-testid="forget-leftover">
            <p className="text-sm text-muted">Forgotten on {day(l.createdAt)}. Written by members, or before the album kept track of who wrote them: open each to edit it, or ask whoever wrote it.</p>
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

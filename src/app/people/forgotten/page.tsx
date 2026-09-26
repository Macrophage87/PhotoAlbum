import Link from "next/link";
import { db } from "@/lib/db";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { MemberTextList } from "@/components/people/MemberTextList";
import type { MemberText } from "@/lib/people/forget";

export const metadata = { title: "Forgotten", robots: { index: false, follow: false } };

const list = (v: string | string[] | undefined) => (typeof v === "string" ? v.split(",").filter(Boolean).slice(0, 100) : []);

/**
 * Members-only: what is left after somebody was forgotten. The helper's words no longer say their name; these are
 * members' own words that do, linked so they can be edited. The address carries ids only, never the name.
 */
export default async function ForgottenPage({ searchParams }: PageProps<"/people/forgotten">) {
  await requireUser("/people");
  const viewer = await getViewer();
  const sp = await searchParams;
  const [photos, trips, collections, activities] = await Promise.all([
    db.photo.findMany({ where: { id: { in: list(sp.p) }, trashedAt: null }, select: { id: true, title: true, caption: true, originalName: true } }),
    db.trip.findMany({ where: { slug: { in: list(sp.t) } }, select: { slug: true, title: true } }),
    db.collection.findMany({ where: { slug: { in: list(sp.c) } }, select: { slug: true, title: true } }),
    db.activity.findMany({ where: { id: { in: list(sp.a) } }, select: { id: true, title: true, trip: { select: { slug: true } } } }),
  ]);
  const text: MemberText = {
    photos: photos.map((p) => ({ id: p.id, label: p.title?.trim() || p.caption?.trim() || p.originalName, fields: [] })),
    trips,
    collections,
    activities: activities.map((a) => ({ id: a.id, title: a.title, tripSlug: a.trip.slug })),
  };
  const any = photos.length + trips.length + collections.length + activities.length > 0;
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 space-y-4 max-w-3xl">
        <h1 className="font-display text-3xl font-semibold">Forgotten</h1>
        <p className="text-muted">Their face data, their tags and their person page are gone, and their name is out of everything the AI helper wrote and out of the name search.</p>
        {any ? (
          <>
            <p>What members wrote themselves is left as they wrote it. These still mention the name — written by members, or before the album kept track of who wrote them; open each to edit it, or ask whoever wrote it:</p>
            <MemberTextList text={text} />
          </>
        ) : (
          <p>Nothing left mentions the name.</p>
        )}
        <p><Link className="underline" href="/people">Back to People</Link></p>
      </Container>
    </AppShell>
  );
}

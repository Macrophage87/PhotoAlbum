import { getViewer, requireUser } from "@/lib/auth/viewer";
import { unassignedPhotoPage } from "@/lib/photos/queries";
import { AppShell, Container } from "@/components/layout/AppShell";
import { UnassignedGallery } from "@/components/photos/UnassignedGallery";
import { toGridPhoto, uploaderLabel } from "@/components/photos/toGrid";
import { SelectionProvider } from "@/components/photos/selection";
import { GalleryFilters } from "@/components/photos/GalleryFilters";
import { describeCount, filterIsActive, filterQuery, parseGalleryFilter } from "@/lib/photos/filters";
import { ButtonLink } from "@/components/ui";
import { db } from "@/lib/db";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { peopleInPhotos } from "@/lib/people/in-photos";
import { localYearSql } from "@/lib/time/local-day-sql";

export const metadata = { title: "Photos without a trip" };

/** Members-only: everything uploaded that has not landed on a trip yet, with bulk attach actions. */
export default async function UnassignedPhotosPage({ searchParams }: PageProps<"/photos">) {
  await requireUser("/photos");
  const viewer = await getViewer();
  const sp = await searchParams;
  const filter = parseGalleryFilter(sp, { member: true });
  const [{ photos, nextCursor, matched, total }, members, people, years] = await Promise.all([
    unassignedPhotoPage(filter),
    db.user.findMany({ where: { photos: { some: { tripId: null, ...NOT_TRASHED } } }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }),
    peopleInPhotos(),
    // The years these actually cover, so the list offers nothing that would come back empty.
    db.$queryRaw<{ year: number }[]>`
      SELECT DISTINCT ${localYearSql()} AS year
      FROM "Photo" p LEFT JOIN "Trip" t ON t.id = p."tripId" WHERE p."tripId" IS NULL AND p."trashedAt" IS NULL AND p."takenAt" IS NOT NULL ORDER BY year DESC`,
  ]);
  const active = filterIsActive(filter);
  // Further pages keep the narrowing, so the next page of a search is the next page of that same search.
  const query = filterQuery(filter);
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-semibold">Photos without a trip</h1>
            <p className="text-muted mt-1">Uploads that did not match a trip by date. Select them to add to a trip or a collection.</p>
          </div>
          <ButtonLink href="/upload" size="sm">Upload</ButtonLink>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <GalleryFilters
            filter={filter}
            action="/photos"
            members={members.map((m) => ({ id: m.id, label: uploaderLabel(m.name, m.email) }))}
            people={people}
            years={years.map((y) => y.year)}
            placeholder="Search these photos"
          />
          <span className="text-sm text-muted">{describeCount(matched, total, active)}</span>
        </div>
        <SelectionProvider>
          {/* Keyed on what is shown, so once a selection has been filed on a trip the grid starts again without it. */}
          <UnassignedGallery
            key={`${query}:${matched}:${photos[0]?.id ?? ""}`}
            photos={photos.map((p) => toGridPhoto(p, null, viewer.user))}
            emptyMessage={active ? "Nothing here matches that. Try fewer words, or clear the filters." : "Every photo is on a trip."}
            more={{ url: `/api/photos/unassigned${query ? `?${query}` : ""}`, nextCursor, total: matched }}
          />
        </SelectionProvider>
      </Container>
    </AppShell>
  );
}

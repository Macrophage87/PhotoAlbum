import type { MediaKind } from "@/generated/prisma/enums";
import { getViewer } from "@/lib/auth/viewer";
import { normalizeQuery, searchFacets, searchMedia } from "@/lib/search/query";
import { photoUrl } from "@/lib/photos/urls";
import { formatLocalTime } from "@/lib/time/format";
import { uploaderLabel } from "@/components/photos/toGrid";
import { AppShell, Container } from "@/components/layout/AppShell";
import { SearchBox } from "@/components/search/SearchBox";
import { CollectionFacetField, TripFacetField } from "@/components/containers/FacetFields";
import { SearchResults, type SearchResult } from "@/components/search/SearchResults";
import { Button } from "@/components/ui";
import { SelectionProvider } from "@/components/photos/selection";

export const metadata = { title: "Search" };

const KINDS = [
  { value: "", label: "Photos and videos" },
  { value: "PHOTO", label: "Photos" },
  { value: "VIDEO", label: "Clips" },
  { value: "EXTERNAL_VIDEO", label: "YouTube videos" },
] as const;

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const viewer = await getViewer();
  const sp = await searchParams;
  const member = viewer.kind === "user";
  const q = normalizeQuery(str(sp.q) ?? "");
  const kindRaw = str(sp.kind);
  const kind: MediaKind | undefined = kindRaw === "PHOTO" || kindRaw === "VIDEO" || kindRaw === "EXTERNAL_VIDEO" ? (kindRaw as MediaKind) : undefined;
  const year = Number(str(sp.year));
  const params = { q, tripId: str(sp.trip), collectionId: str(sp.collection), uploaderId: member ? str(sp.uploader) : undefined, personId: member ? str(sp.person) : undefined, year: Number.isInteger(year) && year > 0 ? year : undefined, kind };
  const [facets, hits] = await Promise.all([
    searchFacets(viewer),
    q ? searchMedia(viewer, params) : Promise.resolve([]),
  ]);
  // Only the ones the query already names: the boxes search for the rest.
  const currentTrip = facets.trips.find((t) => t.id === params.tripId) ?? null;
  const currentCollection = facets.collections.find((c) => c.id === params.collectionId) ?? null;
  const results: SearchResult[] = hits.map((h) => ({
    id: h.id,
    thumbUrl: photoUrl(h, "thumb"),
    mediumUrl: photoUrl(h, "medium"),
    width: h.width,
    height: h.height,
    caption: h.caption,
    title: h.title,
    alt: h.caption ?? h.title ?? h.originalName,
    snippet: h.snippet,
    tripSlug: h.tripSlug,
    tripTitle: h.tripTitle,
    when: h.takenAt ? formatLocalTime(h.takenAt, { offsetMin: h.tzOffsetMin }, "MMM d, yyyy") : null,
    uploadedBy: member ? uploaderLabel(h.uploaderName) : null,
    youtubeId: h.kind === "EXTERNAL_VIDEO" ? h.externalId : null,
    videoUrl: h.kind === "VIDEO" ? photoUrl(h, "video") : null,
    durationS: h.durationS,
  }));
  const select = "h-9 rounded-theme border border-border bg-surface px-2 text-sm";
  const field = "flex flex-col gap-1";
  const fieldLabel = "text-xs text-muted";
  const humans = facets.people.filter((p) => p.kind === "HUMAN");
  const pets = facets.people.filter((p) => p.kind === "PET");
  // Anything beyond the words itself decides whether the extra questions arrive open.
  const narrowing = Boolean(params.tripId || params.collectionId || params.uploaderId || params.personId || params.year || kind);

  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 space-y-6">
        <h1 className="font-display text-3xl font-semibold">Search</h1>
        <form action="/search" method="get" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 max-w-xl">
            <div className="flex-1 min-w-52"><SearchBox initial={q} /></div>
            <Button type="submit" variant="secondary" size="sm">Search</Button>
          </div>
          <details open={narrowing} data-testid="advanced-filters">
            <summary className="text-sm text-muted cursor-pointer select-none w-fit">More ways to narrow</summary>
            <div className="flex flex-wrap items-end gap-3 pt-3 text-sm">
              <div className={`${field} w-52`}>
                <span className={fieldLabel}>Trip</span>
                <TripFacetField initial={currentTrip} />
              </div>
              <div className={`${field} w-52`}>
                <span className={fieldLabel}>Collection</span>
                <CollectionFacetField initial={currentCollection} />
              </div>
              {member && facets.uploaders.length > 0 && (
                <div className={field}>
                  <label className={fieldLabel} htmlFor="search-uploader">Uploaded by</label>
                  <select id="search-uploader" name="uploader" defaultValue={params.uploaderId ?? ""} className={select}>
                    <option value="">Anyone</option>
                    {facets.uploaders.map((u) => (
                      <option key={u.id} value={u.id}>{uploaderLabel(u.name, u.email)}</option>
                    ))}
                  </select>
                </div>
              )}
              {member && facets.people.length > 0 && (
                <div className={field}>
                  <label className={fieldLabel} htmlFor="search-person">Who is in it</label>
                  <select id="search-person" name="person" defaultValue={params.personId ?? ""} className={select} data-testid="who-filter">
                    <option value="">Anybody</option>
                    {humans.length > 0 && (
                      <optgroup label="People">
                        {humans.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </optgroup>
                    )}
                    {pets.length > 0 && (
                      <optgroup label="Pets">
                        {pets.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
              )}
              <div className={field}>
                <label className={fieldLabel} htmlFor="search-year">Year</label>
                <select id="search-year" name="year" defaultValue={params.year ?? ""} className={select}>
                  <option value="">Any year</option>
                  {facets.years.map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
              <div className={field}>
                <label className={fieldLabel} htmlFor="search-kind">Type</label>
                <select id="search-kind" name="kind" defaultValue={kind ?? ""} className={select}>
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>{k.label}</option>
                  ))}
                </select>
              </div>
              <Button type="submit" variant="secondary" size="sm">Search</Button>
            </div>
          </details>
        </form>
        {q && (
          <p className="text-sm text-muted" role="status">
            {results.length === 0 ? `Nothing matches “${q}”.` : `${results.length} result${results.length === 1 ? "" : "s"} for “${q}”.`}
          </p>
        )}
        {results.length > 0 && (member ? (
          <SelectionProvider>
            <SearchResults results={results} member={member} />
          </SelectionProvider>
        ) : (
          <SearchResults results={results} member={member} />
        ))}
        {!q && <p className="text-sm text-muted">Search captions, notes, titles, trips and collections. Try a place, a food or a year{member ? ", or a family member\u2019s name" : ""}.</p>}
      </Container>
    </AppShell>
  );
}

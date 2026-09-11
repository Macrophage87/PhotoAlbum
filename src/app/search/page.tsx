import type { MediaKind } from "@/generated/prisma/enums";
import { getViewer } from "@/lib/auth/viewer";
import { normalizeQuery, searchFacets, searchMedia } from "@/lib/search/query";
import { photoUrl } from "@/lib/photos/urls";
import { formatLocalTime } from "@/lib/time/format";
import { uploaderLabel } from "@/components/photos/toGrid";
import { AppShell, Container } from "@/components/layout/AppShell";
import { SearchBox } from "@/components/search/SearchBox";
import { SearchResults, type SearchResult } from "@/components/search/SearchResults";
import { Button } from "@/components/ui";
import { db } from "@/lib/db";
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
  const [facets, hits, tripOptions, collectionOptions] = await Promise.all([
    searchFacets(viewer),
    q ? searchMedia(viewer, params) : Promise.resolve([]),
    member ? db.trip.findMany({ orderBy: { startDate: "desc" }, select: { id: true, title: true } }) : Promise.resolve([]),
    member ? db.collection.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } }) : Promise.resolve([]),
  ]);
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

  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 space-y-6">
        <h1 className="font-display text-3xl font-semibold">Search</h1>
        <form action="/search" method="get" className="space-y-3">
          <div className="max-w-xl">
            <SearchBox initial={q} />
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <select name="trip" defaultValue={params.tripId ?? ""} className={select} aria-label="Trip">
              <option value="">Any trip</option>
              {facets.trips.map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
            <select name="collection" defaultValue={params.collectionId ?? ""} className={select} aria-label="Collection">
              <option value="">Any collection</option>
              {facets.collections.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </select>
            {member && facets.uploaders.length > 0 && (
              <select name="uploader" defaultValue={params.uploaderId ?? ""} className={select} aria-label="Uploaded by">
                <option value="">Uploaded by anyone</option>
                {facets.uploaders.map((u) => (
                  <option key={u.id} value={u.id}>{uploaderLabel(u.name, u.email)}</option>
                ))}
              </select>
            )}
            {member && facets.people.length > 0 && (
              <select name="person" defaultValue={params.personId ?? ""} className={select} aria-label="Person">
                <option value="">Anyone in the picture</option>
                {facets.people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
            <select name="year" defaultValue={params.year ?? ""} className={select} aria-label="Year">
              <option value="">Any year</option>
              {facets.years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            <select name="kind" defaultValue={kind ?? ""} className={select} aria-label="Type">
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </select>
            <Button type="submit" variant="secondary" size="sm">Search</Button>
          </div>
        </form>
        {q && (
          <p className="text-sm text-muted" role="status">
            {results.length === 0 ? `Nothing matches “${q}”.` : `${results.length} result${results.length === 1 ? "" : "s"} for “${q}”.`}
          </p>
        )}
        {results.length > 0 && (member ? (
          <SelectionProvider trips={tripOptions} collections={collectionOptions}>
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

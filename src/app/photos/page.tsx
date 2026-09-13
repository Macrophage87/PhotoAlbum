import { getViewer, requireUser } from "@/lib/auth/viewer";
import { listUnassignedPhotos } from "@/lib/photos/queries";
import { AppShell, Container } from "@/components/layout/AppShell";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";
import { SelectionProvider } from "@/components/photos/selection";
import { ButtonLink } from "@/components/ui";

export const metadata = { title: "Photos without a trip" };

/** Members-only: everything uploaded that has not landed on a trip yet, with bulk attach actions. */
export default async function UnassignedPhotosPage() {
  await requireUser("/photos");
  const viewer = await getViewer();
  const photos = await listUnassignedPhotos();
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
        <SelectionProvider>
          <PhotoGrid photos={photos.map((p) => toGridPhoto(p, null, true))} emptyMessage="Every photo is on a trip." />
        </SelectionProvider>
      </Container>
    </AppShell>
  );
}

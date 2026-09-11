import { requireUser, getViewer } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { CollectionForm } from "@/components/collections/CollectionForm";
import { createCollection } from "../actions";

export const metadata = { title: "New collection" };

export default async function NewCollectionPage() {
  await requireUser("/collections/new");
  const viewer = await getViewer();
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 max-w-2xl">
        <h1 className="font-display text-3xl font-semibold mb-2">New collection</h1>
        <p className="text-muted mb-6">A collection gathers photos from any trip, or none, around a theme: a person, a place, a year, the dog.</p>
        <CollectionForm action={createCollection} submitLabel="Create collection" initial={{ title: "", description: "", themeKey: "default" }} />
      </Container>
    </AppShell>
  );
}

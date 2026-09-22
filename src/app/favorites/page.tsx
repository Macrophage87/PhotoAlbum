import { AppShell, Container } from "@/components/layout/AppShell";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { FavouritesView, parseWho } from "@/components/favourites/FavouritesView";

export const metadata = { title: "Favorites", robots: { index: false, follow: false } };

/** Every favourite in the album, whatever trip or collection it sits in. Members only: a favourite is a person's. */
export default async function FavouritesPage({ searchParams }: PageProps<"/favorites">) {
  const sp = await searchParams;
  await requireUser("/favorites");
  const viewer = await getViewer();
  if (viewer.kind !== "user") return null;
  return (
    <AppShell viewer={viewer}>
      <Container className="py-8">
        <FavouritesView viewer={viewer} scope={{}} who={parseWho(sp.who)} base="/favorites" where="" />
      </Container>
    </AppShell>
  );
}

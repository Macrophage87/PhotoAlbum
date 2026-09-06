import { getViewer } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";

export default async function HomePage() {
  const viewer = await getViewer();
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10">
        <h1 className="font-display text-3xl font-semibold">Trips</h1>
        <p className="text-muted mt-2">
          {viewer.kind === "user" ? "No trips yet. Create the first one." : "Sign in to see the family's trips."}
        </p>
      </Container>
    </AppShell>
  );
}

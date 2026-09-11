import Link from "next/link";
import { db } from "@/lib/db";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { UploadPanel } from "./UploadPanel";

export const metadata = { title: "Upload" };

export default async function UploadPage({ searchParams }: PageProps<"/upload">) {
  await requireUser("/upload");
  const viewer = await getViewer();
  const sp = await searchParams;
  const tripSlug = typeof sp.trip === "string" ? sp.trip : undefined;
  const trips = await db.trip.findMany({ orderBy: { startDate: "desc" }, select: { id: true, slug: true, title: true } });
  const selected = trips.find((t) => t.slug === tripSlug);

  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 max-w-3xl space-y-6">
        <div>
          <h1 className="font-display text-3xl font-semibold">Upload photos</h1>
          <p className="text-muted mt-1">
            Photos are matched to a trip by the date they were taken unless you pick one; the rest wait under <Link href="/photos" className="text-primary underline-offset-2 hover:underline">photos without a trip</Link>. {selected && <>Uploading to <Link href={`/trips/${selected.slug}`} className="text-primary underline-offset-2 hover:underline">{selected.title}</Link>.</>}
          </p>
        </div>
        <UploadPanel trips={trips} initialTripId={selected?.id} />
      </Container>
    </AppShell>
  );
}

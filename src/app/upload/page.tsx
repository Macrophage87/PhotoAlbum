import Link from "next/link";
import { db } from "@/lib/db";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { UploadPanel } from "./UploadPanel";
import { env } from "@/lib/env";
import { annotationGates } from "@/lib/annotation/eligibility";
import { GooglePickerButton } from "@/components/google/GooglePickerButton";
import { googleStatus } from "@/lib/google/account";
import { googleConfigured } from "@/lib/google/oauth";
import { uploadByteLimits } from "@/lib/media/upload-limits";

export const metadata = { title: "Upload" };

export default async function UploadPage({ searchParams }: PageProps<"/upload">) {
  const me = await requireUser("/upload");
  const viewer = await getViewer();
  const sp = await searchParams;
  const tripSlug = typeof sp.trip === "string" ? sp.trip : undefined;
  const trips = await db.trip.findMany({ orderBy: { startDate: "desc" }, select: { id: true, slug: true, title: true } });
  const selected = trips.find((t) => t.slug === tripSlug);
  // Reached from a collection's page, uploads go into that collection.
  const collectionSlug = typeof sp.collection === "string" ? sp.collection : undefined;
  const collection = collectionSlug ? await db.collection.findUnique({ where: { slug: collectionSlug }, select: { id: true, slug: true, title: true } }) : null;
  const gates = await annotationGates();
  const google = googleConfigured() ? await googleStatus(me.id) : null;
  const googleNotice = typeof sp.google === "string" ? sp.google : null;

  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 max-w-3xl space-y-6">
        <div>
          <h1 className="font-display text-3xl font-semibold">Upload photos and clips</h1>
          <p className="text-muted mt-1">
            Photos are matched to a trip by the date they were taken unless you pick one; the rest wait under <Link href="/photos" className="text-primary underline underline-offset-2">photos without a trip</Link>. {selected && <>Uploading to <Link href={`/trips/${selected.slug}`} className="text-primary underline underline-offset-2">{selected.title}</Link>.</>}{" "}
            {collection && <>Adding to the collection <Link href={`/collections/${collection.slug}`} className="text-primary underline underline-offset-2">{collection.title}</Link>.</>}{" "}
            Anything the album already has is put where you choose rather than copied.
          </p>
        </div>
        <UploadPanel initialTrip={selected ? { id: selected.id, title: selected.title } : null} initialCollection={collection ? { id: collection.id, title: collection.title } : null} maxClipSeconds={env().MAX_CLIP_SECONDS} maxBytes={uploadByteLimits()} annotationActive={gates.active} />
        {google && (
          <>
            {googleNotice && googleNotice !== "connected" && <p role="alert" className="text-sm rounded-theme bg-amber-50 border border-amber-200 text-amber-900 p-3">{googleNotice === "denied" ? "Google Photos was not connected: permission was declined." : googleNotice === "scope" ? "Google Photos was not connected: the photo-picking permission was not granted." : googleNotice === "state" ? "That sign-in link had expired; try connecting again." : "Google Photos could not be connected; try again in a moment."}</p>}
            <GooglePickerButton status={google} configured tripId={selected?.id ?? null} next={selected ? `/upload?trip=${selected.slug}` : "/upload"} />
          </>
        )}
      </Container>
    </AppShell>
  );
}

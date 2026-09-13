import { redirect } from "next/navigation";
import { requireTripOwnerPage } from "@/lib/trips/access";
import { coverFor } from "@/lib/trips/queries";
import { tripCoverCandidates } from "@/lib/covers/candidates";
import { CoverPicker } from "@/components/covers/CoverPicker";
import { setCoverPhoto } from "../actions";

export const metadata = { title: "Cover photo" };

export default async function TripCoverPage({ params, searchParams }: PageProps<"/trips/[slug]/cover">) {
  const { slug } = await params;
  const { trip } = await requireTripOwnerPage(slug, `/trips/${slug}/cover`);
  const sp = await searchParams;
  const after = typeof sp.after === "string" && sp.after ? sp.after : null;
  const [page, automatic] = await Promise.all([tripCoverCandidates(trip.id, after), coverFor(trip)]);

  return (
    <CoverPicker
      title={trip.title}
      backHref={`/trips/${slug}/settings`}
      current={trip.coverPhoto}
      automatic={automatic}
      photos={page.photos}
      nextCursor={page.nextCursor}
      total={page.total}
      pageHref={`/trips/${slug}/cover`}
      choose={async (photoId: string) => {
        "use server";
        await setCoverPhoto(slug, photoId);
        redirect(`/trips/${slug}/cover?chosen=1`);
      }}
      clear={async () => {
        "use server";
        await setCoverPhoto(slug, null);
        redirect(`/trips/${slug}/cover`);
      }}
    />
  );
}

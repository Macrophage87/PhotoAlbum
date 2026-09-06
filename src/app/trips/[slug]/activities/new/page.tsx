import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/viewer";
import { getTripBySlug } from "@/lib/trips/queries";
import { dateColumnToDay } from "@/lib/time/local-day";
import { ActivityForm } from "@/components/activities/ActivityForm";
import { createActivity } from "../actions";

export default async function NewActivityPage({ params }: PageProps<"/trips/[slug]/activities/new">) {
  const { slug } = await params;
  await requireUser(`/trips/${slug}/activities/new`);
  const trip = await getTripBySlug(slug);
  if (!trip) notFound();
  const day = dateColumnToDay(trip.startDate);
  return (
    <div className="max-w-2xl">
      <h2 className="font-display text-xl font-semibold mb-4">Add activity</h2>
      <ActivityForm action={createActivity.bind(null, slug)} submitLabel="Add activity" timezone={trip.timezone} initial={{ title: "", type: "HIKE", start: `${day}T09:00`, end: `${day}T12:00`, description: "" }} />
    </div>
  );
}

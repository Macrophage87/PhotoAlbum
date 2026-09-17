import { redirect } from "next/navigation";
import { filterQuery, parseGalleryFilter } from "@/lib/photos/filters";

/**
 * The timeline is the trip's own page now. This keeps every link and bookmark that was made when it lived here
 * working, narrowing and all.
 */
export default async function TripTimelineRedirect({ params, searchParams }: PageProps<"/trips/[slug]/timeline">) {
  const { slug } = await params;
  const query = filterQuery(parseGalleryFilter(await searchParams, { member: true }));
  redirect(`/trips/${slug}${query ? `?${query}` : ""}`);
}

import { redirect } from "next/navigation";
import { filterQuery, parseGalleryFilter } from "@/lib/photos/filters";

/** The timeline is the collection's own page now; this keeps the older address working. */
export default async function CollectionTimelineRedirect({ params, searchParams }: PageProps<"/collections/[slug]/timeline">) {
  const { slug } = await params;
  const query = filterQuery(parseGalleryFilter(await searchParams, { member: true }));
  redirect(`/collections/${slug}${query ? `?${query}` : ""}`);
}

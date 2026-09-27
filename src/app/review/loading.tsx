// Per list page, not at the root: a root loading boundary wraps every route, and a page streamed behind one has
// already answered 200 by the time its layout finds the trip, collection or share link missing, so the 404 is lost.
export { PageSkeleton as default } from "@/components/layout/PageSkeleton";

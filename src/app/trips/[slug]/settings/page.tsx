import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/viewer";
import { env } from "@/lib/env";
import { getTripBySlug } from "@/lib/trips/queries";
import { dateColumnToDay } from "@/lib/time/local-day";
import { TripForm } from "@/components/trips/TripForm";
import { ShareButtons } from "@/components/trips/ShareButtons";
import { shareableTripUrl } from "@/lib/share/social";
import { Button, Card, ConfirmSubmitButton } from "@/components/ui";
import { deleteTrip, detachExposedFromCollections, regeotagPhotos, rotateShareToken, setVisibility, updateTrip } from "../actions";
import { VisibilityForm } from "@/components/trips/VisibilityForm";
import { OptOutToggle } from "@/components/annotation/OptOutToggle";
import { visibilityWarnings } from "@/lib/visibility/settings";
import Link from "next/link";

const VISIBILITY = [
  { value: "PRIVATE", label: "Private", help: "Only signed-in family members can see this trip." },
  { value: "LINK", label: "Anyone with the link", help: "A secret link lets relatives without accounts view everything on this trip: photos, activities and location traces." },
  { value: "PUBLIC", label: "Public", help: "Anyone can browse this trip without signing in, and it appears on the front page. Location traces show where people were and when." },
] as const;

export default async function TripSettingsPage({ params, searchParams }: PageProps<"/trips/[slug]/settings">) {
  const { slug } = await params;
  const sp = await searchParams;
  const me = await requireUser(`/trips/${slug}/settings`);
  const trip = await getTripBySlug(slug);
  if (!trip) notFound();
  const update = updateTrip.bind(null, slug);
  const visibility = setVisibility.bind(null, slug);
  const rotate = rotateShareToken.bind(null, slug);
  const remove = deleteTrip.bind(null, slug);
  const regeotag = regeotagPhotos.bind(null, slug);
  const shareUrl = shareableTripUrl(trip, env().APP_URL);
  const warnings = await visibilityWarnings("trip", trip.id, trip.visibility, "this trip");
  const detach = detachExposedFromCollections.bind(null, slug);

  return (
    <div className="max-w-2xl space-y-10">
      {sp.saved && <p className="rounded-theme bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm p-3">Saved.</p>}
      {sp.regeotag && <p className="rounded-theme bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm p-3">Re-positioning photos from tracks in the background.</p>}

      <section>
        <h2 className="font-display text-xl font-semibold mb-4">Trip details</h2>
        <TripForm
          action={update}
          submitLabel="Save changes"
          initial={{ title: trip.title, description: trip.description ?? "", startDate: dateColumnToDay(trip.startDate), endDate: dateColumnToDay(trip.endDate), timezone: trip.timezone, themeKey: trip.themeKey }}
        />
      </section>

      <section>
        <h2 className="font-display text-xl font-semibold mb-4">Who can see this trip</h2>
        <VisibilityForm action={visibility} current={trip.visibility} options={VISIBILITY.map((v) => ({ ...v, warnings: warnings.byTarget[v.value] }))} />
        {warnings.stillExposed.length > 0 && (
          <Card className="mt-4 p-4 space-y-2 border-amber-300 bg-amber-50 text-amber-900">
            <div className="text-sm font-medium">Still visible elsewhere</div>
            {warnings.stillExposed.map((line) => (
              <p key={line} className="text-sm">{line}</p>
            ))}
            <p className="text-sm">Visibility is a union: a photo can be seen by anyone who may open its trip or any collection holding it.</p>
            <div className="flex flex-wrap gap-2 items-center">
              <form action={detach}>
                <Button type="submit" variant="secondary" size="sm">{trip.visibility === "PRIVATE" ? "Make these photos private everywhere (remove them from those collections)" : "Remove these photos from the more visible collections"}</Button>
              </form>
              {warnings.exposingContainers.filter((c) => c.kind === "collection").map((c) => (
                <Link key={c.id} href={`/collections/${c.slug}/settings`} className="text-sm underline underline-offset-2">Open {c.title}</Link>
              ))}
            </div>
          </Card>
        )}
        {warnings.alsoElsewhere > 0 && warnings.stillExposed.length === 0 && (
          <p className="mt-3 text-sm text-muted">{warnings.alsoElsewhere} of this trip&apos;s {warnings.total} photos are also in a collection; changing visibility here does not change theirs.</p>
        )}
        {trip.visibility === "LINK" && shareUrl && (
          <Card className="mt-4 p-4 space-y-2">
            <div className="text-sm font-medium">Share link</div>
            <code className="block text-xs break-all bg-surface-alt rounded p-2">{shareUrl}</code>
            <div className="flex flex-wrap gap-2">
              <form action={rotate}>
                <Button type="submit" variant="secondary" size="sm">
                  Generate a new link (old link stops working)
                </Button>
              </form>
              <ShareButtons url={shareUrl} />
            </div>
            <p className="text-xs text-muted">Posting the link on Facebook shows the trip title and cover photo. Anyone who sees the post can open the trip, so prefer a private group or message.</p>
          </Card>
        )}
        {trip.visibility === "PUBLIC" && shareUrl && (
          <Card className="mt-4 p-4 space-y-2">
            <div className="text-sm font-medium">Share</div>
            <code className="block text-xs break-all bg-surface-alt rounded p-2">{shareUrl}</code>
            <ShareButtons url={shareUrl} />
          </Card>
        )}
      </section>

      <section>
        <h2 className="font-display text-xl font-semibold mb-2">AI descriptions</h2>
        <OptOutToggle target={{ kind: "trip", id: trip.id }} initial={trip.annotationOptOut} />
      </section>

      <section>
        <h2 className="font-display text-xl font-semibold mb-2">Photo locations</h2>
        <p className="text-sm text-muted mb-3">
          Photos without GPS are placed on the map using any track that covers the moment they were taken. Run this again after importing tracks or fixing photo times.
        </p>
        <form action={regeotag}>
          <Button type="submit" variant="secondary">Re-position photos from tracks</Button>
        </form>
      </section>

      <section>
        <h2 className="font-display text-xl font-semibold mb-2 text-red-700">Delete trip</h2>
        {me.role === "ADMIN" ? (
          <>
            <p className="text-sm text-muted mb-3">Activities and tracks on this trip are deleted. The {trip._count.photos} photo{trip._count.photos === 1 ? "" : "s"} stay in the album and move to <em>photos without a trip</em>, where they can be filed again.</p>
            <form action={remove}>
              <ConfirmSubmitButton variant="danger" confirmMessage={`Delete "${trip.title}"? Its activities and tracks are removed permanently; the photos are kept and become unassigned. This cannot be undone.`}>
                Delete this trip
              </ConfirmSubmitButton>
            </form>
          </>
        ) : (
          <p className="text-sm text-muted">Only an admin can delete a trip. Photos are never deleted with it.</p>
        )}
      </section>
    </div>
  );
}

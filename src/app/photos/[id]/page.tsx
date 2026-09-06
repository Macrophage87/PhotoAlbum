import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { photoUrl } from "@/lib/photos/urls";
import { AppShell, Container } from "@/components/layout/AppShell";
import { ExifPanel } from "@/components/photos/ExifPanel";
import { Button, Card, Label, Select, Textarea, ConfirmSubmitButton } from "@/components/ui";
import { formatDateTime } from "@/lib/time/format";
import { deletePhoto, reprocessPhoto, setAsCover, shiftPhotoTimezone, updatePhoto } from "./actions";
import { TimezoneShift } from "@/components/photos/TimezoneShift";
import { PhotoLinkEditor } from "@/components/photos/PhotoLinkEditor";
import { LinkedPhotos } from "@/components/photos/LinkedPhotos";
import { linkedPhotos } from "@/lib/photos/links";
import { linkPhotos, unlinkPhotos } from "@/app/photos/link-actions";

export default async function PhotoPage({ params }: PageProps<"/photos/[id]">) {
  const { id } = await params;
  await requireUser(`/photos/${id}`);
  const viewer = await getViewer();
  const photo = await db.photo.findUnique({
    where: { id },
    include: { trip: { select: { id: true, slug: true, title: true, timezone: true, coverPhotoId: true } }, activity: { select: { id: true, title: true } }, uploader: { select: { name: true, email: true } } },
  });
  if (!photo) notFound();

  const [trips, activities, links, candidates] = await Promise.all([
    db.trip.findMany({ orderBy: { startDate: "desc" }, select: { id: true, title: true } }),
    photo.tripId ? db.activity.findMany({ where: { tripId: photo.tripId }, orderBy: { startTime: "asc" }, select: { id: true, title: true, startTime: true } }) : Promise.resolve([]),
    linkedPhotos(photo.id),
    photo.tripId
      ? db.photo.findMany({ where: { tripId: photo.tripId, status: "READY", id: { not: photo.id } }, orderBy: [{ takenAt: "asc" }], select: { id: true, caption: true, originalName: true, takenAt: true, updatedAt: true } })
      : Promise.resolve([]),
  ]);
  const link = linkPhotos.bind(null, id);
  const update = updatePhoto.bind(null, id);
  const remove = deletePhoto.bind(null, id);
  const reprocess = reprocessPhoto.bind(null, id);
  const cover = setAsCover.bind(null, id);
  const shift = shiftPhotoTimezone.bind(null, id);
  const isCover = photo.trip?.coverPhotoId === photo.id;

  return (
    <AppShell viewer={viewer}>
      <Container className="py-8">
        <div className="text-sm text-muted mb-4">
          {photo.trip ? (
            <>
              <Link href={`/trips/${photo.trip.slug}`} className="text-primary hover:underline">{photo.trip.title}</Link>
              {" / "}
              <Link href={`/trips/${photo.trip.slug}/photos`} className="text-primary hover:underline">Photos</Link>
            </>
          ) : (
            <span>Unassigned photo</span>
          )}
        </div>
        <div className="grid lg:grid-cols-[1fr_22rem] gap-8">
          <div>
            {photo.status === "READY" ? (
              <a href={photoUrl(photo, "original")} target="_blank" rel="noreferrer" title="Open original">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl(photo, "medium")} alt={photo.caption ?? photo.originalName} className="w-full rounded-theme bg-surface-alt" />
              </a>
            ) : (
              <div className="aspect-[4/3] rounded-theme bg-surface-alt flex items-center justify-center text-muted">
                {photo.status === "FAILED" ? `Processing failed: ${photo.error}` : "Processing…"}
              </div>
            )}
            {photo.caption && <p className="mt-3 text-lg">{photo.caption}</p>}
            {photo.takenAt && <p className="text-sm text-muted mt-1">{formatDateTime(photo.takenAt, photo.trip?.timezone ?? "UTC")}</p>}
          </div>

          <div className="space-y-6">
            <Card className="p-4">
              <form action={update} className="space-y-4">
                <div>
                  <Label htmlFor="caption">Caption</Label>
                  <Textarea id="caption" name="caption" rows={3} defaultValue={photo.caption ?? ""} />
                </div>
                <div>
                  <Label htmlFor="tripId">Trip</Label>
                  <Select id="tripId" name="tripId" defaultValue={photo.tripId ?? ""}>
                    <option value="">Not on a trip</option>
                    {trips.map((t) => (
                      <option key={t.id} value={t.id}>{t.title}</option>
                    ))}
                  </Select>
                </div>
                {photo.tripId && (
                  <div>
                    <Label htmlFor="activityId">Activity</Label>
                    <Select id="activityId" name="activityId" defaultValue={photo.activityId ?? ""}>
                      <option value="">None</option>
                      {activities.map((a) => (
                        <option key={a.id} value={a.id}>{a.title}</option>
                      ))}
                    </Select>
                  </div>
                )}
                <Button type="submit">Save</Button>
              </form>
            </Card>

            <Card className="p-4">
              <h2 className="font-medium mb-2">Details</h2>
              <ExifPanel photo={photo} tripTimezone={photo.trip?.timezone} />
              <p className="text-xs text-muted mt-2">Uploaded by {photo.uploader.name ?? photo.uploader.email}</p>
              {photo.takenAt && <TimezoneShift action={shift} currentOffsetMin={photo.tzOffsetMin} hasTrip={Boolean(photo.trip)} tripTimezone={photo.trip?.timezone} />}
            </Card>

            <Card className="p-4 space-y-3">
              <h2 className="font-medium">Linked photos</h2>
              <LinkedPhotos links={links} unlink={unlinkPhotos} />
              <PhotoLinkEditor action={link} candidates={candidates.map((c) => ({ id: c.id, thumbUrl: photoUrl(c, "thumb"), caption: c.caption, originalName: c.originalName, takenAt: c.takenAt?.toISOString() ?? null }))} />
            </Card>

            <div className="flex flex-wrap gap-2">
              {photo.tripId && (
                <form action={cover}>
                  <Button type="submit" variant="secondary" size="sm" disabled={isCover}>{isCover ? "Trip cover" : "Set as trip cover"}</Button>
                </form>
              )}
              <form action={reprocess}>
                <Button type="submit" variant="secondary" size="sm">Re-process</Button>
              </form>
              <form action={remove}>
                <ConfirmSubmitButton variant="danger" size="sm" confirmMessage="Delete this photo and its original file? This cannot be undone.">Delete photo</ConfirmSubmitButton>
              </form>
            </div>
          </div>
        </div>
      </Container>
    </AppShell>
  );
}

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
import { collectionsForPhoto } from "@/lib/collections/queries";
import { CollectionPicker } from "@/components/collections/CollectionPicker";
import { uploaderLabel } from "@/components/photos/toGrid";
import { YouTubeEmbed } from "@/components/videos/YouTubeEmbed";
import { updateExternalVideo } from "@/app/videos/actions";
import { Input } from "@/components/ui";
import { localDayFromOffset } from "@/lib/time/local-day";

export default async function PhotoPage({ params }: PageProps<"/photos/[id]">) {
  const { id } = await params;
  await requireUser(`/photos/${id}`);
  const viewer = await getViewer();
  const photo = await db.photo.findUnique({
    where: { id },
    include: { trip: { select: { id: true, slug: true, title: true, timezone: true, coverPhotoId: true } }, activity: { select: { id: true, title: true } }, uploader: { select: { name: true } } },
  });
  if (!photo) notFound();

  const [trips, activities, links, candidates, collections] = await Promise.all([
    db.trip.findMany({ orderBy: { startDate: "desc" }, select: { id: true, title: true } }),
    photo.tripId ? db.activity.findMany({ where: { tripId: photo.tripId }, orderBy: { startTime: "asc" }, select: { id: true, title: true, startTime: true } }) : Promise.resolve([]),
    linkedPhotos(photo.id),
    photo.tripId
      ? db.photo.findMany({ where: { tripId: photo.tripId, status: "READY", id: { not: photo.id } }, orderBy: [{ takenAt: "asc" }], select: { id: true, caption: true, originalName: true, takenAt: true, updatedAt: true } })
      : Promise.resolve([]),
    collectionsForPhoto(photo.id),
  ]);
  const link = linkPhotos.bind(null, id);
  const update = updatePhoto.bind(null, id);
  const remove = deletePhoto.bind(null, id);
  const reprocess = reprocessPhoto.bind(null, id);
  const cover = setAsCover.bind(null, id);
  const shift = shiftPhotoTimezone.bind(null, id);
  const isCover = photo.trip?.coverPhotoId === photo.id;
  const isVideo = photo.kind === "EXTERNAL_VIDEO";
  const isClip = photo.kind === "VIDEO";
  const updateVideo = updateExternalVideo.bind(null, id);
  const filmedDay = photo.takenAt ? localDayFromOffset(photo.takenAt, photo.tzOffsetMin ?? 0) : "";

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
            {isClip ? (
              photo.status === "READY" ? (
                <video src={photoUrl(photo, "video")} poster={photoUrl(photo, "medium")} controls playsInline className="w-full rounded-theme bg-black" />
              ) : (
                <div className="aspect-video rounded-theme bg-surface-alt flex items-center justify-center text-muted p-4 text-center">
                  {photo.status === "FAILED" ? `Processing failed: ${photo.error}` : "Transcoding… a 90-second clip takes a few minutes on a small server."}
                </div>
              )
            ) : isVideo && photo.externalId ? (
              <div className="rounded-theme overflow-hidden bg-black">
                {photo.status === "READY" ? (
                  <YouTubeEmbed videoId={photo.externalId} posterUrl={photoUrl(photo, "medium")} title={photo.title ?? "Video"} />
                ) : (
                  <div className="aspect-video flex items-center justify-center text-white/70">Fetching poster…</div>
                )}
              </div>
            ) : photo.status === "READY" ? (
              <a href={photoUrl(photo, "original")} target="_blank" rel="noreferrer" title="Open original">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl(photo, "medium")} alt={photo.caption ?? photo.originalName} className="w-full rounded-theme bg-surface-alt" />
              </a>
            ) : (
              <div className="aspect-[4/3] rounded-theme bg-surface-alt flex items-center justify-center text-muted">
                {photo.status === "FAILED" ? `Processing failed: ${photo.error}` : "Processing…"}
              </div>
            )}
            {isVideo && photo.title && <p className="mt-3 text-lg font-medium">{photo.title}</p>}
            {isClip && photo.durationS && <p className="mt-2 text-sm text-muted">{Math.round(photo.durationS)} second clip{photo.status === "READY" ? " · original kept" : ""}</p>}
            {isVideo && photo.externalStatus === "UNAVAILABLE" && <p className="mt-1 text-sm text-amber-800">This video is no longer available on YouTube (deleted or made private). Replace the link below or delete the item.</p>}
            {photo.caption && <p className="mt-3 text-lg">{photo.caption}</p>}
            {photo.takenAt && <p className="text-sm text-muted mt-1">{formatDateTime(photo.takenAt, photo.trip?.timezone ?? "UTC")}</p>}
          </div>

          <div className="space-y-6">
            {isVideo && (
              <Card className="p-4">
                <form action={updateVideo} className="space-y-4">
                  <div>
                    <Label htmlFor="title">Title</Label>
                    <Input id="title" name="title" required defaultValue={photo.title ?? ""} />
                  </div>
                  <div>
                    <Label htmlFor="url">YouTube link</Label>
                    <Input id="url" name="url" required defaultValue={photo.externalUrl ?? ""} />
                    <p className="text-xs text-muted mt-1">Pasting a different video replaces the poster. Deleting this item never touches YouTube.</p>
                  </div>
                  <div>
                    <Label htmlFor="date">Date filmed</Label>
                    <Input id="date" name="date" type="date" required defaultValue={filmedDay} />
                  </div>
                  <Button type="submit">Save video</Button>
                </form>
              </Card>
            )}
            <Card className="p-4">
              <form action={update} className="space-y-4">
                <div>
                  <Label htmlFor="caption">Caption</Label>
                  <Textarea id="caption" name="caption" rows={2} defaultValue={photo.caption ?? ""} />
                </div>
                <div>
                  <Label htmlFor="context">Notes (who, where, what was happening)</Label>
                  <Textarea id="context" name="context" rows={3} defaultValue={photo.context ?? ""} placeholder="Grandma Jo's 80th at the lake house" />
                  <p className="text-xs text-muted mt-1">Notes feed search and the AI description; they are shown wherever the photo is.</p>
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
              <p className="text-xs text-muted mt-2">Uploaded by {uploaderLabel(photo.uploader.name)}</p>
              {photo.takenAt && <TimezoneShift action={shift} currentOffsetMin={photo.tzOffsetMin} hasTrip={Boolean(photo.trip)} tripTimezone={photo.trip?.timezone} />}
            </Card>

            <Card className="p-4 space-y-3">
              <h2 className="font-medium">Collections</h2>
              <CollectionPicker photoId={photo.id} collections={collections} />
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

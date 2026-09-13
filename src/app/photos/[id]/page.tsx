import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { photoUrl } from "@/lib/photos/urls";
import { AppShell, Container } from "@/components/layout/AppShell";
import { ExifPanel } from "@/components/photos/ExifPanel";
import { Button, Card, Label, Select, Textarea } from "@/components/ui";
import { formatBytes, formatDateTime } from "@/lib/time/format";
import { reprocessPhoto, resetPhotoDateToCamera, setAsCover, setPhotoDate, shiftPhotoTimezone, trashPhoto, updatePhoto } from "./actions";

const SOURCE_LABEL: Record<string, string> = { EXIF_OFFSET: "from the camera", EXIF_TZLOOKUP: "from the camera", TRIP_TZ: "from the camera, in the trip's zone", SIDECAR: "from Google Photos", FILE_NAME: "from the file name", EXIF_CREATED: "from the file\u2019s created-date tag, which may be when it was edited", FILE_MTIME: "from the file's modified time", UPLOAD_TIME: "the upload time" };
import { TimezoneShift } from "@/components/photos/TimezoneShift";
import { PhotoLinkEditor } from "@/components/photos/PhotoLinkEditor";
import { LinkedPhotos } from "@/components/photos/LinkedPhotos";
import { PlaceEditor } from "@/components/photos/PlaceEditor";
import { TrashButton } from "@/components/photos/TrashButton";
import { PhotoEditorPanel } from "@/components/photos/PhotoEditorPanel";
import { editsOf } from "@/lib/jobs/handlers/process-photo";
import { trashReasonLabel } from "@/lib/photos/trash";
import { isWeakDate } from "@/lib/photos/date-from-neighbours";
import { guessDateFromTrip } from "@/lib/photos/date-guess-query";
import { NeighbourDate } from "@/components/photos/NeighbourDate";
import { DateTroubleshooter } from "@/components/photos/DateTroubleshooter";
import { canEditContainer, canEditMedia, NOT_YOURS } from "@/lib/auth/ownership";
import { PanoramaView, PanoramaHint } from "@/components/photos/PanoramaView";
import { ScanViewer } from "@/components/scans/ScanViewer";
import { RetakeStill } from "@/components/scans/RetakeStill";
import { panoramaLabel } from "@/lib/images/panorama";
import { CollectionsField, TripField } from "@/components/containers/PhotoContainerFields";
import { mapThemeOf } from "@/lib/map/theme";
import { getTheme } from "@/themes";
import { linkedPhotos } from "@/lib/photos/links";
import { linkPhotos, unlinkPhotos } from "@/app/photos/link-actions";
import { collectionsForPhoto } from "@/lib/collections/queries";
import { uploaderLabel } from "@/components/photos/toGrid";
import { YouTubeEmbed } from "@/components/videos/YouTubeEmbed";
import { updateExternalVideo } from "@/app/videos/actions";
import { Input } from "@/components/ui";
import { localDayFromOffset } from "@/lib/time/local-day";
import { AnnotationCard } from "@/components/annotation/AnnotationCard";
import { EstimatedDate } from "@/components/annotation/EstimatedDate";
import { annotationGates, optOutReason } from "@/lib/annotation/eligibility";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { peopleOnPhoto, proposalsFor } from "@/lib/people/queries";
import { ProposalList } from "@/components/people/ProposalList";
import { similarTo } from "@/lib/graph/query";
import { SimilarStrip } from "@/components/graph/SimilarStrip";
import { PersonChips } from "@/components/people/PersonChips";
import { NOT_TRASHED } from "@/lib/photos/trash";

/** The tab and link-preview title: the item's title, else its caption, else the file name. Members only, like the page. */
export async function generateMetadata({ params }: PageProps<"/photos/[id]">): Promise<Metadata> {
  const { id } = await params;
  const viewer = await getViewer();
  if (viewer.kind !== "user") return { title: "Photo" };
  const photo = await db.photo.findUnique({ where: { id }, select: { title: true, caption: true, originalName: true } });
  if (!photo) return { title: "Photo" };
  return { title: photo.title ?? photo.caption ?? photo.originalName, description: photo.title ? (photo.caption ?? undefined) : undefined, robots: { index: false, follow: false } };
}

export default async function PhotoPage({ params }: PageProps<"/photos/[id]">) {
  const { id } = await params;
  const me = await requireUser(`/photos/${id}`);
  const viewer = await getViewer();
  const photo = await db.photo.findUnique({
    where: { id },
    include: { trip: { select: { id: true, slug: true, title: true, timezone: true, coverPhotoId: true, createdById: true } }, activity: { select: { id: true, title: true } }, uploader: { select: { name: true, email: true } }, placeSetBy: { select: { name: true, email: true } }, dateSetBy: { select: { name: true, email: true } }, activitySetBy: { select: { name: true, email: true } }, trashedBy: { select: { name: true, email: true } }, editedBy: { select: { name: true, email: true } } },
  });
  if (!photo) notFound();

  const tripTheme = photo.trip ? (await db.trip.findUnique({ where: { id: photo.trip.id }, select: { themeKey: true } }))?.themeKey ?? null : null;
  const [gates, optOutWhy, faces, proposals, similar, people] = await Promise.all([annotationGates(), optOutReason(photo.id), peopleOnPhoto(photo.id), proposalsFor([photo.id]), similarTo(viewer, photo.id), db.person.findMany({ where: { kind: "HUMAN", optedOutAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } })]);
  // No list of every trip and every collection any more: the pickers search for them, so this page loads the same
  // whether the album holds five of each or five hundred.
  const [activities, links, candidates, collections] = await Promise.all([
    photo.tripId ? db.activity.findMany({ where: { tripId: photo.tripId }, orderBy: { startTime: "asc" }, select: { id: true, title: true, startTime: true } }) : Promise.resolve([]),
    linkedPhotos(photo.id),
    photo.tripId
      ? db.photo.findMany({ where: { tripId: photo.tripId, ...NOT_TRASHED, status: "READY", id: { not: photo.id } }, orderBy: [{ takenAt: "asc" }], select: { id: true, caption: true, originalName: true, takenAt: true, updatedAt: true } })
      : Promise.resolve([]),
    collectionsForPhoto(photo.id),
  ]);
  const link = linkPhotos.bind(null, id);
  const update = updatePhoto.bind(null, id);
  const remove = trashPhoto.bind(null, id);
  const reprocess = reprocessPhoto.bind(null, id);
  const cover = setAsCover.bind(null, id);
  const shift = shiftPhotoTimezone.bind(null, id);
  const isCover = photo.trip?.coverPhotoId === photo.id;
  // The standing rule: an item is changed by whoever uploaded it, and by admins. Everyone else in the family reads
  // the same page without the controls — the details are shared, the account of them belongs to the person who gave it.
  const mine = canEditMedia(me, photo);
  // A cover is the trip's decision, not the photograph's: it shows for whoever made the trip, however it got here.
  const ownsTrip = Boolean(photo.trip) && canEditContainer(me, photo.trip!);
  // What the rest of the trip says about an item whose own date was lost; null when its date is trustworthy.
  const neighbourGuess = await guessDateFromTrip(photo.id);
  const isVideo = photo.kind === "EXTERNAL_VIDEO";
  const isClip = photo.kind === "VIDEO";
  const updateVideo = updateExternalVideo.bind(null, id);
  const filmedDay = photo.takenAt ? localDayFromOffset(photo.takenAt, photo.tzOffsetMin ?? 0) : "";

  return (
    <AppShell viewer={viewer}>
      <Container className="py-8">
        {photo.trashedAt && (
          <div className="rounded-theme border border-amber-300 bg-amber-50 text-amber-900 p-3 mb-4 text-sm">
            <b>In the trash.</b> Moved {photo.trashedBy ? `by ${uploaderLabel(photo.trashedBy.name, photo.trashedBy.email)} ` : ""}on {formatDateTime(photo.trashedAt, photo.trip?.timezone ?? "UTC", "MMMM d, yyyy")}: {trashReasonLabel(photo.trashReason, photo.trashNote)}. It is out of every gallery, the timeline, the map and any share link. An admin can restore it or delete it for good from <Link href="/admin/trash" className="underline underline-offset-2">the trash</Link>.
          </div>
        )}
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
            ) : photo.kind === "SCAN" ? (
              photo.status === "READY" ? (
                <div className="space-y-2">
                  <ScanViewer
                    photoId={photo.id}
                    modelUrl={photoUrl(photo, "model")}
                    format={photo.scanFormat}
                    posterUrl={photo.renditions ? photoUrl(photo, "medium") : null}
                    canPoster={mine}
                    alt={photo.caption ?? photo.originalName}
                    className="w-full min-h-80"
                  />
                  <p className="text-sm text-muted">
                    3D scan ({photo.scanFormat ?? "unknown format"}), {formatBytes(photo.sizeBytes)}.{" "}
                    <a href={photoUrl(photo, "model")} download className="underline underline-offset-2">Download it</a> to open in Scaniverse or any 3D app.
                  </p>
                  {/* A still taken at the wrong moment, or before the scan's colours could be read, is a blank tile for good otherwise. */}
                  {mine && photo.renditions ? <RetakeStill photoId={photo.id} /> : null}
                </div>
              ) : (
                <div className="aspect-video rounded-theme bg-surface-alt flex items-center justify-center text-muted p-4 text-center">Getting the scan ready…</div>
              )
            ) : photo.status === "READY" && photo.panorama ? (
              // Shown as a panorama: the height of a comfortable strip, dragged sideways, with the whole file a click away.
              <div className="space-y-2">
                <PanoramaView
                  src={photoUrl(photo, "pano")}
                  alt={photo.caption ?? photo.originalName}
                  wrap={photo.panoProjection === "EQUIRECTANGULAR_360"}
                  axis={(photo.width ?? 0) >= (photo.height ?? 0) ? "horizontal" : "vertical"}
                  className="h-[38vh] min-h-56 w-full rounded-theme bg-surface-alt"
                >
                  <PanoramaHint label={panoramaLabel(photo.panoProjection)} />
                </PanoramaView>
                <p className="text-sm text-muted">
                  {panoramaLabel(photo.panoProjection)}{photo.width && photo.height ? ` · ${photo.width} × ${photo.height}` : ""}.{" "}
                  <a href={photoUrl(photo, photo.edits ? "edited" : "original")} target="_blank" rel="noreferrer" className="underline underline-offset-2">Open the full-size photo</a>.
                </p>
              </div>
            ) : photo.status === "READY" ? (
              <a href={photoUrl(photo, photo.edits ? "edited" : "original")} target="_blank" rel="noreferrer" title="Open the full-size photo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl(photo, "medium")} alt={photo.caption ?? photo.originalName} className="w-full rounded-theme bg-surface-alt" />
              </a>
            ) : (
              <div className="aspect-[4/3] rounded-theme bg-surface-alt flex items-center justify-center text-muted">
                {photo.status === "FAILED" ? `Processing failed: ${photo.error}` : "Processing…"}
              </div>
            )}
            {photo.edits ? (
              <p className="mt-2 text-sm text-muted" data-testid="edited-note">
                Cropped or colour-corrected{photo.editedBy ? ` by ${uploaderLabel(photo.editedBy.name, photo.editedBy.email)}` : ""}. The file as it was uploaded is untouched:{" "}
                <a href={photoUrl(photo, "original")} target="_blank" rel="noreferrer" className="underline underline-offset-2">see the original</a>.
              </p>
            ) : null}
            {mine && photo.kind === "PHOTO" && photo.status === "READY" && (
              <div className="mt-3">
                {/* The editor starts from the picture without its edits, so reopening it does not apply them a second time. */}
                <PhotoEditorPanel photoId={photo.id} src={photoUrl(photo, photo.edits ? "source" : "medium")} initial={editsOf(photo.edits)} edited={Boolean(photo.edits)} />
              </div>
            )}
            {photo.title && <h1 className="mt-3 text-xl font-semibold font-display">{photo.title}</h1>}
            {isClip && photo.durationS && <p className="mt-2 text-sm text-muted">{Math.round(photo.durationS)} second clip{photo.status === "READY" ? " · original kept" : ""}</p>}
            {isVideo && photo.externalStatus === "UNAVAILABLE" && <p className="mt-1 text-sm text-amber-800">This video is no longer available on YouTube (deleted or made private). Replace the link below or delete the item.</p>}
            {photo.caption && <p className="mt-3 text-lg">{photo.caption}</p>}
            <div className="mt-2 space-y-2"><PersonChips photoId={photo.id} faces={faces} people={people} /><ProposalList proposals={proposals} /></div>
            {photo.takenAt && <p className="text-sm text-muted mt-1">{formatDateTime(photo.takenAt, photo.trip?.timezone ?? "UTC")}</p>}
          </div>

          <div className="space-y-6">
            {isVideo && mine && (
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
            {!mine && (
              <Card className="p-4 text-sm text-muted" data-testid="not-yours">
                {NOT_YOURS} Anything you notice about it is worth saying to them — and anyone can move an item to the
                trash, with a reason, if it should not be up.
              </Card>
            )}
            {mine && (
            <Card className="p-4">
              <form action={update} className="space-y-4">
                {!isVideo && (
                  <div>
                    <Label htmlFor="photo-title">Title</Label>
                    <Input id="photo-title" name="title" defaultValue={photo.title ?? ""} placeholder="Mail boat lunch" />
                    <p className="text-xs text-muted mt-1">Shown when the item is listed or shared. Left empty, the AI helper writes one when it describes the item.</p>
                  </div>
                )}
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
                  <TripField initial={photo.trip ? { id: photo.trip.id, title: photo.trip.title } : null} />
                </div>
                <fieldset>
                  <input type="hidden" name="collectionsPresent" value="1" />
                  <legend className="text-sm font-medium mb-1">Collections</legend>
                  <CollectionsField
                    initial={collections.map((c) => ({ id: c.id, title: c.title, slug: c.slug, visibility: c.visibility }))}
                    hint="Search for a collection to add this photo to, or take one off. A public or link-shared collection shows the photo to everyone who can open that collection."
                  />
                </fieldset>
                {photo.tripId && (
                  <div>
                    <Label htmlFor="activityId">Activity</Label>
                    <Select id="activityId" name="activityId" defaultValue={photo.activityId ?? ""}>
                      <option value="">None</option>
                      {activities.map((a) => (
                        <option key={a.id} value={a.id}>{a.title}</option>
                      ))}
                    </Select>
                    <p className="text-xs text-muted mt-1">
                      {photo.activitySetBy
                        ? `Put here by ${uploaderLabel(photo.activitySetBy.name, photo.activitySetBy.email)}, so the activity's hours leave it alone.`
                        : "Left alone, this follows the time it was taken. Choosing one keeps it there whatever its date says."}
                    </p>
                  </div>
                )}
                <Button type="submit">Save</Button>
              </form>
            </Card>
            )}

            <AnnotationCard photoId={photo.id} annotation={photo.annotation as StoredAnnotation | null} source={photo.annotationSource} model={photo.annotationModel} error={photo.annotationError} optOut={photo.annotationOptOut} optOutReason={optOutWhy} active={gates.active} editable={mine} />
            {/* Where a date came from is worth reading whoever you are; taking one of the readings is not. */}
            <div className="mb-2"><DateTroubleshooter photoId={photo.id} readOnly={!mine} /></div>
            {mine && neighbourGuess && <div className="mb-3"><NeighbourDate photoId={photo.id} guess={{ ...neighbourGuess, takenAt: neighbourGuess.takenAt.toISOString() }} /></div>}
            {mine && isWeakDate(photo.takenAtSource, photo.takenAt) && (
              <EstimatedDate photoId={photo.id} estimatedDate={photo.estimatedDate} confidence={photo.estimatedDateConfidence} note={photo.estimatedDateNote} />
            )}

            <Card className="p-4">
              <h2 className="font-medium mb-2">Place</h2>
              <PlaceEditor photoId={photo.id} initial={photo.lat !== null && photo.lng !== null ? { lat: photo.lat, lng: photo.lng } : null} gpsSource={photo.gpsSource} setBy={photo.placeSetBy ? uploaderLabel(photo.placeSetBy.name, photo.placeSetBy.email) : null} placeName={photo.placeName} estimate={{ name: photo.placeEstimateName, confidence: photo.placeEstimateConfidence, radiusM: photo.placeEstimateRadiusM, note: photo.placeEstimateNote, precision: photo.placeEstimatePrecision }} theme={mapThemeOf(getTheme(tripTheme))} readOnly={!mine} />
            </Card>
            <Card className="p-4">
              <h2 className="font-medium mb-2">Details</h2>
              <ExifPanel photo={photo} tripTimezone={photo.trip?.timezone} />
              <p className="text-xs text-muted mt-2">Uploaded by {uploaderLabel(photo.uploader.name, photo.uploader.email)}</p>
              {!isVideo && mine && (
                <form action={async (fd) => { "use server"; await setPhotoDate(photo.id, fd); }} className="mt-3 pt-3 border-t border-border space-y-2">
                  <div className="text-xs font-medium">Date taken</div>
                  <p className="text-xs text-muted">Defaults to what the camera wrote in the file{photo.takenAtSource ? ` (currently ${photo.takenAtSource === "MANUAL" ? `set by ${photo.dateSetBy ? uploaderLabel(photo.dateSetBy.name, photo.dateSetBy.email) : "a family member"}` : SOURCE_LABEL[photo.takenAtSource] ?? photo.takenAtSource})` : ""}. Change it here when the camera was wrong or a scan has no date.</p>
                  <div className="flex flex-wrap gap-2">
                    <input type="datetime-local" name="takenAt" aria-label="Date taken" defaultValue={photo.takenAt ? new Date(photo.takenAt.getTime() + (photo.tzOffsetMin ?? 0) * 60_000).toISOString().slice(0, 16) : ""} required className="h-8 rounded-theme border border-border bg-surface text-text [color-scheme:light] px-2 text-sm" />
                    <Button type="submit" variant="secondary" size="sm">Save date</Button>
                    <Button type="submit" variant="secondary" size="sm" formAction={async () => { "use server"; await resetPhotoDateToCamera(photo.id); }}>Use camera date</Button>
                  </div>
                </form>
              )}
              {mine && photo.takenAt && <TimezoneShift action={shift} currentOffsetMin={photo.tzOffsetMin} hasTrip={Boolean(photo.trip)} tripTimezone={photo.trip?.timezone} />}
            </Card>

            {similar.length > 0 && (
              <Card className="p-4">
                <SimilarStrip items={similar} graphHref={photo.trip ? `/graph?trip=${photo.trip.slug}` : undefined} />
              </Card>
            )}

            <Card className="p-4 space-y-3">
              <h2 className="font-medium">Linked photos</h2>
              <LinkedPhotos links={links} unlink={mine ? unlinkPhotos : undefined} />
              {mine && <PhotoLinkEditor action={link} candidates={candidates.map((c) => ({ id: c.id, thumbUrl: photoUrl(c, "thumb"), caption: c.caption, originalName: c.originalName, takenAt: c.takenAt?.toISOString() ?? null }))} />}
            </Card>

            <div className="flex flex-wrap gap-2">
              {ownsTrip && photo.tripId && (
                <form action={cover}>
                  <Button type="submit" variant="secondary" size="sm" disabled={isCover}>{isCover ? "Trip cover" : "Set as trip cover"}</Button>
                </form>
              )}
              {mine && (
                <form action={reprocess}>
                  <Button type="submit" variant="secondary" size="sm">Re-process</Button>
                </form>
              )}
              <TrashButton action={remove} />
            </div>
          </div>
        </div>
      </Container>
    </AppShell>
  );
}

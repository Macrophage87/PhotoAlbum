import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { personMedia } from "@/lib/people/queries";
import { isMinor, knownAdult, minorsCheckPasses } from "@/lib/people/consent";
import { canChangePerson } from "@/lib/auth/ownership";
import { AppShell, Container } from "@/components/layout/AppShell";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";
import { Badge, Button, Card, ConfirmSubmitButton, Input, Label } from "@/components/ui";
import { decideIndexing, deletePerson, optOutPerson, recordAdultAndName, scrubWithdrawnNow, setNameInDescriptions, updatePerson } from "../actions";
import { matcherFor, memberTextMentioning, taggedPhotoIds, withdrawalDue, withdrawalNotice, withdrawalReason } from "@/lib/people/forget";
import { nameMayLeaveServer } from "@/lib/people/consent";
import { MemberTextList } from "@/components/people/MemberTextList";
import { PetForm } from "@/components/people/PetForm";
import { dateColumnToDay } from "@/lib/time/local-day";
import { namesWaitingFor, refreshNamesFor } from "@/app/annotation/actions";

export const metadata = { robots: { index: false, follow: false } };

/** Members-only: one person's media over time, and their recognition settings. */
export default async function PersonPage({ params, searchParams }: PageProps<"/people/[id]">) {
  const { id } = await params;
  const busy = (await searchParams).busy === "1";
  const user = await requireUser(`/people/${id}`);
  const viewer = await getViewer();
  const person = await db.person.findUnique({ where: { id } });
  if (!person) notFound();
  const photos = await personMedia(viewer, id);
  const isAdmin = user.role === "ADMIN";
  const update = updatePerson.bind(null, id);
  const decide = decideIndexing.bind(null, id);
  const nameInDescriptions = setNameInDescriptions;
  const optOut = optOutPerson.bind(null, id);
  const minor = isMinor(person);
  // Renaming and forgetting belong to whoever added this person, and to admins; consent stays with admins.
  const canChange = canChangePerson(user, person);
  // Somebody to ask, by name: the member who added them, or failing that an admin.
  const creator = await db.user.findUnique({ where: { id: person.createdById }, select: { name: true } });
  const askWhom = creator?.name?.trim() ? `${creator.name.trim()} (who added them) or an admin` : "an admin";
  // What members wrote by hand that forgetting would leave as it is, shown before anybody presses the button.
  const memberText = person.kind === "HUMAN" && canChange ? await memberTextMentioning(await matcherFor(person), await taggedPhotoIds(person.id), person.id) : null;
  // Turning something off that is all that lets the helper use their name takes it out of what was written, too.
  const unNames = `This also takes ${person.name} out of descriptions already written; turning it back on means describing them again.`;
  const withdrawnUntil = person.namingWithdrawnAt ? withdrawalDue(person.namingWithdrawnAt) : null;
  // Descriptions of this person written before the album could name them, and the one press that redoes them.
  const waiting = await namesWaitingFor(id);
  const refresh = async () => {
    "use server";
    await refreshNamesFor(id);
  };
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 space-y-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-semibold">{person.name}</h1>
            <p className="text-muted mt-1">{[person.relationship, person.kind === "PET" ? `${person.isFlock ? "flock of " : ""}${person.species?.toLowerCase() ?? "pet"}` : null, person.kind === "PET" && person.livedFrom ? `${person.livedFrom.getUTCFullYear()}–${person.livedTo ? person.livedTo.getUTCFullYear() : ""}` : null, person.kind === "PET" ? person.descriptors : null, `${photos.length} photo${photos.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</p>
          </div>
          {person.kind === "HUMAN" && person.forgetPendingAt ? <Badge tone="warning">Waiting to be forgotten — an admin needs to finish setting up the album.</Badge> : person.kind === "HUMAN" && (person.faceIndexing ? <Badge tone="success">recognized in new photos · {person.adultAttestedAt ? "attested adult" : "by birthday"}</Badge> : person.optedOutAt ? <Badge tone="warning">asked to be forgotten on {person.optedOutAt.toLocaleDateString("en-US")}</Badge> : <Badge tone="neutral">{person.pendingDecision ? "awaiting an admin's decision" : "not recognized"}</Badge>)}
        </div>

        {busy && <p className="rounded-theme border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="status">Another person is being forgotten; try again in a few minutes.</p>}
        <PhotoGrid photos={photos.map((p) => toGridPhoto(p, null, true))} emptyMessage="No photos you can see." />

        {/* Naming somebody does nothing to the descriptions already written, and hunting down the run that fixes
            them on the Admin page was the step everybody got stuck on. It is offered here, where the naming is. */}
        {waiting > 0 && (
          <form action={refresh} className="rounded-theme border border-border bg-surface-alt p-4 space-y-2 text-sm" data-testid="names-waiting">
            <p className="font-medium">
              {waiting} description{waiting === 1 ? " was" : "s were"} written before the album could use {person.name}&apos;s name.
            </p>
            <p className="text-muted">They still describe {person.name} by age or by role. Describing them again lets the helper use the name instead; whatever a member wrote by hand is left alone.</p>
            {isAdmin ? (
              <ConfirmSubmitButton size="sm" variant="secondary" confirmMessage={`Describe ${waiting} item${waiting === 1 ? "" : "s"} again so they can use ${person.name}'s name? This sends them to the AI helper.`} data-testid="refresh-names">
                Describe {waiting === 1 ? "it" : "them"} again
              </ConfirmSubmitButton>
            ) : (
              <p className="text-muted">An admin can have them described again.</p>
            )}
          </form>
        )}

        <div className="grid md:grid-cols-2 gap-6">
          {person.kind === "PET" ? (
            <Card className="p-4 space-y-3">
              {canChange ? <PetForm pet={person} /> : <p className="text-sm text-muted">Only the family member who added {person.name}, or an admin, can change these details; ask {askWhom}.</p>}
              {isAdmin && (
                <form action={deletePerson.bind(null, id)}>
                  <ConfirmSubmitButton variant="danger" size="sm" confirmMessage={`Remove ${person.name} and every tag of them?`}>Remove this pet</ConfirmSubmitButton>
                </form>
              )}
            </Card>
          ) : (
          <Card className="p-4">
            {canChange ? (
            <form action={update} className="space-y-3 text-sm">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" defaultValue={person.name} required />
              </div>
              <div>
                <Label htmlFor="relationship">Relationship</Label>
                <Input id="relationship" name="relationship" defaultValue={person.relationship ?? ""} />
              </div>
              <Button type="submit" size="sm">Save</Button>
            </form>
            ) : (
              <p className="text-sm text-muted">Only the family member who added {person.name}, or an admin, can rename them; ask {askWhom}.</p>
            )}
          </Card>
          )}

          {person.kind === "HUMAN" && (
            <Card className="p-4 space-y-4 text-sm">
              <h2 className="font-medium">Recognition</h2>
              {isAdmin ? (
                <form action={decide} className="space-y-2">
                  <div>
                    <Label htmlFor="birthday">Birthday</Label>
                    <Input id="birthday" name="birthday" type="date" defaultValue={person.birthday ? dateColumnToDay(person.birthday) : ""} className="w-44" />
                  </div>
                  {!person.birthday && !person.adultAttestedAt && (
                    <label className="flex items-start gap-2">
                      <input type="checkbox" name="attest" className="mt-1" />
                      <span>I confirm this person is an adult and has agreed to face recognition</span>
                    </label>
                  )}
                  {minor && (
                    <label className="flex items-start gap-2">
                      <input type="checkbox" name="parentInstruction" className="mt-1" />
                      <span>A parent has asked for this child to be recognized</span>
                    </label>
                  )}
                  {person.optedOutAt && (
                    <label className="flex items-start gap-2 rounded-theme border border-amber-300 bg-amber-50 p-2 text-amber-900">
                      <input type="checkbox" name="agreedAgain" className="mt-1" />
                      <span>{person.name} asked to be forgotten on {person.optedOutAt.toLocaleDateString("en-US")}. Check this only if they have told you they agree to recognition again; otherwise the switch below is ignored.</span>
                    </label>
                  )}
                  <label className="flex items-start gap-2">
                    <input type="checkbox" name="faceIndexing" defaultChecked={person.faceIndexing} className="mt-1" />
                    <span>
                      <span className="font-medium">Recognize this person in new photos</span>
                      <span className="block text-muted">Turning it off drops the face templates now. Without a birthday showing an adult or the attestation the templates are dropped as well{minor ? ", and a minor is never recognized unless a parent has asked" : ""}. Only admins change this; the decision is recorded{person.faceIndexingSetAt ? ` (last set ${person.faceIndexingSetAt.toLocaleDateString("en-US")})` : ""}.</span>
                    </span>
                  </label>
                  {person.faceIndexing && !person.nameInDescriptions && nameMayLeaveServer(person) ? (
                    <ConfirmSubmitButton size="sm" variant="secondary" confirmMessage={`Save the recognition setting? If it turns recognition off: ${unNames}`}>Save recognition setting</ConfirmSubmitButton>
                  ) : (
                    <Button type="submit" size="sm" variant="secondary">Save recognition setting</Button>
                  )}
                </form>
              ) : (
                <p className="text-muted">{person.faceIndexing ? "An admin turned recognition on for this person." : "Recognition is off. An admin can turn it on with the person's agreement."}</p>
              )}
              {!minorsCheckPasses(person) && !minor && <p className="text-xs text-muted">No birthday and no attestation: treated as not consented.</p>}

              {/* A narrower agreement than recognition, and a different one: being named in a description does not
                  keep a template of anybody, and is what a relative usually means by "I would rather be tagged". */}
              <div className="border-t border-border pt-3 space-y-2">
                <p className="font-medium">Named in descriptions</p>
                {/* Switched off by the album itself, not by anybody's decision: say so, and what happens next. */}
                {withdrawnUntil && (
                  <div className="rounded-theme border border-amber-300 bg-amber-50 p-2 text-amber-900 space-y-1" data-testid="naming-withdrawn">
                    <p>{withdrawalNotice(person.name, withdrawalReason(person), withdrawnUntil)} What anybody outside the family can read has already lost it.</p>
                    {isAdmin && (
                      <form action={scrubWithdrawnNow.bind(null, id)}>
                        <ConfirmSubmitButton size="sm" variant="secondary" confirmMessage={`Take ${person.name}'s name out of descriptions already written, now?`}>Take it out now</ConfirmSubmitButton>
                      </form>
                    )}
                  </div>
                )}
                {minor ? (
                  <p className="text-muted">A child is never named in a description, whatever else is set.</p>
                ) : !knownAdult(person) ? (
                  // No birthday and no attestation could be a child as easily as an adult, and a child is never named.
                  <div className="space-y-2" data-testid="name-needs-age">
                    <p className="text-muted">Not named: the album can&apos;t be sure {person.name} is over 18, so it doesn&apos;t name them. {isAdmin ? "Record a birthday or confirm they are an adult here to use their name; this says nothing about recognition, which stays its own decision." : "An admin can record a birthday or confirm they are an adult."}</p>
                    {isAdmin && (
                      <form action={recordAdultAndName.bind(null, id)} className="space-y-2">
                        {!person.birthday && (
                          <div>
                            <Label htmlFor="naming-birthday">Birthday</Label>
                            <Input id="naming-birthday" name="birthday" type="date" className="w-44" />
                          </div>
                        )}
                        {!person.birthday && (
                          <label className="flex items-start gap-2">
                            <input type="checkbox" name="attestAdult" className="mt-1" />
                            <span>I confirm {person.name} is an adult and agrees to be named in descriptions</span>
                          </label>
                        )}
                        <Button type="submit" size="sm" variant="secondary" data-testid="record-adult-and-name">Record and use their name</Button>
                      </form>
                    )}
                    {/* Agreed before the album asked for evidence: the agreement no longer counts, and can be cleared. */}
                    {isAdmin && person.nameInDescriptions && (
                      <form action={nameInDescriptions.bind(null, id, false)}>
                        <ConfirmSubmitButton size="sm" variant="secondary" confirmMessage={`Stop using ${person.name}'s name? ${unNames}`}>Stop using their name</ConfirmSubmitButton>
                      </form>
                    )}
                  </div>
                ) : isAdmin ? (
                  <form action={nameInDescriptions.bind(null, id, !person.nameInDescriptions)} className="space-y-2">
                    <p className="text-muted">
                      {person.nameInDescriptions
                        ? `The helper is told ${person.name}'s name when it describes a photograph they have been confirmed in, instead of writing "an older couple".`
                        : `The helper is not told ${person.name}'s name, so descriptions of photographs they are in say "a man", "an older couple" and the like.`}
                      {" "}Nothing is recognized either way, and no template is kept for it{person.nameInDescriptionsSetAt ? ` (last set ${person.nameInDescriptionsSetAt.toLocaleDateString("en-US")})` : ""}.
                    </p>
                    {person.nameInDescriptions && nameMayLeaveServer(person) && !person.faceIndexing ? (
                      <ConfirmSubmitButton size="sm" variant="secondary" data-testid="name-in-descriptions" confirmMessage={`Stop using ${person.name}'s name? ${unNames}`}>
                        Stop using their name
                      </ConfirmSubmitButton>
                    ) : (
                      <Button type="submit" size="sm" variant="secondary" data-testid="name-in-descriptions">
                        {person.nameInDescriptions ? "Stop using their name" : "Use their name in descriptions"}
                      </Button>
                    )}
                  </form>
                ) : (
                  <p className="text-muted">{person.nameInDescriptions ? `Descriptions may use ${person.name}'s name.` : "Descriptions do not use their name. An admin can change that with their agreement."}</p>
                )}
              </div>

              {canChange ? (
              <form action={optOut} className="space-y-2 border-t border-border pt-3">
                <p className="font-medium">Forget this person&apos;s face</p>
                <p>The album stops recognizing {person.name} and takes their name out of everything the AI wrote; what members wrote themselves is left as it is.</p>
                <p className="text-muted">In detail: deletes every face template, group and match for {person.name}; takes the name out of the AI helper&apos;s descriptions and titles (including descriptions a member has since corrected) and the trip, collection and activity descriptions it wrote, and out of the name search; and stops the name reaching the AI helper. Titles, captions, notes and descriptions members wrote by hand are left exactly as they wrote them. Afterwards the album keeps the name only as a code, to stop it coming back in anything sent to or written by the AI helper; if a member of the album has an account under the same name, that name stays theirs and cannot be kept out that way.</p>
                {memberText && memberText.photos.length + memberText.trips.length + memberText.collections.length + memberText.activities.length > 0 && (
                  <div className="rounded-theme border border-border bg-surface-alt p-3 space-y-1">
                    <p>These still mention {person.name} and were written by members, or before the album kept track of who wrote them; forgetting leaves them as they are, so edit them by hand (or ask whoever wrote them):</p>
                    <MemberTextList text={memberText} />
                  </div>
                )}
                <label className="flex items-center gap-2"><input type="radio" name="mode" value="remove-all" defaultChecked /> Also remove the record of which photos they appear in</label>
                <label className="flex items-center gap-2"><input type="radio" name="mode" value="keep-name" /> Keep the name on the photos already confirmed (no face data)</label>
                <ConfirmSubmitButton variant="danger" size="sm" confirmMessage={`Forget ${person.name}'s face data? This cannot be undone.`}>Forget face data</ConfirmSubmitButton>
              </form>
              ) : (
                <div className="space-y-1 border-t border-border pt-3">
                  <p className="font-medium">Forget this person&apos;s face</p>
                  <p className="text-muted">If {person.name} wants to be forgotten, ask {askWhom}: it takes every tag of them off the album and cannot be undone.</p>
                </div>
              )}
            </Card>
          )}
        </div>
      </Container>
    </AppShell>
  );
}

import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { personMedia } from "@/lib/people/queries";
import { isMinor, minorsCheckPasses } from "@/lib/people/consent";
import { AppShell, Container } from "@/components/layout/AppShell";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";
import { Badge, Button, Card, ConfirmSubmitButton, Input, Label } from "@/components/ui";
import { decideIndexing, deletePerson, optOutPerson, updatePerson } from "../actions";
import { PetForm } from "@/components/people/PetForm";
import { dateColumnToDay } from "@/lib/time/local-day";

export const metadata = { robots: { index: false, follow: false } };

/** Members-only: one person's media over time, and their recognition settings. */
export default async function PersonPage({ params }: PageProps<"/people/[id]">) {
  const { id } = await params;
  const user = await requireUser(`/people/${id}`);
  const viewer = await getViewer();
  const person = await db.person.findUnique({ where: { id } });
  if (!person) notFound();
  const photos = await personMedia(viewer, id);
  const isAdmin = user.role === "ADMIN";
  const update = updatePerson.bind(null, id);
  const decide = decideIndexing.bind(null, id);
  const optOut = optOutPerson.bind(null, id);
  const minor = isMinor(person);
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 space-y-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-semibold">{person.name}</h1>
            <p className="text-muted mt-1">{[person.relationship, person.kind === "PET" ? `${person.isFlock ? "flock of " : ""}${person.species?.toLowerCase() ?? "pet"}` : null, person.kind === "PET" && person.livedFrom ? `${person.livedFrom.getUTCFullYear()}–${person.livedTo ? person.livedTo.getUTCFullYear() : ""}` : null, `${photos.length} photo${photos.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</p>
          </div>
          {person.kind === "HUMAN" && (person.faceIndexing ? <Badge tone="success">recognised in new photos · {person.adultAttestedAt ? "attested adult" : "by birthday"}</Badge> : person.optedOutAt ? <Badge tone="warning">asked to be forgotten on {person.optedOutAt.toLocaleDateString("en-US")}</Badge> : <Badge tone="neutral">{person.pendingDecision ? "awaiting an admin's decision" : "not recognised"}</Badge>)}
        </div>

        <PhotoGrid photos={photos.map((p) => toGridPhoto(p, null, true))} emptyMessage="No photos you can see." />

        <div className="grid md:grid-cols-2 gap-6">
          {person.kind === "PET" ? (
            <Card className="p-4 space-y-3">
              <PetForm pet={person} />
              {isAdmin && (
                <form action={deletePerson.bind(null, id)}>
                  <ConfirmSubmitButton variant="danger" size="sm" confirmMessage={`Remove ${person.name} and every tag of them?`}>Remove this pet</ConfirmSubmitButton>
                </form>
              )}
            </Card>
          ) : (
          <Card className="p-4">
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
                      <span>A parent has asked for this child to be recognised</span>
                    </label>
                  )}
                  {person.optedOutAt && (
                    <label className="flex items-start gap-2 rounded-theme border border-amber-300 bg-amber-50 p-2 text-amber-900">
                      <input type="checkbox" name="agreedAgain" className="mt-1" />
                      <span>{person.name} asked to be forgotten on {person.optedOutAt.toLocaleDateString("en-US")}. Tick only if they have told you they agree to recognition again; otherwise the switch below is ignored.</span>
                    </label>
                  )}
                  <label className="flex items-start gap-2">
                    <input type="checkbox" name="faceIndexing" defaultChecked={person.faceIndexing} className="mt-1" />
                    <span>
                      <span className="font-medium">Recognise this person in new photos</span>
                      <span className="block text-muted">Turning it off drops the face templates now. Without a birthday showing an adult or the attestation the templates are dropped as well{minor ? ", and a minor is never recognised unless a parent has asked" : ""}. Only admins change this; the decision is recorded{person.faceIndexingSetAt ? ` (last set ${person.faceIndexingSetAt.toLocaleDateString("en-US")})` : ""}.</span>
                    </span>
                  </label>
                  <Button type="submit" size="sm" variant="secondary">Save recognition setting</Button>
                </form>
              ) : (
                <p className="text-muted">{person.faceIndexing ? "An admin turned recognition on for this person." : "Recognition is off. An admin can turn it on with the person's agreement."}</p>
              )}
              {!minorsCheckPasses(person) && !minor && <p className="text-xs text-muted">No birthday and no attestation: treated as not consented.</p>}

              <form action={optOut} className="space-y-2 border-t border-border pt-3">
                <p className="font-medium">Forget this person&apos;s face</p>
                <p className="text-muted">Deletes every face template, group and match for {person.name}, removes the name from AI descriptions and search, and stops the name reaching the AI helper.</p>
                <label className="flex items-center gap-2"><input type="radio" name="mode" value="remove-all" defaultChecked /> Also remove the record of which photos they appear in</label>
                <label className="flex items-center gap-2"><input type="radio" name="mode" value="keep-name" /> Keep the name on the photos already confirmed (no face data)</label>
                <ConfirmSubmitButton variant="danger" size="sm" confirmMessage={`Forget ${person.name}'s face data? This cannot be undone.`}>Forget face data</ConfirmSubmitButton>
              </form>
            </Card>
          )}
        </div>
      </Container>
    </AppShell>
  );
}

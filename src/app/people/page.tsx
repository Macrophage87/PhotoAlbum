import Link from "next/link";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { faceGates } from "@/lib/people/gates";
import { listPeople, listUnnamedClusters, proposalsFor } from "@/lib/people/queries";
import { ProposalList } from "@/components/people/ProposalList";
import { PetForm } from "@/components/people/PetForm";
import { petGates } from "@/lib/pets/gates";
import { AppShell, Container } from "@/components/layout/AppShell";
import { ClusterCard } from "@/components/people/ClusterCard";
import { Badge, Card } from "@/components/ui";

export const metadata = { title: "People", robots: { index: false, follow: false } };

/** Members-only: named people, and unnamed face groups waiting for a name. */
export default async function PeoplePage() {
  const user = await requireUser("/people");
  const viewer = await getViewer();
  const [everyone, clusters, gates, proposals] = await Promise.all([listPeople(), listUnnamedClusters(), faceGates(), proposalsFor()]);
  const petsActive = petGates().active;
  const people = everyone.filter((p) => p.kind === "HUMAN");
  const pets = everyone.filter((p) => p.kind === "PET");
  const isAdmin = user.role === "ADMIN";
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 space-y-10">
        <div>
          <h1 className="font-display text-3xl font-semibold">People</h1>
          <p className="text-muted mt-1">
            {gates.active ? "Faces are found on this server and grouped; name a group once and it becomes a person." : gates.sidecar ? "Face detection is off. An admin can turn it on from the Admin page." : "Face detection needs the optional local ML service, which the person who runs this album has not set up."}
          </p>
        </div>

        <section className="space-y-3">
          <h2 className="font-display text-xl font-semibold">Named</h2>
          {people.length === 0 ? (
            <p className="text-sm text-muted">Nobody named yet.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {people.map((p) => (
                <Link key={p.id} href={`/people/${p.id}`} className="block rounded-theme border border-border bg-surface p-4 hover:shadow-md transition-shadow">
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-muted">{p.relationship ?? (p.kind === "PET" ? "pet" : "")}</div>
                  <div className="text-xs text-muted mt-1">{p.photoCount} photo{p.photoCount === 1 ? "" : "s"}</div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {p.kind === "HUMAN" && (p.faceIndexing ? <Badge tone="success">recognised · {p.basis === "attestation" ? "attested adult" : "by birthday"}</Badge> : p.optedOut ? <Badge tone="warning">asked to be forgotten</Badge> : p.pendingDecision ? <Badge tone="warning">awaiting admin decision</Badge> : <Badge tone="neutral">not recognised</Badge>)}
                    {p.minor && <Badge tone="neutral">minor</Badge>}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {proposals.length > 0 && (
          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold">Probably…</h2>
            <p className="text-sm text-muted">Faces that look like someone already named, or people named in the notes. Nothing is named until you say so.</p>
            <ProposalList proposals={proposals} />
          </section>
        )}

        <section className="space-y-3">
          <h2 className="font-display text-xl font-semibold">Pets</h2>
          {pets.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {pets.map((p) => (
                <Link key={p.id} href={`/people/${p.id}`} className="block rounded-theme border border-border bg-surface p-4 hover:shadow-md transition-shadow">
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-muted">{p.isFlock ? "flock" : p.species?.toLowerCase()}</div>
                  <div className="text-xs text-muted mt-1">{p.photoCount} photo{p.photoCount === 1 ? "" : "s"}</div>
                </Link>
              ))}
            </div>
          )}
          <Card className="p-4">
            <p className="text-sm font-medium mb-2">Add a pet</p>
            <p className="text-xs text-muted mb-3">Pets are tagged by hand from a photo or proposed when your notes mention their name. {petsActive ? "Once a pet has been tagged on a photo where the album spotted an animal, look-alikes of the same kind are proposed as “Probably …?” for you to confirm; a flock record is proposed whenever its kind is seen." : "Automatic spotting is off (it needs the ML sidecar and PET_MATCHING_ENABLED)."}</p>
            <PetForm />
          </Card>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-xl font-semibold">Unnamed faces</h2>
          <p className="text-sm text-muted">
            Each group is the album&apos;s guess that these are one person. Name it, or join it to someone already
            named — one person often turns up as several groups. Relatives look alike, so check the faces first:
            <span className="font-medium"> not them</span> takes one out of the group, and
            <span className="font-medium"> not a face</span> is for a statue or a portrait on the wall. A group of
            dogs can be named as a pet.
          </p>
          {clusters.length === 0 ? (
            <p className="text-sm text-muted">No unnamed faces{gates.active ? "" : " (detection is off)"}. Faces nobody names are deleted after {gates.retentionDays} days.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {clusters.map((c) => (
                <ClusterCard
                  key={c.id}
                  isAdmin={isAdmin}
                  people={people.filter((p) => !p.optedOut).map((p) => ({ id: p.id, name: p.name }))}
                  pets={pets.map((p) => ({ id: p.id, name: p.name }))}
                  cluster={{
                    id: c.id,
                    faceCount: c.faceCount,
                    looksLike: c.looksLike ? { id: c.looksLike.id, name: c.looksLike.name, kind: c.looksLike.kind } : null,
                    faces: c.faces.map((f) => ({ ...f, updatedAt: f.updatedAt.toISOString() })),
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </Container>
    </AppShell>
  );
}

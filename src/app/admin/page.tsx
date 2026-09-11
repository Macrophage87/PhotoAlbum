import Link from "next/link";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getViewer, requireAdmin } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { InviteForm } from "@/components/admin/InviteForm";
import { Badge, Button, Card } from "@/components/ui";
import { removeMember, revokeInvite, setRole } from "./actions";
import { AnnotationAdmin } from "@/components/annotation/AnnotationAdmin";
import { annotationGates } from "@/lib/annotation/eligibility";
import { faceGates } from "@/lib/people/gates";
import { faceCounts, needsDecision } from "@/lib/people/queries";
import { FacesAdmin } from "@/components/people/FacesAdmin";
import { decideIndexing } from "@/app/people/actions";
import { isMinor } from "@/lib/people/consent";

export const metadata = { title: "Admin" };

export default async function AdminPage() {
  const me = await requireAdmin("/admin");
  const viewer = await getViewer();
  const [members, invites] = await Promise.all([
    db.user.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { photos: true, trips: true } } } }),
    db.invite.findMany({ where: { acceptedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, include: { invitedBy: { select: { email: true, name: true } } } }),
  ]);
  const smtp = Boolean(env().SMTP_HOST);
  const fg = await faceGates();
  const [counts, decisions] = await Promise.all([faceCounts(fg.retentionDays), needsDecision()]);
  const [gates, batches, tripOptions, collectionOptions] = await Promise.all([
    annotationGates(),
    db.annotationBatch.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
    db.trip.findMany({ orderBy: { startDate: "desc" }, select: { id: true, title: true } }),
    db.collection.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } }),
  ]);
  const describeScope = (scope: unknown) => {
    const s = scope as { kind: string; tripId?: string; collectionId?: string; from?: string; to?: string };
    if (s.kind === "trip") return `trip ${tripOptions.find((t) => t.id === s.tripId)?.title ?? s.tripId}`;
    if (s.kind === "collection") return `collection ${collectionOptions.find((c) => c.id === s.collectionId)?.title ?? s.collectionId}`;
    if (s.kind === "range") return `${s.from} to ${s.to}`;
    return "everything not yet described";
  };
  const unavailable = await db.photo.findMany({ where: { kind: "EXTERNAL_VIDEO", externalStatus: "UNAVAILABLE" }, orderBy: { externalCheckedAt: "desc" }, select: { id: true, title: true, externalUrl: true, externalCheckedAt: true } });

  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 max-w-4xl space-y-10">
        <section className="space-y-4">
          <div>
            <h1 className="font-display text-3xl font-semibold">Family members</h1>
            <p className="text-muted mt-1">Invite relatives by email. They sign in with a link, no password needed.</p>
            {!smtp && <p className="text-sm mt-2 rounded-theme bg-amber-50 border border-amber-200 text-amber-900 p-3">Email isn&apos;t configured (SMTP_HOST is empty), so invite and sign-in links are printed to the server log instead of being sent.</p>}
          </div>
          <Card className="p-5">
            <InviteForm />
          </Card>
        </section>

        {invites.length > 0 && (
          <section>
            <h2 className="font-display text-xl font-semibold mb-3">Pending invites</h2>
            <Card className="divide-y divide-border">
              {invites.map((i) => (
                <div key={i.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <div>
                    <div className="font-medium">{i.email}</div>
                    <div className="text-muted">
                      {i.role === "ADMIN" ? "Admin" : "Member"} · invited by {i.invitedBy.name ?? i.invitedBy.email} · expires {i.expiresAt.toLocaleDateString("en-US")}
                    </div>
                  </div>
                  <form action={revokeInvite.bind(null, i.id)}>
                    <Button type="submit" variant="secondary" size="sm">Revoke</Button>
                  </form>
                </div>
              ))}
            </Card>
          </section>
        )}

        <section>
          <h2 className="font-display text-xl font-semibold mb-1">AI descriptions</h2>
          <p className="text-sm text-muted mb-3">An AI helper (Anthropic&apos;s Claude) can describe each photo so it can be found by searching. It is off until both the operator flag and your opt-in here are set.</p>
          <AnnotationAdmin
            gates={{ envEnabled: gates.envEnabled, hasKey: gates.hasKey, optedInAt: gates.optedInAt?.toISOString() ?? null, active: gates.active }}
            model={gates.model}
            trips={tripOptions}
            collections={collectionOptions}
            batches={batches.map((b) => ({ id: b.id, status: b.status, requested: b.requested, succeeded: b.succeeded, errored: b.errored, skipped: b.skipped, createdAt: b.createdAt.toISOString(), endedAt: b.endedAt?.toISOString() ?? null, scope: describeScope(b.scope) }))}
          />
        </section>

        <section>
          <h2 className="font-display text-xl font-semibold mb-1">Faces</h2>
          <p className="text-sm text-muted mb-3">Face detection runs on this server through the ML sidecar. It is off until both the operator flag and your opt-in here are set.</p>
          <FacesAdmin gates={{ sidecar: fg.sidecar, envEnabled: fg.envEnabled, optedInAt: fg.optedInAt?.toISOString() ?? null, active: fg.active, retentionDays: fg.retentionDays }} counts={{ ...counts, nextPurge: counts.nextPurge?.toISOString() ?? null }} />
          {decisions.length > 0 && (
            <div className="mt-4 space-y-3">
              <h3 className="font-medium">Needs a decision</h3>
              <p className="text-sm text-muted">Named by a member, or turned 18 recently: decide whether recognition is on. Nothing is matched until you do.</p>
              {decisions.map((p) => (
                <Card key={p.id} className="p-3 text-sm">
                  <form action={decideIndexing.bind(null, p.id)} className="flex flex-wrap items-center gap-3">
                    <Link href={`/people/${p.id}`} className="font-medium text-primary hover:underline">{p.name}</Link>
                    <label className="flex items-center gap-1">Birthday <input type="date" name="birthday" defaultValue={p.birthday ? p.birthday.toISOString().slice(0, 10) : ""} className="h-8 rounded-theme border border-border px-2" /></label>
                    {!p.birthday && <label className="flex items-center gap-1"><input type="checkbox" name="attest" /> adult, has agreed</label>}
                    {isMinor(p) && <label className="flex items-center gap-1"><input type="checkbox" name="parentInstruction" /> a parent asked</label>}
                    <label className="flex items-center gap-1"><input type="checkbox" name="faceIndexing" /> recognise</label>
                    <Button type="submit" size="sm" variant="secondary">Decide</Button>
                  </form>
                </Card>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="font-display text-xl font-semibold mb-3">Embedded videos no longer available</h2>
          <p className="text-sm text-muted mb-3">Checked weekly against YouTube. A video that was deleted or made private shows here; open it to replace the link or delete the item.</p>
          {unavailable.length === 0 ? (
            <p className="text-sm text-muted">None.</p>
          ) : (
            <Card className="divide-y divide-border">
              {unavailable.map((v) => (
                <div key={v.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <div className="min-w-0">
                    <Link href={`/photos/${v.id}`} className="font-medium text-primary hover:underline">{v.title ?? "Untitled video"}</Link>
                    <div className="text-muted truncate">{v.externalUrl} · checked {v.externalCheckedAt?.toLocaleDateString("en-US")}</div>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </section>

        <section>
          <h2 className="font-display text-xl font-semibold mb-3">Members</h2>
          <Card className="divide-y divide-border">
            {members.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div className="min-w-0">
                  <div className="font-medium flex items-center gap-2">
                    {m.name ?? m.email}
                    <Badge tone={m.role === "ADMIN" ? "primary" : "neutral"}>{m.role === "ADMIN" ? "Admin" : "Member"}</Badge>
                    {m.id === me.id && <Badge tone="accent">You</Badge>}
                  </div>
                  <div className="text-muted truncate">
                    {m.email} · {m._count.photos} photo{m._count.photos === 1 ? "" : "s"} · {m._count.trips} trip{m._count.trips === 1 ? "" : "s"}
                  </div>
                </div>
                {m.id !== me.id && (
                  <div className="flex gap-2">
                    <form action={setRole.bind(null, m.id, m.role === "ADMIN" ? "MEMBER" : "ADMIN")}>
                      <Button type="submit" variant="secondary" size="sm">{m.role === "ADMIN" ? "Make member" : "Make admin"}</Button>
                    </form>
                    <form action={removeMember.bind(null, m.id)}>
                      <Button type="submit" variant="danger" size="sm">Remove</Button>
                    </form>
                  </div>
                )}
              </div>
            ))}
          </Card>
        </section>
      </Container>
    </AppShell>
  );
}

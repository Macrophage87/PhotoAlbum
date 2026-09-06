import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getViewer, requireAdmin } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { InviteForm } from "@/components/admin/InviteForm";
import { Badge, Button, Card } from "@/components/ui";
import { removeMember, revokeInvite, setRole } from "./actions";

export const metadata = { title: "Admin" };

export default async function AdminPage() {
  const me = await requireAdmin("/admin");
  const viewer = await getViewer();
  const [members, invites] = await Promise.all([
    db.user.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { photos: true, trips: true } } } }),
    db.invite.findMany({ where: { acceptedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, include: { invitedBy: { select: { email: true, name: true } } } }),
  ]);
  const smtp = Boolean(env().SMTP_HOST);

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

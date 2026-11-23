import { getViewer, requireUser } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { Button, Card, ConfirmSubmitButton, Input, Label } from "@/components/ui";
import { db } from "@/lib/db";
import { disconnectPhone, updateMyName } from "./actions";
import { LargeTextToggle } from "@/components/layout/LargeTextToggle";

export const metadata = { title: "Your account" };

export default async function AccountPage({ searchParams }: PageProps<"/account">) {
  const me = await requireUser("/account");
  const viewer = await getViewer();
  const sp = await searchParams;
  const phones = await db.deviceToken.findMany({ where: { userId: me.id }, orderBy: { createdAt: "desc" }, select: { id: true, name: true, createdAt: true, lastUsedAt: true } });
  const day = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 max-w-xl space-y-6">
        <div>
          <h1 className="font-display text-3xl font-semibold">Your account</h1>
          <p className="text-muted mt-1">Signed in as {me.email}.</p>
        </div>
        {sp.saved && <p role="status" className="text-sm rounded-theme bg-emerald-50 border border-emerald-200 text-emerald-900 p-3">Saved.</p>}
        <Card className="p-5">
          <form action={async (fd) => { "use server"; await updateMyName(fd); const { redirect } = await import("next/navigation"); redirect("/account?saved=1"); }} className="space-y-3">
            <div>
              <Label htmlFor="name">Your name</Label>
              <Input id="name" name="name" defaultValue={me.name ?? ""} placeholder="Grandma Jo" maxLength={80} />
              <p className="text-xs text-muted mt-1">Shown to family members next to what you upload, and in the uploader filters. Left empty, the album uses “{me.email.split("@")[0]}”.</p>
            </div>
            <Button type="submit" size="sm">Save</Button>
          </form>
        </Card>
        <Card className="p-5 space-y-3">
          <div>
            <h2 className="font-display text-xl font-semibold">Easier reading</h2>
            <p className="text-sm text-muted mt-1">Bigger text and darker grey words on every page, on every computer and phone you sign in on. The same switch is at the foot of every page.</p>
          </div>
          <LargeTextToggle on={Boolean(viewer.user?.largeText)} />
        </Card>
        <Card className="p-5 space-y-3">
          <div>
            <h2 className="font-display text-xl font-semibold">Phones with the album&rsquo;s app</h2>
            <p className="text-sm text-muted mt-1">Each phone you sign in on the app is listed here. Sign one out if it is lost or no longer yours; the others carry on.</p>
          </div>
          {phones.length === 0 ? (
            <p className="text-sm text-muted">None yet. Open the Family Album app on your phone and choose Sign in.</p>
          ) : (
            <ul className="divide-y divide-border">
              {phones.map((phone) => (
                <li key={phone.id} className="py-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">{phone.name}</div>
                    <div className="text-xs text-muted">Connected {day.format(phone.createdAt)} · last used {day.format(phone.lastUsedAt)}</div>
                  </div>
                  <form action={disconnectPhone}>
                    <input type="hidden" name="id" value={phone.id} />
                    <ConfirmSubmitButton variant="secondary" size="sm" confirmMessage={`Sign ${phone.name} out of the album?`}>Sign out</ConfirmSubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Container>
    </AppShell>
  );
}

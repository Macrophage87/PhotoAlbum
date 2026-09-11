import { getViewer, requireUser } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { Button, Card, Input, Label } from "@/components/ui";
import { updateMyName } from "./actions";

export const metadata = { title: "Your account" };

export default async function AccountPage({ searchParams }: PageProps<"/account">) {
  const me = await requireUser("/account");
  const viewer = await getViewer();
  const sp = await searchParams;
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
      </Container>
    </AppShell>
  );
}

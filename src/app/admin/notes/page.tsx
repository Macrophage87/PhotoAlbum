import Link from "next/link";
import { db } from "@/lib/db";
import { getViewer, requireAdmin } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { Badge, Button, Card, ConfirmSubmitButton } from "@/components/ui";
import { photoUrl } from "@/lib/photos/urls";
import { formatDateTime } from "@/lib/time/format";
import { serverTimeZone } from "@/lib/visits/record";
import { isPrivateLinkPath, MAILED_PER_DAY } from "@/lib/notes/notes";
import { deleteNote, markNoteRead } from "./actions";

export const metadata = { title: "Notes from visitors" };

const SHOWN = 200;

/** What visitors (and members) have written to the family from the note page, newest first. Admins only. */
export default async function NotesPage() {
  await requireAdmin("/admin/notes");
  const viewer = await getViewer();
  const [notes, total] = await Promise.all([
    db.visitorNote.findMany({
      orderBy: { createdAt: "desc" },
      take: SHOWN,
      select: { id: true, createdAt: true, name: true, email: true, message: true, pageUrl: true, readAt: true, unmailed: true, photo: { select: { id: true, imageVersion: true, kind: true } } },
    }),
    db.visitorNote.count(),
  ]);
  const unmailed = notes.filter((n) => n.unmailed).length;
  const zone = serverTimeZone();

  return (
    <AppShell viewer={viewer}>
      <Container className="py-8 max-w-4xl space-y-6">
        <div>
          <p className="text-sm text-muted"><Link href="/admin" className="text-primary underline underline-offset-2">Admin</Link> / Notes</p>
          <h1 className="font-display text-3xl font-semibold mt-1">Notes from visitors</h1>
          <p className="text-muted mt-2 max-w-2xl">
            What people have sent from &ldquo;Send the family a note&rdquo;. Only admins see these, and each is kept for a year. {total > SHOWN ? `The newest ${SHOWN} of ${total} are shown.` : ""}
          </p>
        </div>
        {unmailed > 0 && (
          <p className="rounded-theme border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="notes-unmailed">
            {unmailed === 1 ? "1 note" : `${unmailed} notes`} arrived after {MAILED_PER_DAY} others in a single day, so no email went out about {unmailed === 1 ? "it" : "them"}. {unmailed === 1 ? "It is" : "They are"} marked &ldquo;Not emailed&rdquo; below.
          </p>
        )}
        {notes.length === 0 ? (
          <p className="text-muted">No notes yet.</p>
        ) : (
          <Card className="divide-y divide-border">
            {notes.map((n) => (
              <article key={n.id} className="p-4 space-y-2 text-sm" data-testid="visitor-note">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{n.name}</span>
                  {n.email && <a href={`mailto:${n.email}`} className="text-primary underline underline-offset-2">{n.email}</a>}
                  <time dateTime={n.createdAt.toISOString()} className="text-muted">{formatDateTime(n.createdAt, zone)}</time>
                  {!n.readAt && <Badge tone="primary">New</Badge>}
                  {n.unmailed && <Badge tone="warning">Not emailed</Badge>}
                </div>
                <div className="flex gap-3">
                  {n.photo && (
                    <Link href={`/photos/${n.photo.id}`} className="shrink-0" title="Open the photo">
                      {n.photo.kind === "EXTERNAL_VIDEO" ? (
                        <span className="text-primary underline underline-offset-2">About this video</span>
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={photoUrl(n.photo, "thumb")} alt="The photo this note is about" className="h-20 w-20 rounded-theme object-cover" />
                      )}
                    </Link>
                  )}
                  <p className="whitespace-pre-line break-words min-w-0">{n.message}</p>
                </div>
                {n.pageUrl && (
                  <p className="text-muted">
                    Sent from {isPrivateLinkPath(n.pageUrl) ? "a page opened with a private link" : <Link href={n.pageUrl} className="underline underline-offset-2">{n.pageUrl}</Link>}
                  </p>
                )}
                <div className="flex gap-2">
                  {!n.readAt && (
                    <form action={markNoteRead.bind(null, n.id)}>
                      <Button type="submit" variant="secondary" size="sm">Mark read</Button>
                    </form>
                  )}
                  <form action={deleteNote.bind(null, n.id)}>
                    <ConfirmSubmitButton variant="danger" size="sm" confirmMessage="Delete this note for good?">Delete</ConfirmSubmitButton>
                  </form>
                </div>
              </article>
            ))}
          </Card>
        )}
      </Container>
    </AppShell>
  );
}
